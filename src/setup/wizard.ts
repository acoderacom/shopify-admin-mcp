import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import * as p from "@clack/prompts";
import { TOOLSETS, isValidStore, normalizeStore, type Toolset } from "../utils/cli.js";
import {
  CONFIG_FILE,
  type AdvancedAnswers,
  type AuthAnswers,
  type ExistingSetup,
  type SaveResult,
  type SetupAnswers,
} from "./mcp-config.js";
import type { NodeCheck } from "./node-version.js";
import type { VerifyResult } from "./verify.js";

export type SetupOutcome = "saved" | "cancelled" | "failed";

export interface WizardOptions {
  cwd: string;
  existing: ExistingSetup;
  /** The running Node.js version, e.g. v24.15.0. */
  nodeVersion: string;
  adminNode: NodeCheck;
  checkDevMcpNode: () => Promise<NodeCheck>;
  verify: (store: string, auth: AuthAnswers) => Promise<VerifyResult>;
  save: (answers: SetupAnswers) => Promise<SaveResult>;
  /** Streams the prompts use instead of the terminal, for tests. */
  input?: Readable;
  output?: Writable;
}

// The folder the "create an uploads folder" option points at
const UPLOADS_FOLDER = "uploads";

const AUTH_LABELS: Record<AuthAnswers["mode"], string> = {
  "access-token": "Access token",
  "client-credentials": "Client ID and secret",
};

class Cancelled extends Error {}

function resolveFolder(cwd: string, input: string): string {
  const expanded = input === "~" || input.startsWith("~/") ? path.join(homedir(), input.slice(1)) : input;
  return path.resolve(cwd, expanded);
}

function pathKind(target: string): "folder" | "file" | "missing" {
  try {
    return statSync(target).isDirectory() ? "folder" : "file";
  } catch {
    return "missing";
  }
}

function describeNode(check: NodeCheck, nodeVersion: string): string {
  const shortfall = check.ok ? "" : `, but this is ${nodeVersion}`;
  const note = check.note ? ` (${check.note})` : "";
  return `${check.label} needs Node.js ${check.range}${shortfall}${note}`;
}

function describeAdvanced(advanced: AdvancedAnswers): string {
  const parts: string[] = [];
  if (advanced.readOnly) parts.push("read-only");
  if (advanced.allowLiveThemeWrites) parts.push("live theme writes allowed");
  if (advanced.uploadDir) parts.push(`uploads from ${advanced.uploadDir}`);
  if (advanced.toolsets) parts.push(`toolsets: ${advanced.toolsets.join(", ")}`);
  if (advanced.disableRawGraphql) parts.push("raw GraphQL off");
  return parts.length ? parts.join("; ") : "defaults";
}

