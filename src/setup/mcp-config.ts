import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { TOOLSETS, provided, type Toolset } from "../utils/cli.js";

const run = promisify(execFile);

export const CONFIG_FILE = ".mcp.json";
export const PACKAGE_NAME = "@acodera/shopify-admin-mcp";
export const DEFAULT_SERVER_NAME = "shopify-admin-mcp";
export const DEV_MCP_NAME = "shopify-dev-mcp";
const DEV_MCP_PACKAGE = "@shopify/dev-mcp";

export type AuthAnswers =
  | { mode: "access-token"; accessToken: string }
  | { mode: "client-credentials"; clientId: string; clientSecret: string };

export interface AdvancedAnswers {
  readOnly: boolean;
  allowLiveThemeWrites: boolean;
  /** Absolute path; undefined leaves local uploads off. */
  uploadDir?: string;
  /** Undefined registers every toolset. */
  toolsets?: Toolset[];
  disableRawGraphql: boolean;
}

export interface SetupAnswers {
  store: string;
  auth: AuthAnswers;
  includeDevMcp: boolean;
  /** Undefined keeps the advanced settings already in the file. */
  advanced?: AdvancedAnswers;
}

interface ServerEntry {
  command?: string;
  args?: unknown[];
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpConfig {
  mcpServers?: Record<string, ServerEntry>;
  [key: string]: unknown;
}

/** What the wizard knows from an existing .mcp.json, used to prefill its questions. */
export interface ExistingSetup {
  hasFile: boolean;
  serverName: string;
  hasServer: boolean;
  hasDevMcp: boolean;
  store?: string;
  authMode?: AuthAnswers["mode"];
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  advanced: AdvancedAnswers;
}

export type GitignoreResult =
  | "added"
  | "already-ignored"
  | "not-a-repo"
  | "git-unavailable";

export interface SaveResult {
  path: string;
  gitignore: GitignoreResult;
  /** The file is committed, so ignoring it doesn't stop its secrets being pushed. */
  tracked: boolean;
  /** The upload folder, when saving had to create it. */
  createdUploadDir?: string;
}

// Flags the wizard configures through env instead; a flag would override the env value
const VALUE_FLAGS = [
  "--store",
  "--access-token",
  "--client-id",
  "--clientId",
  "--client-secret",
  "--clientSecret",
  "--upload-dir",
  "--toolsets",
];
const BOOLEAN_FLAGS = ["--read-only", "--allow-live-theme-writes", "--disable-raw-graphql"];

const ENV = {
  store: "SHOPIFY_STORE",
  accessToken: "SHOPIFY_ACCESS_TOKEN",
  clientId: "SHOPIFY_CLIENT_ID",
  clientSecret: "SHOPIFY_CLIENT_SECRET",
  readOnly: "SHOPIFY_READ_ONLY",
  allowLiveThemeWrites: "SHOPIFY_ALLOW_LIVE_THEME_WRITES",
  uploadDir: "SHOPIFY_UPLOAD_DIR",
  toolsets: "SHOPIFY_TOOLSETS",
  disableRawGraphql: "SHOPIFY_DISABLE_RAW_GRAPHQL",
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads .mcp.json from `dir`; undefined when it doesn't exist yet. */
export async function readMcpConfig(dir: string): Promise<McpConfig | undefined> {
  const file = path.join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`${file} isn't valid JSON. Fix or move it, then run setup again.`);
  }
  if (!isObject(config) || (config.mcpServers !== undefined && !isObject(config.mcpServers))) {
    throw new Error(`${file} doesn't look like an MCP config (expected an object with "mcpServers").`);
  }
  return config as McpConfig;
}

const argsOf = (entry: ServerEntry | undefined): string[] =>
  Array.isArray(entry?.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];

const usesPackage = (entry: ServerEntry, pkg: string) =>
  argsOf(entry).some((arg) => arg === pkg || arg.startsWith(`${pkg}@`));

