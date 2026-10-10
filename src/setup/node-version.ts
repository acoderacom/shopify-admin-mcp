import { createRequire } from "node:module";
import semver from "semver";

const DEV_MCP_PACKAGE = "@shopify/dev-mcp";
// @shopify/dev-mcp declares no Node.js requirement of its own (its README says 18+), but it
// depends on @shopify/cli, which does. This is that requirement, for when npm can't be reached.
const DEV_MCP_FALLBACK = ">=22.12.0";

export interface NodeCheck {
  label: string;
  /** The Node.js versions the server supports, as an npm engines range. */
  range: string;
  ok: boolean;
  note?: string;
}

/** Checks this package's own engines requirement; it needs no network. */
export function checkAdminNode(version = process.versions.node): NodeCheck {
  // Resolves to the package root from both src/ (tests) and dist/ (published build)
  const { engines } = createRequire(import.meta.url)("../../package.json") as { engines: { node: string } };
  return { label: "shopify-admin-mcp", range: engines.node, ok: semver.satisfies(version, engines.node) };
}

interface Manifest {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
}

async function latestManifest(pkg: string): Promise<Manifest> {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  return (await res.json()) as Manifest;
}

// The range with the highest minimum, which is the one a reader needs to see
function strictest(ranges: string[]): string {
  const minimum = (range: string) => semver.minVersion(range)?.version ?? "0.0.0";
  return ranges.reduce((a, b) => (semver.gt(minimum(b), minimum(a)) ? b : a));
}

/**
 * Checks the Node.js requirement of the latest @shopify/dev-mcp, which .mcp.json runs with
 * @latest, including the @shopify/cli dependency that sets the real minimum today.
 */
export async function checkDevMcpNode(version = process.versions.node): Promise<NodeCheck> {
  const label = "Shopify Dev MCP";
  try {
    const devMcp = await latestManifest(DEV_MCP_PACKAGE);
    const ranges = [devMcp.engines?.node];
    if (devMcp.dependencies?.["@shopify/cli"]) {
      ranges.push((await latestManifest("@shopify/cli")).engines?.node);
    }
    const known = ranges.filter((range): range is string => !!range && semver.validRange(range) !== null);
    if (known.length === 0) {
      return { label, range: DEV_MCP_FALLBACK, ok: semver.satisfies(version, DEV_MCP_FALLBACK), note: "last known requirement" };
    }
    return { label, range: strictest(known), ok: known.every((range) => semver.satisfies(version, range)) };
  } catch {
    return {
      label,
      range: DEV_MCP_FALLBACK,
      ok: semver.satisfies(version, DEV_MCP_FALLBACK),
      note: "couldn't reach npm, so this is the last known requirement",
    };
  }
}