/** Asks the setup questions, then saves .mcp.json when confirmed. */
export async function runWizard(options: WizardOptions): Promise<SetupOutcome> {
  const { cwd, existing, nodeVersion, adminNode, verify, save } = options;
  const io = { input: options.input, output: options.output };
  const file = path.join(cwd, CONFIG_FILE);

  // Prompts resolve to a cancel symbol on Ctrl+C or Escape; this ends the wizard instead
  const ask = async <T>(answer: Promise<T>): Promise<Exclude<T, symbol>> => {
    const value = await answer;
    if (p.isCancel(value)) throw new Cancelled();
    return value as Exclude<T, symbol>;
  };

  const askStore = async (current: string) =>
    normalizeStore(
      await ask(
        p.text({
          ...io,
          message: "Store domain",
          placeholder: "mystore.myshopify.com",
          initialValue: current,
          validate: (value) =>
            value?.trim() && isValidStore(normalizeStore(value))
              ? undefined
              : "Use your store's myshopify.com domain, e.g. mystore.myshopify.com",
        })
      )
    );

  // Enter on an empty secret keeps the one already known
  const askSecret = async (label: string, current: string) => {
    const value = await ask(
      p.password({
        ...io,
        message: current ? `${label} (press Enter to keep the current one)` : label,
        validate: (input) => (input?.trim() || current ? undefined : `Enter the ${label.toLowerCase()}`),
      })
    );
    return value.trim() || current;
  };

  const askAuth = async (current: AuthAnswers | undefined): Promise<AuthAnswers> => {
    const mode = await ask(
      p.select<AuthAnswers["mode"]>({
        ...io,
        message: "How does the app authenticate?",
        initialValue: current?.mode ?? existing.authMode ?? "access-token",
        options: [
          { value: "access-token", label: AUTH_LABELS["access-token"], hint: "legacy custom app, shpat_…" },
          { value: "client-credentials", label: AUTH_LABELS["client-credentials"], hint: "Dev Dashboard app" },
        ],
      })
    );
    if (mode === "access-token") {
      const known = current?.mode === "access-token" ? current.accessToken : (existing.accessToken ?? "");
      return { mode, accessToken: await askSecret("Admin API access token", known) };
    }
    const clientId = await ask(
      p.text({
        ...io,
        message: "Client ID",
        initialValue: current?.mode === "client-credentials" ? current.clientId : (existing.clientId ?? ""),
        validate: (value) => (value?.trim() ? undefined : "Enter the client ID"),
      })
    );
    const known = current?.mode === "client-credentials" ? current.clientSecret : (existing.clientSecret ?? "");
    return { mode, clientId: clientId.trim(), clientSecret: await askSecret("Client secret", known) };
  };

  const askUploadDir = async (current: string | undefined): Promise<string | undefined> => {
    const uploads = resolveFolder(cwd, UPLOADS_FOLDER);
    const choices: Array<{ value: string; label: string; hint?: string }> = [];
    if (current) choices.push({ value: "keep", label: `Keep ${current}`, hint: "current" });
    if (current !== uploads) {
      choices.push(
        pathKind(uploads) === "folder"
          ? { value: "uploads", label: `Use ${uploads}` }
          : { value: "uploads", label: "Create an uploads folder here", hint: `${uploads}, created when you save` }
      );
    }
    choices.push({ value: "custom", label: "Choose another folder" }, { value: "off", label: "Keep local uploads off" });

    const choice = await ask(p.select({ ...io, message: "Local file uploads", options: choices }));
    if (choice === "keep") return current;
    if (choice === "uploads") return uploads;
    if (choice === "off") return undefined;

    let suggestion = current ?? "";
    for (;;) {
      const entered = await ask(
        p.text({
          ...io,
          message: "Folder the assistant may upload local files from (relative paths start here)",
          placeholder: "e.g. ./uploads or ~/shopify-uploads",
          initialValue: suggestion,
          validate: (value) => {
            if (!value?.trim()) return "Enter a folder";
            if (pathKind(resolveFolder(cwd, value.trim())) === "file") return "That's a file, not a folder";
            return undefined;
          },
        })
      );
      const folder = resolveFolder(cwd, entered.trim());
      if (pathKind(folder) === "folder") return folder;
      const create = await ask(
        p.confirm({ ...io, message: `${folder} doesn't exist yet. Create it when saving?`, initialValue: true })
      );
      if (create) return folder;
      suggestion = entered;
    }
  };

  const askAdvanced = async (draft: AdvancedAnswers): Promise<AdvancedAnswers> => {
    const readOnly = await ask(
      p.confirm({ ...io, message: "Read-only mode? Only tools that read store data are available.", initialValue: draft.readOnly })
    );
    // Write tools are hidden in read-only mode, so their settings don't apply
    let allowLiveThemeWrites = false;
    let uploadDir = draft.uploadDir;
    if (!readOnly) {
      allowLiveThemeWrites = await ask(
        p.confirm({
          ...io,
          message: "Allow edits to the live (published) theme? Otherwise the assistant edits a copy.",
          initialValue: draft.allowLiveThemeWrites,
        })
      );
      uploadDir = await askUploadDir(draft.uploadDir);
    }
    const picked = await ask(
      p.multiselect<Toolset>({
        ...io,
        message: "Toolsets to register",
        options: TOOLSETS.map((name) => ({ value: name, label: name })),
        initialValues: draft.toolsets ?? [...TOOLSETS],
        maxItems: TOOLSETS.length,
        required: true,
      })
    );
    const toolsets = TOOLSETS.filter((name) => picked.includes(name));
    const disableRawGraphql = await ask(
      p.confirm({
        ...io,
        message: "Turn off raw GraphQL (shopify_graphql)? Then only the selected toolsets can reach the store.",
        initialValue: draft.disableRawGraphql,
      })
    );
    return {
      readOnly,
      allowLiveThemeWrites,
      uploadDir,
      toolsets: toolsets.length === TOOLSETS.length ? undefined : toolsets,
      disableRawGraphql,
    };
  };

  try {
    p.intro("Shopify Admin MCP setup", io);
    p.log.info(
      `${existing.hasFile ? "Updating" : "Creating"} ${file}${existing.hasServer ? "; current values are filled in" : ""}`,
      io
    );

    const checking = p.spinner(io);
    checking.start("Checking Node.js requirements");
    const devMcpNode = await options.checkDevMcpNode();
    checking.stop(`Node.js ${nodeVersion}`);
    for (const check of [adminNode, devMcpNode]) {
      (check.ok ? p.log.success : p.log.warn)(describeNode(check, nodeVersion), io);
    }

    let store = await askStore(existing.store ?? "");
    let auth = await askAuth(undefined);

    if (!devMcpNode.ok) {
      p.log.warn(`The Shopify Dev MCP won't start on ${nodeVersion} until you upgrade Node.js.`, io);
    }
    const includeDevMcp = await ask(
      p.confirm({
        ...io,
        message: "Also add the Shopify Dev MCP server? (Shopify docs search and GraphQL validation)",
        // An entry that's already there stays the default; the editor may run servers with another Node.js
        initialValue: existing.hasDevMcp || (!existing.hasFile && devMcpNode.ok),
      })
    );

    const advanced = (await ask(
      p.confirm({
        ...io,
        message: "Configure advanced settings? (read-only, live theme writes, upload folder, toolsets, raw GraphQL)",
        initialValue: false,
      })
    ))
      ? await askAdvanced(existing.advanced)
      : undefined;

    for (;;) {
      const verifying = p.spinner(io);
      verifying.start(`Checking the credentials with ${store}`);
      const check = await verify(store, auth);
      if (check.ok) {
        verifying.stop(`Connected to ${check.shopName}`);
        break;
      }
      verifying.error(`Couldn't connect: ${check.message}`);
      const next = await ask(
        p.select({
          ...io,
          message: "What next?",
          options: [
            { value: "retry", label: "Re-enter the store and credentials" },
            { value: "save", label: "Save anyway" },
            { value: "cancel", label: "Cancel" },
          ],
        })
      );
      if (next === "save") break;
      if (next === "cancel") throw new Cancelled();
      store = await askStore(store);
      auth = await askAuth(auth);
    }

    const devMcpChange = includeDevMcp
      ? existing.hasDevMcp ? "kept" : "added"
      : existing.hasDevMcp ? "removed" : "not included";
    p.note(
      [
        `File: ${file} (${existing.hasFile ? "update" : "new"})`,
        `Server: ${existing.serverName}`,
        `Store: ${store}`,
        `Authentication: ${AUTH_LABELS[auth.mode]}`,
        `Shopify Dev MCP: ${devMcpChange}`,
        `Advanced: ${advanced ? describeAdvanced(advanced) : existing.hasServer ? "unchanged" : "defaults"}`,
      ].join("\n"),
      "Summary",
      io
    );
    p.log.message(
      `The ${auth.mode === "access-token" ? "token" : "client secret"} is saved in plain text, readable only by you, and ${CONFIG_FILE} is added to .gitignore when this folder is a git repo.`,
      io
    );
    if (!(await ask(p.confirm({ ...io, message: `Save ${CONFIG_FILE}?`, initialValue: true })))) {
      throw new Cancelled();
    }

    const saving = p.spinner(io);
    saving.start(`Saving ${CONFIG_FILE}`);
    let result: SaveResult;
    try {
      result = await save({ store, auth, includeDevMcp, advanced });
    } catch (err) {
      saving.error(`Couldn't save ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
    saving.stop(`Saved ${result.path}`);

    if (result.createdUploadDir) p.log.info(`Created the upload folder ${result.createdUploadDir}`, io);
    if (result.gitignore === "added") p.log.info(`Added ${CONFIG_FILE} to .gitignore, so the credentials stay out of git.`, io);
    if (result.gitignore === "already-ignored") p.log.info(`${CONFIG_FILE} is already ignored by git.`, io);
    if (result.gitignore === "git-unavailable") {
      p.log.warn(`Couldn't run git to check .gitignore. Make sure ${CONFIG_FILE} isn't committed.`, io);
    }
    if (result.tracked) {
      p.log.warn(
        `${CONFIG_FILE} is already committed. Run \`git rm --cached ${CONFIG_FILE}\` and commit, so the credentials aren't pushed.`,
        io
      );
    }
    p.outro("Restart Claude Code in this folder (or run /mcp) to connect.", io);
    return "saved";
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    p.cancel(`Cancelled. ${CONFIG_FILE} wasn't changed.`, io);
    return "cancelled";
  }
}
