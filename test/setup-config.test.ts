import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAnswers,
  describeExisting,
  ensureGitignored,
  readMcpConfig,
  saveSetup,
  writeMcpConfig,
  type McpConfig,
  type SetupAnswers,
} from "../src/setup/mcp-config.js";

const answers: SetupAnswers = {
  store: "mystore.myshopify.com",
  auth: { mode: "access-token", accessToken: "shpat_new" },
  includeDevMcp: true,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "shopify-mcp-setup-"));
  // Keep the developer's global git config (and its global excludes) out of the gitignore tests
  const emptyConfig = path.join(dir, "..", `${path.basename(dir)}.gitconfig`);
  await writeFile(emptyConfig, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", emptyConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
  await rm(`${dir}.gitconfig`, { force: true });
});

const writeConfig = (config: unknown) => writeFile(path.join(dir, ".mcp.json"), JSON.stringify(config));
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

describe("readMcpConfig", () => {
  it("returns undefined when there's no .mcp.json", async () => {
    await expect(readMcpConfig(dir)).resolves.toBeUndefined();
  });

  it("refuses invalid JSON instead of overwriting it", async () => {
    await writeFile(path.join(dir, ".mcp.json"), "{ not json");
    await expect(readMcpConfig(dir)).rejects.toThrow("isn't valid JSON");
  });

  it("refuses files that aren't an MCP config", async () => {
    await writeConfig({ mcpServers: [] });
    await expect(readMcpConfig(dir)).rejects.toThrow("doesn't look like an MCP config");
  });
});

describe("describeExisting", () => {
  it("prefills from the env of the shopify-admin-mcp entry, ignoring blanks and placeholders", () => {
    const existing = describeExisting({
      mcpServers: {
        "shopify-admin-mcp": {
          command: "npx",
          args: ["-y", "@acodera/shopify-admin-mcp@latest"],
          env: {
            SHOPIFY_STORE: "mystore.myshopify.com",
            SHOPIFY_ACCESS_TOKEN: "${SHOPIFY_ACCESS_TOKEN}",
            SHOPIFY_CLIENT_ID: "id",
            SHOPIFY_CLIENT_SECRET: "secret",
            SHOPIFY_READ_ONLY: "false",
            SHOPIFY_ALLOW_LIVE_THEME_WRITES: "true",
            SHOPIFY_UPLOAD_DIR: "/tmp/uploads",
            SHOPIFY_TOOLSETS: "products, themes,unknown",
          },
        },
        "shopify-dev-mcp": { command: "npx", args: ["-y", "@shopify/dev-mcp@latest"] },
      },
    });

    expect(existing).toEqual({
      hasFile: true,
      serverName: "shopify-admin-mcp",
      hasServer: true,
      hasDevMcp: true,
      store: "mystore.myshopify.com",
      authMode: "client-credentials",
      accessToken: undefined,
      clientId: "id",
      clientSecret: "secret",
      advanced: {
        readOnly: false,
        allowLiveThemeWrites: true,
        uploadDir: "/tmp/uploads",
        toolsets: ["products", "themes"],
        disableRawGraphql: false,
      },
    });
  });

  it("finds the entry by package when it has another name, and lets flags win over env", () => {
    const existing = describeExisting({
      mcpServers: {
        shopify: {
          command: "npx",
          args: ["-y", "@acodera/shopify-admin-mcp", "--store", "flagstore.myshopify.com", "--read-only"],
          env: { SHOPIFY_STORE: "envstore.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_x" },
        },
      },
    });

    expect(existing).toMatchObject({
      serverName: "shopify",
      store: "flagstore.myshopify.com",
      authMode: "access-token",
      accessToken: "shpat_x",
      hasDevMcp: false,
      advanced: { readOnly: true },
    });
  });

  it("describes a missing file", () => {
    expect(describeExisting(undefined)).toMatchObject({
      hasFile: false,
      hasServer: false,
      serverName: "shopify-admin-mcp",
      authMode: undefined,
    });
  });
});

