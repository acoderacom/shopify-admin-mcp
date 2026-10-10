#!/usr/bin/env node

// Both commands load on demand: setup checks the Node.js version before importing anything
// that needs a newer one, and the server never loads the wizard's prompts
try {
  if (process.argv[2] === "setup") {
    const { runSetup } = await import("./setup/index.js");
    process.exitCode = await runSetup(process.cwd());
  } else {
    const { main } = await import("./main.js");
    await main();
  }
} catch (err) {
  console.error("Fatal error:", err);
  process.exit(1);
}
