export interface Config {
  store: string;
  apiVersion: string;
  readOnly: boolean;
  auth:
    | { mode: "access-token"; accessToken: string }
    | { mode: "client-credentials"; clientId: string; clientSecret: string };
}

export const DEFAULT_API_VERSION = "2026-10";

// Restricting the host to *.myshopify.com keeps credentials from being sent to any other domain
const STORE_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION_PATTERN = /^(\d{4}-(01|04|07|10)|unstable)$/;

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function normalizeStore(store: string): string {
  const host = store
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return host.endsWith(".myshopify.com") ? host : `${host}.myshopify.com`;
}

export function parseArgs(argv: string[]): Config {
  const store = getArg(argv, "--store") ?? process.env.SHOPIFY_STORE;
  const accessTokenArg = getArg(argv, "--access-token");
  const accessToken = accessTokenArg ?? process.env.SHOPIFY_ACCESS_TOKEN;
  const clientId =
    getArg(argv, "--client-id") ??
    getArg(argv, "--clientId") ??
    process.env.SHOPIFY_CLIENT_ID;
  const clientSecretArg =
    getArg(argv, "--client-secret") ?? getArg(argv, "--clientSecret");
  const clientSecret = clientSecretArg ?? process.env.SHOPIFY_CLIENT_SECRET;
  const apiVersion =
    getArg(argv, "--api-version") ??
    process.env.SHOPIFY_API_VERSION ??
    DEFAULT_API_VERSION;
  const readOnly =
    argv.includes("--read-only") ||
    ["1", "true"].includes(process.env.SHOPIFY_READ_ONLY?.toLowerCase() ?? "");

  if (!store) fail("--store is required (e.g. --store mystore.myshopify.com)");

  const normalizedStore = normalizeStore(store);
  if (!STORE_PATTERN.test(normalizedStore)) {
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

  const base = { store: normalizedStore, apiVersion, readOnly };

  if (accessToken) {
    return { ...base, auth: { mode: "access-token", accessToken } };
  }

  if (clientId && clientSecret) {
    return {
      ...base,
      auth: { mode: "client-credentials", clientId, clientSecret },
    };
  }

  fail("Provide either --access-token or both --client-id and --client-secret");
}
