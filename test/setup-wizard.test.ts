import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HorizonVersion } from "../src/setup/horizon.js";
import { describeExisting, type SaveResult, type SetupAnswers } from "../src/setup/mcp-config.js";
import type { NodeCheck } from "../src/setup/node-version.js";
import type { ProjectDocsResult, TemplateIndex } from "../src/setup/template.js";
import type { VerifyResult } from "../src/setup/verify.js";
import { runWizard, type WizardOptions } from "../src/setup/wizard.js";

const ENTER = "\r";
const DOWN = "\u001B[B";
const UP = "\u001B[A";
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

const ADMIN_NODE: NodeCheck = { label: "Shopify Admin MCP", range: ">=22.12.0", ok: true };
const DEV_NODE: NodeCheck = { label: "Shopify Dev MCP", range: ">=22.12.0", ok: true };
const HORIZON_420: HorizonVersion = { version: "4.2.0", sha: "f9aef27cd24723119fca896eea43bdeda9961022" };
const HORIZON_415: HorizonVersion = { version: "4.1.5", sha: "b23375047e46ebf45d537d73ada73966190a0866" };
const INDEX: TemplateIndex = { current: HORIZON_420, supported: [HORIZON_420] };
const LIVE_THEME = { id: "gid://shopify/OnlineStoreTheme/111", name: "Horizon", themeName: "Horizon", version: "4.2.0" };
const CONNECTED: VerifyResult = { ok: true, shopName: "My Store", devStore: true, passwordProtected: false, liveTheme: LIVE_THEME };
const DOCS_CREATED: ProjectDocsResult = {
  files: [
    { name: "CLAUDE.md", action: "created" },
    { name: "THEME.md", action: "created" },
    { name: "customizations.md", action: "created" },
  ],
  placeholdersLeft: false,
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "shopify-mcp-wizard-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(options: Partial<WizardOptions> = {}) {
  const verify = vi.fn<WizardOptions["verify"]>(async () => CONNECTED);
  const save = vi.fn<WizardOptions["save"]>(
    async (): Promise<SaveResult> => ({ path: path.join(cwd, ".mcp.json"), gitignore: "added", tracked: false })
  );
  const downloadHorizon = vi.fn<WizardOptions["downloadHorizon"]>(async () => ({ dir: path.join(cwd, "theme"), files: 484 }));
  const writeProjectDocs = vi.fn<WizardOptions["writeProjectDocs"]>(async () => DOCS_CREATED);
  const saveHorizonZip = vi.fn<WizardOptions["saveHorizonZip"]>(async (horizon) => path.join(cwd, `horizon-${horizon.version}.zip`));
  const prepareThemeDir = vi.fn<WizardOptions["prepareThemeDir"]>(async () => {});

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
    loadTemplateIndex: async () => INDEX,
    downloadHorizon,
    saveHorizonZip,
    writeProjectDocs,
    prepareThemeDir,
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

  return { outcome, all, recent, waitFor, press, verify, save, downloadHorizon, saveHorizonZip, writeProjectDocs, prepareThemeDir };
}

type Wizard = ReturnType<typeof setup>;
const savedAnswers = (save: Wizard["save"]): SetupAnswers => save.mock.calls[0]![0];

const MODE_QUESTION = "What do you want to set up?";

// Connect to a store only, then the store and access token, checked
async function toConnect({ waitFor, press }: Wizard, token = "shpat_x") {
  await waitFor(MODE_QUESTION);
  await press(ENTER);
  await waitFor("Store domain");
  await press("mystore", ENTER);
  await waitFor("How does the app authenticate?");
  await press(ENTER);
  await waitFor("Admin API access token");
  await press(token, ENTER);
  await waitFor("Also add the Shopify Dev MCP server?");
}

// Then no Shopify Dev MCP: the shortest path to the summary
async function quickPath(wizard: Wizard, token = "shpat_x") {
  await toConnect(wizard, token);
  await wizard.press("n");
}

// Full theme design with another theme (the default in a folder set up for one), then the store and access token
async function toOther({ waitFor, press }: Wizard, { preselected = false, fromTheme = false } = {}) {
  await waitFor(MODE_QUESTION);
  await press(...(preselected ? [ENTER] : fromTheme ? [DOWN, ENTER] : [DOWN, DOWN, ENTER]));
  await waitFor("Store domain");
  await press("mystore", ENTER);
  await waitFor("How does the app authenticate?");
  await press(ENTER);
  await waitFor("Admin API access token");
  await press("shpat_x", ENTER);
}

