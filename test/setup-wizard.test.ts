import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HorizonVersion } from "../src/setup/horizon.js";
import { describeExisting, type SaveResult, type SetupAnswers } from "../src/setup/mcp-config.js";
import type { NodeCheck } from "../src/setup/node-version.js";
import type { ProjectDocsResult } from "../src/setup/template.js";
import type { VerifyResult } from "../src/setup/verify.js";
import { runWizard, type WizardOptions } from "../src/setup/wizard.js";

const ENTER = "\r";
const DOWN = "\u001B[B";
const UP = "\u001B[A";
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

const ADMIN_NODE: NodeCheck = { label: "Shopify Admin MCP", range: ">=22.12.0", ok: true };
const DEV_NODE: NodeCheck = { label: "Shopify Dev MCP", range: ">=22.12.0", ok: true };
const HORIZON_VERSIONS: HorizonVersion[] = [
  { version: "4.2.0", sha: "f9aef27", date: "2026-09-18T16:47:43Z" },
  { version: "4.1.5", sha: "b233750", date: "2026-08-31T20:29:41Z" },
];
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
    listHorizonVersions: async () => HORIZON_VERSIONS,
    downloadHorizon,
    listDocsVersions: async () => ["4.2.0"],
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

  return { outcome, all, recent, waitFor, press, verify, save, downloadHorizon, writeProjectDocs };
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
    await waitFor("Which Horizon version?");
    expect(all()).toContain("Template: Horizon 4.2.0 (acoderacom/claude-horizon)");
    expect(recent()).toContain('The live theme "Horizon" is Horizon 4.2.0, which matches the template.');
    expect(recent()).toContain("v4.2.0 (recommended: matches the template and live theme, Sep 18, 2026)");
    await press(ENTER);
    await waitFor("The storefront has a password");
    await press("123", ENTER);
    await waitFor("Save .mcp.json?");
    expect(recent()).toContain("so those are switched on");
    expect(all()).not.toContain("Also add the Shopify Dev MCP server?");
    expect(all()).not.toContain("Configure advanced settings?");
    expect(all()).toContain("Mode: Full theme design");
    expect(all()).toContain("Theme edits: on, including the live theme");
    expect(all()).toContain("Horizon project: v4.2.0 into ./theme, docs for 4.2.0");
    expect(all()).toContain(`Settings: live theme writes allowed; uploads from ${path.join(cwd, "uploads")}`);
    expect(downloadHorizon).not.toHaveBeenCalled();
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(savedAnswers(save)).toMatchObject({
      includeDevMcp: true,
      disableThemeWrites: false,
      advanced: { readOnly: false, allowLiveThemeWrites: true, uploadDir: path.join(cwd, "uploads"), disableRawGraphql: false },
    });
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(downloadHorizon.mock.invocationCallOrder[0]!);
    expect(downloadHorizon).toHaveBeenCalledWith(HORIZON_VERSIONS[0]);
    expect(writeProjectDocs).toHaveBeenCalledWith({
      docsVersion: "4.2.0",
      replaceThemeMd: false,
      details: {
        store: "mystore.myshopify.com",
        devStore: true,
        liveTheme: { id: "gid://shopify/OnlineStoreTheme/111", version: "4.2.0" },
        passwordProtected: true,
        storefrontPassword: "123",
      },
    });
    expect(recent()).toContain(`Downloaded Horizon v4.2.0 into ${path.join(cwd, "theme")} (484 files)`);
    expect(recent()).toContain("Project docs for Horizon 4.2.0: CLAUDE.md created, THEME.md created, customizations.md created");
  });

  it("matches an older version the template also covers, and warns when another version is picked", async () => {
    const verify = vi.fn<WizardOptions["verify"]>(async () => ({ ...CONNECTED, liveTheme: { ...LIVE_THEME, version: "4.1.5" } }));
    const wizard = setup({ verify, listDocsVersions: async () => ["4.2.0", "4.1.5"] });
    const { outcome, all, recent, waitFor, press, downloadHorizon, writeProjectDocs } = wizard;

    await toTheme(wizard);
    await waitFor("Which Horizon version?");
    expect(all()).toContain("Template: Horizon 4.2.0, 4.1.5 (acoderacom/claude-horizon)");
    expect(recent()).toContain("is Horizon 4.1.5, which matches the template.");
    expect(recent()).toContain("v4.1.5 (recommended: matches the template and live theme");
    await press(UP, ENTER);
    await waitFor("./theme will hold Horizon 4.2.0, but the live theme and THEME.md are Horizon 4.1.5.");
    await waitFor("Save .mcp.json?");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(downloadHorizon).toHaveBeenCalledWith(HORIZON_VERSIONS[0]);
    expect(writeProjectDocs.mock.calls[0]![0]).toMatchObject({ docsVersion: "4.1.5" });
  });

  it.each([
    [
      "older than the template",
      { ...CONNECTED, liveTheme: { ...LIVE_THEME, version: "4.1.3" } },
      'The live theme "Horizon" is Horizon 4.1.3, older than the template\'s Horizon 4.2.0. Upgrade it to Horizon 4.2.0 in the Shopify admin, then run setup again.',
    ],
    [
      "newer than the template",
      { ...CONNECTED, liveTheme: { ...LIVE_THEME, version: "4.3.0" } },
      "is Horizon 4.3.0, newer than the template's Horizon 4.2.0. Downgrade it to Horizon 4.2.0, or wait for the template to cover 4.3.0",
    ],
    [
      "not Horizon",
      { ...CONNECTED, liveTheme: { id: "gid://shopify/OnlineStoreTheme/9", name: "Dawn", themeName: "Dawn", version: "15.0.0" } },
      'The live theme "Dawn" isn\'t Horizon. Publish Horizon 4.2.0 in the Shopify admin, then run setup again.',
    ],
    [
      "unreadable",
      { ...CONNECTED, liveTheme: undefined, liveThemeError: "Access denied for themes field" },
      "Couldn't read the live theme (Access denied for themes field), so setup can't check it's the template's Horizon 4.2.0.",
    ],
  ] as const)("stops the whole setup when the live theme is %s", async (_case, result, notice) => {
    const wizard = setup({ verify: async () => result });
    const { outcome, recent, waitFor, press, save, downloadHorizon } = wizard;

    await toTheme(wizard);
    await waitFor(notice);

    await expect(outcome).resolves.toBe("stopped");
    expect(recent()).toContain("Setup stopped. .mcp.json wasn't changed.");
    expect(save).not.toHaveBeenCalled();
    expect(downloadHorizon).not.toHaveBeenCalled();
  });

  it("stops the whole setup when GitHub can't list the template versions", async () => {
    const wizard = setup({
      listDocsVersions: async () => Promise.reject(new Error("GitHub's rate limit was reached, so try again in an hour")),
    });
    const { outcome, all, waitFor, press, verify, save } = wizard;

    await waitFor(MODE_QUESTION);
    await press(DOWN, ENTER);
    await waitFor("Couldn't get the template versions from acoderacom/claude-horizon: GitHub's rate limit was reached");

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
    await waitFor("Which Horizon version?");
    await press(ENTER);
    await waitFor("Replace the files in ./theme and THEME.md with Horizon v4.2.0?");
    await press("y");
    // The store has no storefront password, so there's no question about it
    await waitFor("Save .mcp.json?");
    expect(all()).not.toContain("Storefront password");
    expect(all()).toContain("Horizon project: v4.2.0 into ./theme, docs for 4.2.0, replacing current files");
    await press(ENTER);

    await expect(outcome).resolves.toBe("saved");
    expect(downloadHorizon).toHaveBeenCalledWith(HORIZON_VERSIONS[0]);
    expect(writeProjectDocs.mock.calls[0]![0]).toMatchObject({ replaceThemeMd: true });
  });

  it("cancels when replacing the current files is declined, the default", async () => {
    await mkdir(path.join(cwd, "theme"));
    await writeFile(path.join(cwd, "theme", "custom.liquid"), "mine");
    const wizard = setup();
    const { outcome, recent, waitFor, press, save, downloadHorizon } = wizard;

    await toTheme(wizard, { preselected: true });
    await waitFor("Which Horizon version?");
    await press(ENTER);
    await waitFor("Replace the files in ./theme with Horizon v4.2.0?");
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
    await waitFor("Which Horizon version?");
    await press(ENTER);
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
