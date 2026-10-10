import path from "node:path";

export const TOOLSETS = [
  "products",
  "collections",
  "publishing",
  "metafields",
  "metaobjects",
  "customers",
  "orders",
  "inventory",
  "discounts",
  "files",
  "themes",
  "markets",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export interface Config {
  store: string;
  apiVersion: string;
  readOnly: boolean;
  /** Toolsets to register; undefined registers all of them. */
  toolsets?: Toolset[];
  /** Directory that local file uploads are confined to; undefined disables local uploads. */
  uploadDir?: string;
  allowLiveThemeWrites: boolean;
  /** Leaves out shopify_graphql so the selected toolsets are the only way to reach the store. */
  disableRawGraphql: boolean;
  auth:
    | { mode: "access-token"; accessToken: string }
    | { mode: "client-credentials"; clientId: string; clientSecret: string };
}

export const DEFAULT_API_VERSION = "2026-10";

// Restricting the host to *.myshopify.com keeps credentials from being sent to any other domain
const STORE_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION_PATTERN = /^(\d{4}-(01|04|07|10)|unstable)$/;

// A whole-value variable reference such as ${SHOPIFY_CLIENT_ID}, ${VAR:-default}, or $VAR
const UNEXPANDED_VARIABLE = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;

// MCP clients that don't expand variables pass ${VAR} through literally, and unset
// variables often arrive as empty strings. Treating both as "not provided" lets one
// config carry both auth methods and use whichever is filled in.
export function provided(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || UNEXPANDED_VARIABLE.test(trimmed)) return undefined;
  return trimmed;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return provided(args[idx + 1]);
}

function getEnv(name: string): string | undefined {
  return provided(process.env[name]);
}

function getFlag(args: string[], flag: string, envVar: string): boolean {
  return args.includes(flag) || ["1", "true"].includes(getEnv(envVar)?.toLowerCase() ?? "");
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export function normalizeStore(store: string): string {
  const host = store
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return host.endsWith(".myshopify.com") ? host : `${host}.myshopify.com`;
}

/** Whether a normalized store host is one credentials may be sent to. */
export function isValidStore(host: string): boolean {
  return STORE_PATTERN.test(host);
}

function parseToolsets(value: string | undefined): Toolset[] | undefined {
  if (!value) return undefined;
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !TOOLSETS.includes(name as Toolset));
  if (unknown.length > 0) {
    fail(`Unknown toolset(s): ${unknown.join(", ")}. Available: ${TOOLSETS.join(", ")}`);
  }
  return names as Toolset[];
}

export function parseArgs(argv: string[]): Config {
  const store = getArg(argv, "--store") ?? getEnv("SHOPIFY_STORE");
  const accessTokenArg = getArg(argv, "--access-token");
  const accessToken = accessTokenArg ?? getEnv("SHOPIFY_ACCESS_TOKEN");
  const clientId =
    getArg(argv, "--client-id") ??
    getArg(argv, "--clientId") ??
    getEnv("SHOPIFY_CLIENT_ID");
  const clientSecretArg =
    getArg(argv, "--client-secret") ?? getArg(argv, "--clientSecret");
  const clientSecret = clientSecretArg ?? getEnv("SHOPIFY_CLIENT_SECRET");
  const apiVersion =
    getArg(argv, "--api-version") ??
    getEnv("SHOPIFY_API_VERSION") ??
    DEFAULT_API_VERSION;
  const uploadDir = getArg(argv, "--upload-dir") ?? getEnv("SHOPIFY_UPLOAD_DIR");

  if (!store) fail("--store is required (e.g. --store mystore.myshopify.com)");

  const normalizedStore = normalizeStore(store);
  if (!isValidStore(normalizedStore)) {
    fail(
      `Invalid store "${store}". Expected a *.myshopify.com domain (e.g. mystore.myshopify.com)`
    );
  }

  if (!API_VERSION_PATTERN.test(apiVersion)) {
    fail(
      `Invalid API version "${apiVersion}". Expected YYYY-MM (e.g. ${DEFAULT_API_VERSION})`
    );
  }

  if (accessTokenArg || clientSecretArg) {
    console.error(
      "Warning: secrets passed as command-line flags are visible in process listings. Prefer the SHOPIFY_ACCESS_TOKEN / SHOPIFY_CLIENT_SECRET environment variables."
    );
  }

  const base = {
    store: normalizedStore,
    apiVersion,
    readOnly: getFlag(argv, "--read-only", "SHOPIFY_READ_ONLY"),
    toolsets: parseToolsets(getArg(argv, "--toolsets") ?? getEnv("SHOPIFY_TOOLSETS")),
    uploadDir: uploadDir ? path.resolve(uploadDir) : undefined,
    allowLiveThemeWrites: getFlag(
      argv,
      "--allow-live-theme-writes",
      "SHOPIFY_ALLOW_LIVE_THEME_WRITES"
    ),
    disableRawGraphql: getFlag(argv, "--disable-raw-graphql", "SHOPIFY_DISABLE_RAW_GRAPHQL"),
  };

  if (accessToken) {
    return { ...base, auth: { mode: "access-token", accessToken } };
  }

  if (clientId && clientSecret) {
    return {
      ...base,
      auth: { mode: "client-credentials", clientId, clientSecret },
    };
  }

  if (clientId || clientSecret) {
    fail(
      `Client credentials are incomplete: ${clientId ? "SHOPIFY_CLIENT_SECRET (--client-secret)" : "SHOPIFY_CLIENT_ID (--client-id)"} is missing`
    );
  }

  fail("Provide either --access-token or both --client-id and --client-secret");
}