describe("applyAnswers", () => {
  it("creates both servers in a new config", () => {
    expect(applyAnswers(undefined, answers)).toEqual({
      mcpServers: {
        "shopify-admin-mcp": {
          command: "npx",
          args: ["-y", "@acodera/shopify-admin-mcp@latest"],
          env: { SHOPIFY_STORE: "mystore.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_new" },
        },
        "shopify-dev-mcp": {
          type: "stdio",
          command: "npx",
          args: ["-y", "@shopify/dev-mcp@latest"],
          env: { POLARIS_UNIFIED: "true", LIQUID: "true" },
        },
      },
    });
  });

  it("updates the existing entry and leaves everything else alone", () => {
    const config: McpConfig = {
      $schema: "keep-me",
      mcpServers: {
        other: { command: "other-server" },
        shopify: {
          command: "npx",
          args: ["-y", "@acodera/shopify-admin-mcp@1.1.0", "--store", "old.myshopify.com", "--client-id", "old", "--api-version", "2026-07"],
          env: {
            SHOPIFY_CLIENT_ID: "old",
            SHOPIFY_CLIENT_SECRET: "old",
            SHOPIFY_READ_ONLY: "false",
            SHOPIFY_API_VERSION: "2026-07",
          },
        },
        "shopify-dev-mcp": { command: "npx", args: ["-y", "@shopify/dev-mcp@latest"], env: { LIQUID: "false" } },
      },
    };

    const updated = applyAnswers(config, answers);

    expect(updated.$schema).toBe("keep-me");
    expect(updated.mcpServers!.other).toEqual({ command: "other-server" });
    expect(updated.mcpServers!["shopify-dev-mcp"]).toEqual(config.mcpServers!["shopify-dev-mcp"]);
    expect(updated.mcpServers!.shopify).toEqual({
      command: "npx",
      // Flags the wizard manages are moved to env, so they can't override it; others stay
      args: ["-y", "@acodera/shopify-admin-mcp@1.1.0", "--api-version", "2026-07"],
      env: {
        SHOPIFY_READ_ONLY: "false",
        SHOPIFY_API_VERSION: "2026-07",
        SHOPIFY_STORE: "mystore.myshopify.com",
        SHOPIFY_ACCESS_TOKEN: "shpat_new",
      },
    });
    expect(config.mcpServers!.shopify!.args).toHaveLength(8);
  });

  it("removes the Shopify Dev MCP entry when it isn't wanted", () => {
    const updated = applyAnswers(applyAnswers(undefined, answers), { ...answers, includeDevMcp: false });
    expect(Object.keys(updated.mcpServers!)).toEqual(["shopify-admin-mcp"]);
  });

  it("writes advanced settings, leaving defaults out", () => {
    const updated = applyAnswers(undefined, {
      ...answers,
      auth: { mode: "client-credentials", clientId: "id", clientSecret: "secret" },
      advanced: {
        readOnly: false,
        allowLiveThemeWrites: true,
        uploadDir: "/tmp/uploads",
        toolsets: ["products", "themes"],
        disableRawGraphql: true,
      },
    });

    expect(updated.mcpServers!["shopify-admin-mcp"]!.env).toEqual({
      SHOPIFY_STORE: "mystore.myshopify.com",
      SHOPIFY_CLIENT_ID: "id",
      SHOPIFY_CLIENT_SECRET: "secret",
      SHOPIFY_ALLOW_LIVE_THEME_WRITES: "true",
      SHOPIFY_UPLOAD_DIR: "/tmp/uploads",
      SHOPIFY_TOOLSETS: "products,themes",
      SHOPIFY_DISABLE_RAW_GRAPHQL: "true",
    });
  });

  it("keeps the advanced settings in the file when they weren't asked", () => {
    const config = applyAnswers(undefined, {
      ...answers,
      advanced: { readOnly: true, allowLiveThemeWrites: false, uploadDir: "/tmp/u", disableRawGraphql: false },
    });
    const env = applyAnswers(config, answers).mcpServers!["shopify-admin-mcp"]!.env;
    expect(env).toMatchObject({ SHOPIFY_READ_ONLY: "true", SHOPIFY_UPLOAD_DIR: "/tmp/u" });
  });
});

describe("writeMcpConfig", () => {
  it("writes formatted JSON readable only by the owner, without leaving a temp file", async () => {
    const file = await writeMcpConfig(dir, applyAnswers(undefined, answers));

    expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(applyAnswers(undefined, answers), null, 2)}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([".mcp.json"]);
  });
});

describe("saveSetup", () => {
  it("creates an upload folder chosen in this run", async () => {
    const uploadDir = path.join(dir, "uploads");
    const result = await saveSetup(dir, {
      ...answers,
      advanced: { readOnly: false, allowLiveThemeWrites: false, uploadDir, disableRawGraphql: false },
    });

    expect((await stat(uploadDir)).isDirectory()).toBe(true);
    expect(result).toMatchObject({ createdUploadDir: uploadDir, gitignore: "not-a-repo", tracked: false });
  });

  it("doesn't recreate an upload folder that's only in the file", async () => {
    await writeConfig({
      mcpServers: { "shopify-admin-mcp": { args: ["@acodera/shopify-admin-mcp"], env: { SHOPIFY_UPLOAD_DIR: path.join(dir, "gone") } } },
    });
    const result = await saveSetup(dir, answers);

    expect(result.createdUploadDir).toBeUndefined();
    await expect(stat(path.join(dir, "gone"))).rejects.toThrow();
  });
});

describe("ensureGitignored", () => {
  it("reports folders outside a git repo", async () => {
    await expect(ensureGitignored(dir)).resolves.toEqual({ result: "not-a-repo", tracked: false });
  });

  it("adds .mcp.json to .gitignore once", async () => {
    git("init", "-q");
    await writeFile(path.join(dir, ".gitignore"), "node_modules/");

    await expect(ensureGitignored(dir)).resolves.toEqual({ result: "added", tracked: false });
    await expect(ensureGitignored(dir)).resolves.toEqual({ result: "already-ignored", tracked: false });
    expect(await readFile(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.mcp.json\n");
  });

  it("flags a .mcp.json that's already committed", async () => {
    git("init", "-q");
    await writeConfig({ mcpServers: {} });
    git("add", ".mcp.json");

    await expect(ensureGitignored(dir)).resolves.toEqual({ result: "added", tracked: true });
  });
});