// The entry to edit: the one named shopify-admin-mcp, else the first that runs the package
function findServer(servers: Record<string, ServerEntry>, name: string, pkg: string): string | undefined {
  if (servers[name]) return name;
  return Object.keys(servers).find((key) => usesPackage(servers[key]!, pkg));
}

// Reads an option the way the server does: a flag in args wins over the env value
function option(entry: ServerEntry | undefined, flags: string[], envKey: string): string | undefined {
  const args = argsOf(entry);
  for (const flag of flags) {
    const index = args.indexOf(flag);
    const value = index === -1 ? undefined : provided(args[index + 1]);
    if (value) return value;
  }
  const env = entry?.env?.[envKey];
  return typeof env === "string" ? provided(env) : undefined;
}

function flag(entry: ServerEntry | undefined, name: string, envKey: string): boolean {
  if (argsOf(entry).includes(name)) return true;
  const env = entry?.env?.[envKey];
  return typeof env === "string" && ["1", "true"].includes(env.trim().toLowerCase());
}

/** Summarizes an existing config so its values can prefill the wizard. */
export function describeExisting(config: McpConfig | undefined): ExistingSetup {
  const servers = config?.mcpServers ?? {};
  const serverName = findServer(servers, DEFAULT_SERVER_NAME, PACKAGE_NAME) ?? DEFAULT_SERVER_NAME;
  const entry = servers[serverName];

  const accessToken = option(entry, ["--access-token"], ENV.accessToken);
  const clientId = option(entry, ["--client-id", "--clientId"], ENV.clientId);
  const clientSecret = option(entry, ["--client-secret", "--clientSecret"], ENV.clientSecret);
  const uploadDir = option(entry, ["--upload-dir"], ENV.uploadDir);
  const toolsets = option(entry, ["--toolsets"], ENV.toolsets)
    ?.split(",")
    .map((name) => name.trim())
    .filter((name): name is Toolset => TOOLSETS.includes(name as Toolset));

  return {
    hasFile: config !== undefined,
    serverName,
    hasServer: entry !== undefined,
    hasDevMcp: findServer(servers, DEV_MCP_NAME, DEV_MCP_PACKAGE) !== undefined,
    store: option(entry, ["--store"], ENV.store),
    authMode: accessToken ? "access-token" : clientId || clientSecret ? "client-credentials" : undefined,
    accessToken,
    clientId,
    clientSecret,
    advanced: {
      readOnly: flag(entry, "--read-only", ENV.readOnly),
      allowLiveThemeWrites: flag(entry, "--allow-live-theme-writes", ENV.allowLiveThemeWrites),
      uploadDir,
      toolsets: toolsets?.length ? toolsets : undefined,
      disableRawGraphql: flag(entry, "--disable-raw-graphql", ENV.disableRawGraphql),
    },
  };
}

function withoutManagedFlags(args: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.includes(arg)) {
      i++; // skip the flag's value too
    } else if (!BOOLEAN_FLAGS.includes(arg)) {
      kept.push(arg);
    }
  }
  return kept;
}

function buildEnv(
  previous: Record<string, unknown> | undefined,
  answers: SetupAnswers,
  advanced: AdvancedAnswers
): Record<string, string> {
  const env: Record<string, unknown> = { ...previous };
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete env[key];
    else env[key] = value;
  };
  // Booleans keep an explicit "false" that was already there, and are otherwise left out when off
  const setFlag = (key: string, on: boolean) => set(key, on ? "true" : key in env ? "false" : undefined);

  set(ENV.store, answers.store);
  if (answers.auth.mode === "access-token") {
    set(ENV.accessToken, answers.auth.accessToken);
    set(ENV.clientId, undefined);
    set(ENV.clientSecret, undefined);
  } else {
    set(ENV.accessToken, undefined);
    set(ENV.clientId, answers.auth.clientId);
    set(ENV.clientSecret, answers.auth.clientSecret);
  }
  setFlag(ENV.readOnly, advanced.readOnly);
  setFlag(ENV.allowLiveThemeWrites, advanced.allowLiveThemeWrites);
  set(ENV.uploadDir, advanced.uploadDir);
  set(ENV.toolsets, advanced.toolsets?.join(","));
  setFlag(ENV.disableRawGraphql, advanced.disableRawGraphql);

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, typeof value === "string" ? value : String(value)])
  );
}