// Full theme development (already the default in a folder with a theme), then the store and access token
const waitForMode = ({ waitFor }: Wizard) => waitFor(MODE_QUESTION);

async function toTheme({ waitFor, press }: Wizard, { preselected = false } = {}) {
  await waitFor(MODE_QUESTION);
  await press(...(preselected ? [ENTER] : [DOWN, ENTER]));
  await waitFor("Store domain");
  await press("mystore", ENTER);
  await waitFor("How does the app authenticate?");
  await press(ENTER);
  await waitFor("Admin API access token");
  await press("shpat_x", ENTER);
}

describe("setup wizard", () => {
  it("checks Node.js for both servers before asking anything", async () => {
    const { all, waitFor } = setup();
    await waitFor(MODE_QUESTION);

    expect(all()).toContain("Node.js v24.15.0");
    expect(all()).toContain("Shopify Admin MCP needs Node.js >=22.12.0");
    expect(all()).toContain("Shopify Dev MCP needs Node.js >=22.12.0");
  });

  it("walks a new config through store, access token, a credentials check, and Shopify Dev MCP", async () => {
    const { outcome, all, recent, waitFor, press, verify, save, downloadHorizon } = setup();
    await waitFor(MODE_QUESTION);
    await press(ENTER);
    await waitFor("Store domain");

    await press("mystore", ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("Admin API access token");
    await press("shpat_secret", ENTER);
    // Checked right away, before the other questions
    await waitFor("Connected to My Store");
    expect(verify).toHaveBeenCalledWith("mystore.myshopify.com", { mode: "access-token", accessToken: "shpat_secret" });
    await waitFor("Also add the Shopify Dev MCP server?");
    await press(ENTER);
    await waitFor("Save .mcp.json?");

    expect(all()).not.toContain("shpat_secret");
    expect(all()).toContain("Mode: Connect to a store only");
    expect(all()).toContain("Theme edits: off");
    expect(all()).toContain("such as product images, go in ./uploads");
    expect(all()).toContain(`Settings: uploads from ${path.join(cwd, "uploads")}`);
    expect(all()).not.toContain("Horizon project:");

    await press(ENTER);
    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toEqual({
      store: "mystore.myshopify.com",
      auth: { mode: "access-token", accessToken: "shpat_secret" },
      includeDevMcp: true,
      advanced: {
        readOnly: false,
        allowLiveThemeWrites: false,
        uploadDir: path.join(cwd, "uploads"),
        themeDir: undefined,
        toolsets: undefined,
        disableRawGraphql: false,
      },
      disableThemeWrites: true,
      lockThemes: false,
    });
    expect(downloadHorizon).not.toHaveBeenCalled();
    expect(recent()).toContain("Added .mcp.json to .gitignore");
  });

  it("rejects a store outside myshopify.com", async () => {
    const { waitFor, press } = setup();
    await waitFor(MODE_QUESTION);
    await press(ENTER);
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
    await waitFor(MODE_QUESTION);
    await press(ENTER);
    await waitFor("Store domain");

    await press(ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("press Enter to keep the current one");
    await press(ENTER);
    // No Shopify Dev MCP in the file, so not adding it is the default
    await waitFor("Also add the Shopify Dev MCP server?");
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

  it("collects client credentials, with no advanced settings to ask about", async () => {
    const { outcome, all, waitFor, press, save } = setup();
    await waitFor(MODE_QUESTION);
    await press(ENTER);
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
    await waitFor("Save .mcp.json?");
    expect(all()).not.toContain("advanced settings");
    expect(all()).toContain(`Settings: uploads from ${path.join(cwd, "uploads")}`);
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toMatchObject({
      store: "mystore.myshopify.com",
      auth: { mode: "client-credentials", clientId: "client-id", clientSecret: "client-secret" },
      includeDevMcp: false,
      advanced: { uploadDir: path.join(cwd, "uploads") },
      disableThemeWrites: true,
    });
  });

  it("keeps the other settings and an upload folder already in the file, minus live theme writes", async () => {
    const existing = describeExisting({
      mcpServers: {
        "shopify-admin-mcp": {
          args: ["@acodera/shopify-admin-mcp@latest"],
          env: {
            SHOPIFY_STORE: "old.myshopify.com",
            SHOPIFY_ACCESS_TOKEN: "shpat_current",
            SHOPIFY_UPLOAD_DIR: "/srv/product-images",
            SHOPIFY_ALLOW_LIVE_THEME_WRITES: "true",
            SHOPIFY_READ_ONLY: "true",
          },
        },
      },
    });
    const { outcome, all, waitFor, press, save } = setup({ existing });
    await waitFor(MODE_QUESTION);
    await press(ENTER);
    await waitFor("Store domain");
    await press(ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("press Enter to keep the current one");
    await press(ENTER);
    await waitFor("Also add the Shopify Dev MCP server?");
    await press(ENTER);
    await waitFor("Save .mcp.json?");

    expect(all()).not.toContain("go in ./uploads");
    expect(all()).toContain("Settings: read-only; uploads from /srv/product-images");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    // Undefined keeps the file's settings; saving turns live theme writes off for this mode
    expect(savedAnswers(save).advanced).toBeUndefined();
    expect(savedAnswers(save).disableThemeWrites).toBe(true);
  });

  it("lets the store and credentials be re-entered after a failed check", async () => {
    const verify = vi
      .fn<WizardOptions["verify"]>()
      .mockResolvedValueOnce({ ok: false, message: "Shopify API request failed (401)" })
      .mockResolvedValueOnce(CONNECTED);
    const { outcome, waitFor, press, save } = setup({ verify });
    await waitFor(MODE_QUESTION);
    await press(ENTER);
    await waitFor("Store domain");

    await press("mystore", ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("Admin API access token");
    await press("shpat_wrong", ENTER);
    await waitFor("Couldn't connect: Shopify API request failed (401)");
    await waitFor("What next?");

    await press(ENTER);
    await waitFor("Store domain");
    await press(ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("press Enter to keep the current one");
    await press("shpat_right", ENTER);
    await waitFor("Connected to My Store");
    await waitFor("Also add the Shopify Dev MCP server?");
    await press("n");
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
    const wizard = setup({
      nodeVersion: "v22.0.0",
      checkDevMcpNode: async () => ({ ...DEV_NODE, ok: false }),
    });
    const { outcome, all, waitFor, press, save } = wizard;
    await waitFor(MODE_QUESTION);
    expect(all()).toContain("Shopify Dev MCP needs Node.js >=22.12.0, but this is v22.0.0");

    await waitFor(MODE_QUESTION);
    await press(ENTER);
    await waitFor("Store domain");
    await press("mystore", ENTER);
    await waitFor("How does the app authenticate?");
    await press(ENTER);
    await waitFor("Admin API access token");
    await press("shpat_x", ENTER);
    await waitFor("won't start on v22.0.0 until you upgrade");
    await waitFor("Also add the Shopify Dev MCP server?");
    await press(ENTER);
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save).includeDevMcp).toBe(false);
  });
});

describe("setup wizard: Horizon project", () => {
  it("sets up the theme and docs when the live theme matches the template, with the settings CLAUDE.md needs", async () => {
    const verify = vi.fn<WizardOptions["verify"]>(async () => ({ ...CONNECTED, passwordProtected: true }));
    const wizard = setup({ verify });
    const { outcome, all, recent, waitFor, press, save, downloadHorizon, writeProjectDocs } = wizard;

    await toTheme(wizard);
    await waitFor("The storefront has a password");
    expect(all()).toContain("Template: Horizon 4.2.0 (acoderacom/claude-horizon)");
    expect(recent()).toContain('The live theme "Horizon" is Horizon 4.2.0, which matches the template.');
    // The live theme decides the version, so there's nothing to choose
    expect(all()).not.toContain("Which Horizon version?");
    await press("123", ENTER);
    await waitFor("Save .mcp.json?");
    expect(recent()).toContain("so those are switched on");
    expect(all()).not.toContain("Also add the Shopify Dev MCP server?");
    expect(all()).toContain("Mode: Full theme design with Horizon");
    expect(all()).toContain("Theme edits: on, including the live theme");
    expect(all()).toContain("Horizon project: Horizon 4.2.0 in ./theme, with its THEME.md");
    expect(all()).toContain(
      `Settings: live theme writes allowed; uploads from ${path.join(cwd, "uploads")}; theme files from ${path.join(cwd, "theme")}`
    );
    expect(downloadHorizon).not.toHaveBeenCalled();
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toMatchObject({
      includeDevMcp: true,
      disableThemeWrites: false,
      advanced: {
        readOnly: false,
        allowLiveThemeWrites: true,
        uploadDir: path.join(cwd, "uploads"),
        themeDir: path.join(cwd, "theme"),
        disableRawGraphql: false,
      },
    });
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(downloadHorizon.mock.invocationCallOrder[0]!);
    expect(downloadHorizon).toHaveBeenCalledWith(HORIZON_420);
    expect(writeProjectDocs).toHaveBeenCalledWith({
      kind: "horizon",
      replaceThemeMd: false,
      details: {
        store: "mystore.myshopify.com",
        horizonVersion: "4.2.0",
        devStore: true,
        liveTheme: { id: "gid://shopify/OnlineStoreTheme/111", version: "4.2.0" },
        passwordProtected: true,
        storefrontPassword: "123",
      },
    });
    expect(recent()).toContain(`Downloaded Horizon 4.2.0 into ${path.join(cwd, "theme")} (484 files)`);
    expect(recent()).toContain("Project docs for Horizon 4.2.0: CLAUDE.md created, THEME.md created, customizations.md created");
  });

  it("accepts any supported version, using that version's theme and docs", async () => {
    const verify = vi.fn<WizardOptions["verify"]>(async () => ({ ...CONNECTED, liveTheme: { ...LIVE_THEME, version: "4.1.5" } }));
    const index: TemplateIndex = { current: HORIZON_420, supported: [HORIZON_420, HORIZON_415] };
    const wizard = setup({ verify, loadTemplateIndex: async () => index });
    const { outcome, all, recent, waitFor, press, downloadHorizon, writeProjectDocs } = wizard;

    await toTheme(wizard);
    await waitFor("Save .mcp.json?");
    expect(all()).toContain("Template: Horizon 4.2.0 (current), 4.1.5 (acoderacom/claude-horizon)");
    expect(recent()).toContain("is Horizon 4.1.5, which matches the template.");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(downloadHorizon).toHaveBeenCalledWith(HORIZON_415);
    expect(writeProjectDocs.mock.calls[0]![0].details.horizonVersion).toBe("4.1.5");
  });

  it.each([
    [
      "older than the template",
      { ...CONNECTED, liveTheme: { ...LIVE_THEME, version: "4.1.3" } },
      'The live theme "Horizon" is Horizon 4.1.3, older than the template\'s Horizon 4.2.0. Switch the store to Horizon 4.2.0, then run setup again.',
    ],
    [
      "newer than the template",
      { ...CONNECTED, liveTheme: { ...LIVE_THEME, version: "4.3.0" } },
      "is Horizon 4.3.0, newer than the template's Horizon 4.2.0. Switch the store to Horizon 4.2.0, or wait until the template supports 4.3.0, then run setup again.",
    ],
    [
      "not Horizon",
      { ...CONNECTED, liveTheme: { id: "gid://shopify/OnlineStoreTheme/9", name: "Dawn", themeName: "Dawn", version: "15.0.0" } },
      'The live theme "Dawn" isn\'t Horizon. Switch the store to Horizon 4.2.0, then run setup again.',
    ],
  ] as const)("stops when the live theme is %s, offering an upload-ready zip", async (_case, result, notice) => {
    const wizard = setup({ verify: async () => result });
    const { outcome, recent, waitFor, press, save, downloadHorizon, saveHorizonZip } = wizard;

    await toTheme(wizard);
    await waitFor(notice);
    await waitFor("Save horizon-4.2.0.zip in this folder to upload?");
    expect(recent()).toContain(
      "The Shopify theme store only installs the newest Horizon. To put Horizon 4.2.0 on the store, upload it in the Shopify admin (Online Store → Themes → Add theme → Upload zip file) and publish it."
    );
    await press(ENTER);

    await expect(outcome).resolves.toBe("stopped");
    expect(saveHorizonZip).toHaveBeenCalledWith(HORIZON_420);
    expect(recent()).toContain(`Saved ${path.join(cwd, "horizon-4.2.0.zip")}`);
    expect(recent()).toContain("Setup stopped. .mcp.json wasn't changed.");
    expect(save).not.toHaveBeenCalled();
    expect(downloadHorizon).not.toHaveBeenCalled();
  });

  it("saves no zip when that's declined, and reports a failed zip", async () => {
    const older = { ...CONNECTED, liveTheme: { ...LIVE_THEME, version: "4.1.3" } };

    const declined = setup({ verify: async () => older });
    await toTheme(declined);
    await declined.waitFor("Save horizon-4.2.0.zip in this folder to upload?");
    await declined.press("n");
    await expect(declined.outcome).resolves.toBe("stopped");
    expect(declined.saveHorizonZip).not.toHaveBeenCalled();

    const failing = setup({ verify: async () => older, saveHorizonZip: async () => Promise.reject(new Error("GitHub returned 500")) });
    await toTheme(failing);
    await failing.waitFor("Save horizon-4.2.0.zip in this folder to upload?");
    await failing.press(ENTER);
    await expect(failing.outcome).resolves.toBe("stopped");
    expect(failing.recent()).toContain("Couldn't save the zip: GitHub returned 500");
  });

  it("stops when the live theme can't be read, without a zip", async () => {
    const wizard = setup({ verify: async () => ({ ...CONNECTED, liveTheme: undefined, liveThemeError: "Access denied for themes field" }) });
    const { outcome, recent, waitFor, saveHorizonZip } = wizard;

    await toTheme(wizard);
    await waitFor("Couldn't read the live theme (Access denied for themes field), so setup can't check it's a Horizon version the template supports.");

    await expect(outcome).resolves.toBe("stopped");
    expect(recent()).not.toContain("Save horizon");
    expect(saveHorizonZip).not.toHaveBeenCalled();
  });

  it("stops the whole setup when GitHub can't give the template's versions", async () => {
    const wizard = setup({
      loadTemplateIndex: async () => Promise.reject(new Error("GitHub's rate limit was reached, so try again in an hour")),
    });
    const { outcome, all, waitFor, press, verify, save } = wizard;

    await waitFor(MODE_QUESTION);
    await press(DOWN, ENTER);
    await waitFor("Couldn't read the template's versions from acoderacom/claude-horizon: GitHub's rate limit was reached");

    await expect(outcome).resolves.toBe("stopped");
    expect(all()).toContain("Setup stopped. .mcp.json wasn't changed.");
    expect(all()).not.toContain("Store domain");
    expect(verify).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("replaces theme files and THEME.md only when that's confirmed", async () => {
    await mkdir(path.join(cwd, "theme"));
    await writeFile(path.join(cwd, "theme", "custom.liquid"), "mine");
    await writeFile(path.join(cwd, "THEME.md"), "old spec");
    const wizard = setup();
    const { outcome, all, waitFor, press, downloadHorizon, writeProjectDocs } = wizard;

    await waitFor(MODE_QUESTION);
    // A folder that already has a theme defaults to theme design
    expect(all()).toContain("● Full theme design with Horizon");
    await toTheme(wizard, { preselected: true });
    await waitFor("Replace the files in ./theme and THEME.md with Horizon 4.2.0?");
    await press("y");
    // The store has no storefront password, so there's no question about it
    await waitFor("Save .mcp.json?");
    expect(all()).not.toContain("Storefront password");
    expect(all()).toContain("Horizon project: Horizon 4.2.0 in ./theme, with its THEME.md, replacing current files");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(downloadHorizon).toHaveBeenCalledWith(HORIZON_420);
    expect(writeProjectDocs.mock.calls[0]![0]).toMatchObject({ replaceThemeMd: true });
  });

  it("cancels when replacing the current files is declined, the default", async () => {
    await mkdir(path.join(cwd, "theme"));
    await writeFile(path.join(cwd, "theme", "custom.liquid"), "mine");
    const wizard = setup();
    const { outcome, recent, waitFor, press, save, downloadHorizon } = wizard;

    await toTheme(wizard, { preselected: true });
    await waitFor("Replace the files in ./theme with Horizon 4.2.0?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("cancelled");
    expect(recent()).toContain("Cancelled. .mcp.json wasn't changed.");
    expect(save).not.toHaveBeenCalled();
    expect(downloadHorizon).not.toHaveBeenCalled();
  });

  it("offers no way past a failed credentials check, since theme design needs the live theme", async () => {
    const wizard = setup({ verify: async () => ({ ok: false, message: "Shopify API request failed (401)" }) });
    const { outcome, recent, waitFor, press } = wizard;

    await toTheme(wizard);
    await waitFor("What next?");
    expect(recent()).toContain("Re-enter the store and credentials");
    expect(recent()).not.toContain("Continue anyway");
    await press(DOWN, ENTER);

    await expect(outcome).resolves.toBe("cancelled");
  });

  it("still writes the docs when the theme download fails, and reports it", async () => {
    const downloadHorizon = vi.fn<WizardOptions["downloadHorizon"]>(async () => Promise.reject(new Error("GitHub returned 500")));
    const wizard = setup({ downloadHorizon });
    const { outcome, recent, waitFor, press, save, writeProjectDocs } = wizard;

    await toTheme(wizard);
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("failed");
    expect(save).toHaveBeenCalled();
    expect(writeProjectDocs).toHaveBeenCalled();
    expect(recent()).toContain("Couldn't download Horizon: GitHub returned 500");
    expect(recent()).toContain(".mcp.json is saved. Run setup again to finish the theme project.");
  });

  it("stops theme design when ./theme is a file", async () => {
    await writeFile(path.join(cwd, "theme"), "");
    const { outcome, all, waitFor, press, save } = setup();

    await waitFor(MODE_QUESTION);
    await press(DOWN, ENTER);
    await waitFor("is a file, so setup can't put the Horizon theme there. Move it, then run setup again.");

    await expect(outcome).resolves.toBe("stopped");
    expect(all()).not.toContain("Store domain");
    expect(save).not.toHaveBeenCalled();
  });
  describe("editing a live site", () => {
    const LIVE = { id: "gid://shopify/OnlineStoreTheme/222", name: "Dawn", themeName: "Dawn", version: "15.4.0", role: "MAIN" as const };
    const COPY = { id: "gid://shopify/OnlineStoreTheme/333", name: "theme-copy-1", themeName: "Dawn", version: "15.4.0", role: "UNPUBLISHED" as const };
    const LIVE_SITE_CLAUDE_MD = "- `THEME.md`: technical spec of this store's theme, written by Claude from the theme's own files.\n";
    const HORIZON_CLAUDE_MD = "- `THEME.md`: technical spec of stock Horizon 4.2.0 for agents.\n";
    const { role: _role, ...liveTheme } = LIVE;
    const withThemes = (themes = [LIVE, COPY]) =>
      vi.fn<WizardOptions["verify"]>(async () => ({ ...CONNECTED, passwordProtected: true, liveTheme, themes }));

    // Picks the theme (Enter keeps the highlighted one), then skips the storefront password
    async function pickTheme({ waitFor, press }: Wizard, keys: string[] = [ENTER]) {
      await waitFor("Which theme will Claude edit?");
      await press(...keys);
      await waitFor("The storefront has a password");
      await press(ENTER);
      await waitFor("Save .mcp.json?");
    }

    it("lists the store's themes, edits only a copy, and locks themes, filling the copy in to the docs", async () => {
      const loadTemplateIndex = vi.fn<WizardOptions["loadTemplateIndex"]>(async () => INDEX);
      const wizard = setup({ verify: withThemes(), loadTemplateIndex });
      const { outcome, all, recent, waitFor, press, save, downloadHorizon, writeProjectDocs, prepareThemeDir } = wizard;

      await toOther(wizard);
      await waitFor("Which theme will Claude edit?");
      // The live theme is listed but can't be picked; the first copy is highlighted
      expect(recent()).toContain("Dawn: Dawn 15.4.0, live theme, can't be edited here");
      expect(recent()).toContain("● theme-copy-1: Dawn 15.4.0, unpublished");
      // No Horizon template or version check
      expect(loadTemplateIndex).not.toHaveBeenCalled();
      expect(all()).not.toContain("Template: Horizon");
      await press(ENTER);
      await waitFor("The storefront has a password");
      await press("123", ENTER);
      await waitFor("Save .mcp.json?");
      expect(all()).not.toContain("Also add the Shopify Dev MCP server?");
      expect(all()).toContain('CLAUDE.md has Claude edit "theme-copy-1" from ./theme');
      expect(all()).toContain("Live theme writes stay off and themes are locked");
      expect(all()).toContain("Mode: Full theme edit live site");
      expect(all()).toContain("Theme edits: files of the chosen copy only; themes locked");
      expect(all()).toContain("Theme to edit: theme-copy-1: Dawn 15.4.0, unpublished, gid://shopify/OnlineStoreTheme/333");
      expect(all()).toContain(`Settings: uploads from ${path.join(cwd, "uploads")}; theme files from ${path.join(cwd, "theme")}`);
      expect(all()).not.toContain("Horizon project:");
      await press(ENTER);

      await expect(outcome).resolves.toBe("saved");
      expect(savedAnswers(save)).toMatchObject({
        includeDevMcp: true,
        disableThemeWrites: false,
        lockThemes: true,
        advanced: {
          readOnly: false,
          allowLiveThemeWrites: false,
          uploadDir: path.join(cwd, "uploads"),
          themeDir: path.join(cwd, "theme"),
          disableRawGraphql: false,
        },
      });
      expect(downloadHorizon).not.toHaveBeenCalled();
      expect(prepareThemeDir).toHaveBeenCalledWith(false);
      expect(writeProjectDocs).toHaveBeenCalledWith({
        kind: "other",
        replaceThemeMd: false,
        details: {
          store: "mystore.myshopify.com",
          horizonVersion: undefined,
          // CLAUDE.md always says "live store" here
          devStore: undefined,
          liveTheme: undefined,
          passwordProtected: true,
          storefrontPassword: "123",
          editTheme: { id: "gid://shopify/OnlineStoreTheme/333", name: "theme-copy-1", stock: "Dawn 15.4.0" },
        },
      });
      expect(recent()).toContain("Ready: ./theme, for the theme you download");
      expect(recent()).toContain("Project docs for the live site: CLAUDE.md created, THEME.md created, customizations.md created");
      // Copying the theme in and learning it are left to the user
      expect(recent()).toContain("Next, by hand");
      expect(recent()).toContain('1. Copy the files of "theme-copy-1" into ./theme: Shopify admin → Online Store → Themes → ⋯ on that theme → Download theme file');
      expect(recent()).toContain("2. When you want Claude to learn the theme, ask it to: it writes THEME.md from ./theme.");
    });

    it("can't pick the live theme: the cursor skips it", async () => {
      const wizard = setup({ verify: withThemes([LIVE, COPY, { ...COPY, id: "gid://shopify/OnlineStoreTheme/444", name: "theme-copy-2" }]) });

      await toOther(wizard);
      // Up from the first copy wraps past the live theme to the last copy
      await pickTheme(wizard, [UP, ENTER]);
      await wizard.press(ENTER);
      await expect(wizard.outcome).resolves.toBe("saved");
      expect(wizard.writeProjectDocs.mock.calls[0]![0].details.editTheme?.name).toBe("theme-copy-2");
    });

    it("shows the ID of copies that share a name and version", async () => {
      const twin = { ...COPY, id: "gid://shopify/OnlineStoreTheme/555" };
      const wizard = setup({ verify: withThemes([LIVE, COPY, twin]) });

      await toOther(wizard);
      await wizard.waitFor("Which theme will Claude edit?");
      expect(wizard.recent()).toContain("● theme-copy-1: Dawn 15.4.0, unpublished, ID 333");
      expect(wizard.recent()).toContain("theme-copy-1: Dawn 15.4.0, unpublished, ID 555");
    });

    it("stops when the store has no copy, saying how to make one", async () => {
      const wizard = setup({ verify: withThemes([LIVE]) });

      await toOther(wizard);
      await wizard.waitFor(
        "The store has no unpublished theme for Claude to edit. Duplicate the live theme in the Shopify admin (Online Store → Themes → ⋯ → Duplicate), give the copy a name, then run setup again."
      );
      await expect(wizard.outcome).resolves.toBe("stopped");
      expect(wizard.save).not.toHaveBeenCalled();
    });

    it("warns when the copy CLAUDE.md names has since been published", async () => {
      await writeFile(path.join(cwd, "CLAUDE.md"), `${LIVE_SITE_CLAUDE_MD}- Theme to edit: theme-copy-1 (Dawn 15.4.0), ID ${COPY.id}\n`);
      const published = { ...COPY, role: "MAIN" as const };
      const other = { ...COPY, id: "gid://shopify/OnlineStoreTheme/444", name: "theme-copy-2" };
      const wizard = setup({ verify: withThemes([published, other]) });

      await toOther(wizard, { preselected: true });
      await wizard.waitFor("Which theme will Claude edit?");
      expect(wizard.all()).toContain('"theme-copy-1", the theme CLAUDE.md names, is now the live theme, so pick a copy to edit.');
      expect(wizard.recent()).toContain("● theme-copy-2: Dawn 15.4.0, unpublished");
    });

    it("stops when the store's themes can't be read", async () => {
      const verify = vi.fn<WizardOptions["verify"]>(async () => ({ ...CONNECTED, liveTheme: undefined, themesError: "Access denied" }));
      const wizard = setup({ verify });

      await toOther(wizard);
      await wizard.waitFor("Couldn't list the store's themes (Access denied). The app needs the read_themes scope; then run setup again.");
      await expect(wizard.outcome).resolves.toBe("stopped");
      expect(wizard.save).not.toHaveBeenCalled();
    });

    it("keeps the theme files, THEME.md and the chosen theme when run again, unless asked to start over", async () => {
      await writeFile(path.join(cwd, "CLAUDE.md"), `${LIVE_SITE_CLAUDE_MD}- Theme to edit: theme-copy-1 (Dawn 15.4.0), ID ${COPY.id}\n`);
      await writeFile(path.join(cwd, "THEME.md"), "# Dawn spec");
      await mkdir(path.join(cwd, "theme"));
      await writeFile(path.join(cwd, "theme", "layout.liquid"), "x");

      const kept = setup({ verify: withThemes() });
      await kept.waitFor(MODE_QUESTION);
      // A folder set up for a live site defaults to that mode
      expect(kept.all()).toContain("● Full theme edit live site");
      await toOther(kept, { preselected: true });
      await kept.waitFor("Start over? ./theme is emptied and THEME.md starts blank");
      await kept.press(ENTER);
      await kept.waitFor("Which theme will Claude edit?");
      // The theme CLAUDE.md names stays the default
      expect(kept.recent()).toContain("● theme-copy-1: Dawn 15.4.0, unpublished");
      await kept.press(ENTER);
      await kept.waitFor("The storefront has a password");
      await kept.press(ENTER);
      await kept.waitFor("Save .mcp.json?");
      expect(kept.all()).not.toContain("is emptied and THEME.md starts blank\n");
      await kept.press(ENTER);
      await expect(kept.outcome).resolves.toBe("saved");
      expect(kept.prepareThemeDir).toHaveBeenCalledWith(false);
      expect(kept.writeProjectDocs.mock.calls[0]![0]).toMatchObject({ kind: "other", replaceThemeMd: false });
      expect(kept.recent()).toContain('1. ./theme already has files. If they aren\'t "theme-copy-1", empty it and copy that theme\'s files in again.');

      const reset = setup({ verify: withThemes() });
      await toOther(reset, { preselected: true });
      await reset.waitFor("Start over?");
      await reset.press("y");
      await pickTheme(reset);
      expect(reset.all()).toContain("; ./theme is emptied and THEME.md starts blank");
      await reset.press(ENTER);
      await expect(reset.outcome).resolves.toBe("saved");
      expect(reset.prepareThemeDir).toHaveBeenCalledWith(true);
      expect(reset.writeProjectDocs.mock.calls[0]![0]).toMatchObject({ kind: "other", replaceThemeMd: true });
    });

    it("switches a Horizon project over only when confirmed", async () => {
      await writeFile(path.join(cwd, "CLAUDE.md"), HORIZON_CLAUDE_MD);
      await writeFile(path.join(cwd, "THEME.md"), "Horizon spec");

      // A folder with a THEME.md defaults to Horizon, one down from a live site
      const declined = setup({ verify: withThemes() });
      await toOther(declined, { fromTheme: true });
      await declined.waitFor("This folder is set up for Horizon. Switch it to editing a live site?");
      await declined.press(ENTER);
      await expect(declined.outcome).resolves.toBe("cancelled");
      expect(declined.save).not.toHaveBeenCalled();

      const switched = setup({ verify: withThemes() });
      await toOther(switched, { fromTheme: true });
      await switched.waitFor("Switch it to editing a live site?");
      await switched.press("y");
      await pickTheme(switched);
      await switched.press(ENTER);
      await expect(switched.outcome).resolves.toBe("saved");
      expect(switched.prepareThemeDir).toHaveBeenCalledWith(true);
      expect(switched.writeProjectDocs.mock.calls[0]![0]).toMatchObject({ kind: "other", replaceThemeMd: true });
    });

    it("lists a CLAUDE.md written for a live site among the files Horizon replaces", async () => {
      await writeFile(path.join(cwd, "CLAUDE.md"), LIVE_SITE_CLAUDE_MD);
      await writeFile(path.join(cwd, "THEME.md"), "# Dawn spec");
      const wizard = setup();

      await waitForMode(wizard);
      // From a live site, the default here, up to Horizon
      await wizard.press(UP, ENTER);
      await wizard.waitFor("Store domain");
      await wizard.press("mystore", ENTER);
      await wizard.waitFor("How does the app authenticate?");
      await wizard.press(ENTER);
      await wizard.waitFor("Admin API access token");
      await wizard.press("shpat_x", ENTER);
      await wizard.waitFor("Replace THEME.md and CLAUDE.md with Horizon 4.2.0?");
      await wizard.press(ENTER);
      await expect(wizard.outcome).resolves.toBe("cancelled");
    });

    it("stops when ./theme is a file", async () => {
      await writeFile(path.join(cwd, "theme"), "");
      const wizard = setup({ verify: withThemes() });

      await toOther(wizard);
      await wizard.waitFor("is a file, so setup can't make the theme folder there. Move it, then run setup again.");
      await expect(wizard.outcome).resolves.toBe("stopped");
      expect(wizard.save).not.toHaveBeenCalled();
    });
  });
});
