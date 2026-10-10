import { describeExisting, readMcpConfig, saveSetup, type ExistingSetup } from "./mcp-config.js";
import { checkAdminNode, checkDevMcpNode } from "./node-version.js";
import { verifyCredentials } from "./verify.js";

/** Runs the interactive .mcp.json wizard in `cwd` and returns the process exit code. */
export async function runSetup(cwd: string): Promise<number> {
  // Checked before the prompts load, so an old Node.js gets this message rather than a crash
  const adminNode = checkAdminNode();
  if (!adminNode.ok) {
    console.error(
      `shopify-admin-mcp needs Node.js ${adminNode.range}, but this is ${process.version}. Install a newer Node.js from https://nodejs.org and run setup again.`
    );
    return 1;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("setup is interactive, so run it directly in a terminal rather than through a pipe or CI.");
    return 1;
  }

  let existing: ExistingSetup;
  try {
    existing = describeExisting(await readMcpConfig(cwd));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { runWizard } = await import("./wizard.js");
  const outcome = await runWizard({
    cwd,
    existing,
    nodeVersion: process.version,
    adminNode,
    checkDevMcpNode: () => checkDevMcpNode(),
    verify: verifyCredentials,
    save: (answers) => saveSetup(cwd, answers),
  });
  return outcome === "saved" ? 0 : 1;
}
