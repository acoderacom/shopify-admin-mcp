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

  return { outcome, all, recent, waitFor, press, verify, save, downloadHorizon, saveHorizonZip, writeProjectDocs };
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

// Full theme development (already the default in a folder with a theme), then the store and access token
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
    expect(all()).not.toContain("Horizon project:");

    await press(ENTER);
    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toEqual({
      store: "mystore.myshopify.com",
      auth: { mode: "access-token", accessToken: "shpat_secret" },
      includeDevMcp: true,
      advanced: undefined,
      disableThemeWrites: true,
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
    expect(all()).toContain("Settings: defaults");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toEqual({
      store: "mystore.myshopify.com",
      auth: { mode: "client-credentials", clientId: "client-id", clientSecret: "client-secret" },
      includeDevMcp: false,
      advanced: undefined,
      disableThemeWrites: true,
    });
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
    expect(all()).toContain("Mode: Full theme design");
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
    expect(all()).toContain("● Full theme design");
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
    expect(recent()).toContain(".mcp.json is saved. Run setup again to finish the Horizon project.");
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
});