/** Returns `config` with the wizard's answers applied, leaving unrelated servers and keys untouched. */
export function applyAnswers(config: McpConfig | undefined, answers: SetupAnswers): McpConfig {
  const existing = describeExisting(config);
  const servers: Record<string, ServerEntry> = { ...config?.mcpServers };
  const previous = servers[existing.serverName];

  servers[existing.serverName] = {
    ...(previous ?? { command: "npx" }),
    args: previous ? withoutManagedFlags(argsOf(previous)) : ["-y", `${PACKAGE_NAME}@latest`],
    env: buildEnv(previous?.env, answers, answers.advanced ?? existing.advanced),
  };

  const devName = findServer(servers, DEV_MCP_NAME, DEV_MCP_PACKAGE);
  if (answers.includeDevMcp && !devName) {
    servers[DEV_MCP_NAME] = {
      type: "stdio",
      command: "npx",
      args: ["-y", `${DEV_MCP_PACKAGE}@latest`],
      env: { POLARIS_UNIFIED: "true", LIQUID: "true" },
    };
  } else if (!answers.includeDevMcp && devName) {
    delete servers[devName];
  }

  return { ...config, mcpServers: servers };
}

/** Writes .mcp.json atomically and readable only by the owner, since it holds credentials. */
export async function writeMcpConfig(dir: string, config: McpConfig): Promise<string> {
  const file = path.join(dir, CONFIG_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  return file;
}

async function git(dir: string, args: string[]): Promise<number> {
  try {
    await run("git", args, { cwd: dir });
    return 0;
  } catch (err) {
    const { code } = err as { code?: number | string };
    if (code === "ENOENT") throw err;
    return typeof code === "number" ? code : 1;
  }
}

/** Adds .mcp.json to the folder's .gitignore when the folder is in a git repo and doesn't ignore it yet. */
export async function ensureGitignored(dir: string): Promise<{ result: GitignoreResult; tracked: boolean }> {
  try {
    if ((await git(dir, ["rev-parse", "--is-inside-work-tree"])) !== 0) {
      return { result: "not-a-repo", tracked: false };
    }
    const tracked = (await git(dir, ["ls-files", "--error-unmatch", CONFIG_FILE])) === 0;
    if ((await git(dir, ["check-ignore", "-q", CONFIG_FILE])) === 0) {
      return { result: "already-ignored", tracked };
    }

    const gitignore = path.join(dir, ".gitignore");
    const current = await readFile(gitignore, "utf8").catch(() => "");
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await appendFile(gitignore, `${separator}${CONFIG_FILE}\n`);
    return { result: "added", tracked };
  } catch {
    return { result: "git-unavailable", tracked: false };
  }
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false
  );
}

/**
 * Applies the answers to the folder's .mcp.json, creates the chosen upload folder if it's
 * missing, and keeps the file out of git.
 */
export async function saveSetup(dir: string, answers: SetupAnswers): Promise<SaveResult> {
  const config = applyAnswers(await readMcpConfig(dir), answers);

  // Only a folder chosen in this run is created; one already in the file is left as it is
  const uploadDir = answers.advanced?.uploadDir;
  const createUploadDir = uploadDir !== undefined && !(await exists(uploadDir));
  if (createUploadDir) await mkdir(uploadDir, { recursive: true });

  const file = await writeMcpConfig(dir, config);
  const { result, tracked } = await ensureGitignored(dir);
  return { path: file, gitignore: result, tracked, createdUploadDir: createUploadDir ? uploadDir : undefined };
}
