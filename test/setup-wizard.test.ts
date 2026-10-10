import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeExisting, type SaveResult, type SetupAnswers } from "../src/setup/mcp-config.js";
import type { NodeCheck } from "../src/setup/node-version.js";
import type { VerifyResult } from "../src/setup/verify.js";
import { runWizard, type WizardOptions } from "../src/setup/wizard.js";

const ENTER = "\r";
const DOWN = "\u001B[B";
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

const ADMIN_NODE: NodeCheck = { label: "shopify-admin-mcp", range: ">=22.12.0", ok: true };
const DEV_NODE: NodeCheck = { label: "Shopify Dev MCP", range: ">=22.12.0", ok: true };

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "shopify-mcp-wizard-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(options: Partial<WizardOptions> = {}) {
  const verify = vi.fn<WizardOptions["verify"]>(async (): Promise<VerifyResult> => ({ ok: true, shopName: "My Store" }));
  const save = vi.fn<WizardOptions["save"]>(
    async (): Promise<SaveResult> => ({ path: path.join(cwd, ".mcp.json"), gitignore: "added", tracked: false })
  );

  const input = new PassThrough();
  let written = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        written += String(chunk);
        done();
      },
    }),
    // Wide enough that long temp paths don't wrap mid-sentence
    { columns: 300, rows: 60 }
  );

  const outcome = runWizard({
    cwd,
    existing: describeExisting(undefined),
    nodeVersion: "v24.15.0",
    adminNode: ADMIN_NODE,
    checkDevMcpNode: async () => DEV_NODE,
    verify,
    save,
    input,
    output,
    ...options,
  });

  // Output since the last keypress, so a wait only matches what that keypress caused
  let mark = 0;
  const all = () => written.replace(ANSI, "");
  const recent = () => written.slice(mark).replace(ANSI, "");
  const waitFor = async (text: string) => {
    for (let i = 0; i < 200; i++) {
      if (recent().includes(text)) {
        // The prompt starts reading keys just after it draws
        await sleep(20);
        return;
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for "${text}". Output since the last key:\n${recent()}`);
  };
  // Sends keys one at a time, as a terminal does; plain text is split into characters
  const press = async (...keys: string[]) => {
    mark = written.length;
    for (const key of keys) {
      for (const chunk of key.startsWith("\u001B") ? [key] : [...key]) {
        input.write(chunk);
        await sleep(5);
      }
      await sleep(20);
    }
  };

  return { outcome, all, recent, waitFor, press, verify, save };
}

type Wizard = ReturnType<typeof setup>;
const savedAnswers = (save: Wizard["save"]): SetupAnswers => save.mock.calls[0]![0];

// Store, access token, no Shopify Dev MCP, no advanced settings: the shortest path to the summary
async function quickPath({ waitFor, press }: Wizard, token = "shpat_x") {
  await waitFor("Store domain");
  await press("mystore", ENTER);
  await waitFor("How does the app authenticate?");
  await press(ENTER);
  await waitFor("Admin API access token");
  await press(token, ENTER);
  await waitFor("Also add the Shopify Dev MCP server?");
  await press("n");
  await waitFor("Configure advanced settings?");
  await press(ENTER);
}

describe("setup wizard", () => {
  it("checks Node.js for both servers before asking anything", async () => {
    const { all, waitFor } = setup();
    await waitFor("Store domain");

    expect(all()).toContain("Node.js v24.15.0");
    expect(all()).toContain("shopify-admin-mcp needs Node.js >=22.12.0");
    expect(all()).toContain("Shopify Dev MCP needs Node.js >=22.12.0");
  });

  it("walks a new config through store, access token, and Shopify Dev MCP", async () => {
    const { outcome, all, recent, waitFor, press, verify, save } = setup();
    await waitFor("Store domain");

    await press("mystore", ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("Admin API access token");
    await press("shpat_secret", ENTER);
    await waitFor("Also add the Shopify Dev MCP server?");
    await press(ENTER);
    await waitFor("Configure advanced settings?");
    await press(ENTER);
    await waitFor("Save .mcp.json?");

    expect(verify).toHaveBeenCalledWith("mystore.myshopify.com", { mode: "access-token", accessToken: "shpat_secret" });
    expect(all()).toContain("Connected to My Store");
    expect(all()).not.toContain("shpat_secret");

    await press(ENTER);
    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toEqual({
      store: "mystore.myshopify.com",
      auth: { mode: "access-token", accessToken: "shpat_secret" },
      includeDevMcp: true,
      advanced: undefined,
    });
    expect(recent()).toContain("Added .mcp.json to .gitignore");
  });

  it("rejects a store outside myshopify.com", async () => {
    const { waitFor, press } = setup();
    await waitFor("Store domain");

    await press("evil.com/x", ENTER);
    await waitFor("Use your store's myshopify.com domain");
  });

  it("keeps the current values when Enter is pressed on an existing config", async () => {
    const existing = describeExisting({
      mcpServers: {
        "shopify-admin-mcp": {
          args: ["@acodera/shopify-admin-mcp@latest"],
          env: { SHOPIFY_STORE: "old.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_current" },
        },
      },
    });
    const { outcome, waitFor, press, save } = setup({ existing });
    await waitFor("Store domain");

    await press(ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("press Enter to keep the current one");
    await press(ENTER);
    // No Shopify Dev MCP in the file, so not adding it is the default
    await waitFor("Also add the Shopify Dev MCP server?");
    await press(ENTER);
    await waitFor("Configure advanced settings?");
    await press(ENTER);
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toMatchObject({
      store: "old.myshopify.com",
      auth: { mode: "access-token", accessToken: "shpat_current" },
      includeDevMcp: false,
    });
  });

  it("collects client credentials and advanced settings, creating an uploads folder", async () => {
    const { outcome, waitFor, press, save } = setup();
    await waitFor("Store domain");

    await press("mystore.myshopify.com", ENTER);
    await waitFor("How does the app authenticate?");
    await press(DOWN, ENTER);
    await waitFor("Client ID");
    await press("client-id", ENTER);
    await waitFor("Client secret");
    await press("client-secret", ENTER);
    await waitFor("Also add the Shopify Dev MCP server?");
    await press("n");
    await waitFor("Configure advanced settings?");
    await press("y");
    await waitFor("Read-only mode?");
    await press("n");
    await waitFor("Allow edits to the live");
    await press("y");
    await waitFor("Local file uploads");
    await press(ENTER);
    await waitFor("Toolsets to register");
    // Toggle off the first toolset (products)
    await press(" ", ENTER);
    await waitFor("Turn off raw GraphQL");
    await press("y");
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toEqual({
      store: "mystore.myshopify.com",
      auth: { mode: "client-credentials", clientId: "client-id", clientSecret: "client-secret" },
      includeDevMcp: false,
      advanced: {
        readOnly: false,
        allowLiveThemeWrites: true,
        uploadDir: path.join(cwd, "uploads"),
        toolsets: ["collections", "publishing", "metafields", "metaobjects", "customers", "orders", "inventory", "discounts", "files", "themes", "markets"],
        disableRawGraphql: true,
      },
    });
  });

  it("offers to create a custom upload folder that doesn't exist", async () => {
    await mkdir(path.join(cwd, "uploads"));
    const wizard = setup();
    const { outcome, recent, waitFor, press, save } = wizard;
    await waitFor("Store domain");

    await press("mystore", ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("Admin API access token");
    await press("shpat_x", ENTER);
    await waitFor("Also add the Shopify Dev MCP server?");
    await press("n");
    await waitFor("Configure advanced settings?");
    await press("y");
    await waitFor("Read-only mode?");
    await press("n");
    await waitFor("Allow edits to the live");
    await press("n");
    await waitFor("Local file uploads");
    expect(recent()).toContain(`Use ${path.join(cwd, "uploads")}`);
    await press(DOWN, ENTER);
    await waitFor("Folder the assistant may upload local files from");
    await press("assets/new", ENTER);
    await waitFor("Create it when saving?");
    await press("y");
    await waitFor("Toolsets to register");
    await press(ENTER);
    await waitFor("Turn off raw GraphQL");
    await press("n");
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save).advanced).toMatchObject({ uploadDir: path.join(cwd, "assets/new"), toolsets: undefined });
  });

  it("lets the store and credentials be re-entered after a failed check", async () => {
    const verify = vi
      .fn<WizardOptions["verify"]>()
      .mockResolvedValueOnce({ ok: false, message: "Shopify API request failed (401)" })
      .mockResolvedValueOnce({ ok: true, shopName: "My Store" });
    const wizard = setup({ verify });
    const { outcome, waitFor, press, save } = wizard;

    await quickPath(wizard, "shpat_wrong");
    await waitFor("Couldn't connect: Shopify API request failed (401)");
    await waitFor("What next?");

    await press(ENTER);
    await waitFor("Store domain");
    await press(ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("press Enter to keep the current one");
    await press("shpat_right", ENTER);
    // Goes straight back to the check instead of repeating the other questions
    await waitFor("Connected to My Store");
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(verify).toHaveBeenLastCalledWith("mystore.myshopify.com", { mode: "access-token", accessToken: "shpat_right" });
    expect(savedAnswers(save).auth).toEqual({ mode: "access-token", accessToken: "shpat_right" });
  });

  it("writes nothing when the summary is declined", async () => {
    const wizard = setup();
    const { outcome, recent, waitFor, press, save } = wizard;

    await quickPath(wizard);
    await waitFor("Save .mcp.json?");
    await press("n");

    await expect(outcome).resolves.toBe("cancelled");
    expect(save).not.toHaveBeenCalled();
    expect(recent()).toContain(".mcp.json wasn't changed");
  });

  it("reports a failed save", async () => {
    const wizard = setup({ save: async () => Promise.reject(new Error("EACCES: permission denied")) });
    const { outcome, recent, waitFor, press } = wizard;

    await quickPath(wizard);
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("failed");
    expect(recent()).toContain("Couldn't save .mcp.json: EACCES: permission denied");
  });

  it("warns and defaults to leaving out Shopify Dev MCP when this Node.js is too old for it", async () => {
    const { outcome, all, waitFor, press, save } = setup({
      nodeVersion: "v22.0.0",
      checkDevMcpNode: async () => ({ ...DEV_NODE, ok: false }),
    });
    await waitFor("Store domain");
    expect(all()).toContain("Shopify Dev MCP needs Node.js >=22.12.0, but this is v22.0.0");

    await press("mystore", ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("Admin API access token");
    await press("shpat_x", ENTER);
    await waitFor("won't start on v22.0.0 until you upgrade");
    await waitFor("Also add the Shopify Dev MCP server?");
    await press(ENTER);
    await waitFor("Configure advanced settings?");
    await press(ENTER);
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save).includeDevMcp).toBe(false);
  });
});
