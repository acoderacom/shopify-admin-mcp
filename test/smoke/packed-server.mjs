// Packs the package, installs it into a new project and starts it through npm's command shim,
// the way `npx` runs it, against a faked store. Fails unless it answers with this version and its theme tools.
// Run after `npm run build`: node test/smoke/packed-server.mjs
import { execFileSync, execSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "../..");
const { version } = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
const windows = process.platform === "win32";
// npm is npm.cmd on Windows, which Node only starts through a shell, so run it as one command line.
// "npm" itself stays unquoted: cmd.exe gives a quoted bare batch name the wrong folder for its own files.
const npm = (args, cwd) => execSync(`npm ${args.map((a) => `"${a}"`).join(" ")}`, { cwd, encoding: "utf8" });

const dir = await mkdtemp(path.join(tmpdir(), "shopify-mcp-smoke-"));
let child;
try {
  // npm 11 and older print an array, npm 12 an object keyed by package name
  const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", dir], repo));
  const { filename } = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  await writeFile(path.join(dir, "package.json"), "{}\n");
  npm(["install", "--no-audit", "--no-fund", path.join(dir, filename)], dir);
  await mkdir(path.join(dir, "theme"));
  await mkdir(path.join(dir, "uploads"));
  const stub = path.join(dir, "stub.mjs");
  await writeFile(
    stub,
    `globalThis.fetch = async () => new Response(JSON.stringify({ data: { shop: { name: "Demo Store" } } }), {
  headers: { "content-type": "application/json", "x-shopify-api-version": "2026-10" },
});\n`
  );

  const bin = path.join(dir, "node_modules", ".bin", windows ? "shopify-admin-mcp.cmd" : "shopify-admin-mcp");
  child = spawn(windows ? `"${bin}"` : bin, [], {
    cwd: dir,
    shell: windows,
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`,
      SHOPIFY_STORE: "demo.myshopify.com",
      SHOPIFY_ACCESS_TOKEN: "shpat_test",
      SHOPIFY_THEME_DIR: path.join(dir, "theme"),
      SHOPIFY_UPLOAD_DIR: path.join(dir, "uploads"),
    },
  });

  const replies = new Map();
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      const msg = JSON.parse(line);
      replies.get(msg.id)?.(msg);
    }
  });
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No reply to ${method} within 30s`)), 30_000);
      replies.set(id, (msg) => (clearTimeout(timer), resolve(msg)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const init = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const reported = init.result?.serverInfo?.version;
  if (reported !== version) throw new Error(`Server reported version ${reported}, expected ${version}`);

  const tools = (await request(2, "tools/list", {})).result.tools.map((t) => t.name);
  for (const name of ["shopify_theme_files_pull", "shopify_theme_files_upsert", "shopify_file_upload"]) {
    if (!tools.includes(name)) throw new Error(`Tool ${name} is missing`);
  }
  console.log(`Packed server ${reported} started on ${process.platform} with ${tools.length} tools`);
} finally {
  if (child?.pid) {
    // On Windows the shim runs under a shell, so end the whole process tree
    if (windows) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    } else child.kill();
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
