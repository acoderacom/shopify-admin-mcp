import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkLiveTheme,
  claudeMdKind,
  fillTemplate,
  loadTemplateIndex,
  parseTemplateIndex,
  writeProjectDocs,
  type ProjectDetails,
  type TemplateIndex,
} from "../src/setup/template.js";

const COMMIT_420 = "f9aef27cd24723119fca896eea43bdeda9961022";
const COMMIT_415 = "b23375047e46ebf45d537d73ada73966190a0866";
const VERSION = "[agent: insert the Horizon version THEME.md covers]";

// The store and version lines of the template's CLAUDE.md
const TEMPLATE = `# Project

## Store
- Store: [agent: insert the store's myshopify.com domain] ([agent: insert "development store" or "live store"])
- Live theme: Horizon [agent: insert the live theme's Horizon version], ID [agent: insert the live theme's ID, gid://shopify/OnlineStoreTheme/…]
- Storefront password (visitor gate on development and password-protected stores): [agent: insert the password in backticks, or delete this line if the storefront has none]. The user enters it.

## Files in this folder
- \`THEME.md\`: technical spec of stock Horizon ${VERSION} for agents.

## How to edit
2. The live \`config/settings_schema.json\` must report \`theme_version\` ${VERSION}, the version \`THEME.md\` covers.
`;

// The store and THEME.md lines of the template's live-site/CLAUDE.md
const OTHER_TEMPLATE = `# Project

## Store
- Store: [agent: insert the store's myshopify.com domain] (live store)
- Theme to edit: [agent: insert the theme's name and version], ID [agent: insert the theme's ID, gid://shopify/OnlineStoreTheme/…]
- Storefront password (visitor gate on development and password-protected stores): [agent: insert the password in backticks, or delete this line if the storefront has none]. The user enters it.

## Files in this folder
- \`THEME.md\`: technical spec of this store's theme, written by Claude from the theme's own files.
`;

const DETAILS: ProjectDetails = {
  store: "mystore.myshopify.com",
  horizonVersion: "4.2.0",
  devStore: true,
  liveTheme: { id: "gid://shopify/OnlineStoreTheme/111", version: "4.2.0" },
  passwordProtected: true,
  storefrontPassword: "pa$$word",
};

const INDEX: TemplateIndex = {
  current: { version: "4.2.0", sha: COMMIT_420 },
  supported: [
    { version: "4.2.0", sha: COMMIT_420 },
    { version: "4.1.5", sha: COMMIT_415 },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseTemplateIndex", () => {
  it("reads the supported versions, newest first, and the current one", () => {
    const index = parseTemplateIndex(
      JSON.stringify({
        current: "4.2.0",
        versions: {
          "4.1.5": { status: "supported", horizonCommit: COMMIT_415 },
          "4.2.0": { status: "supported", horizonCommit: COMMIT_420 },
          "4.3.0": { status: "draft" },
          "4.0.0": { status: "retired" },
        },
      })
    );
    expect(index).toEqual(INDEX);
  });

  it.each([
    ["not JSON", "{", "versions.json isn't valid JSON"],
    ["no versions", "{}", "versions.json has no versions"],
    ["a bad version", JSON.stringify({ current: "x", versions: { latest: { status: "supported" } } }), 'lists "latest"'],
    ["an unknown status", JSON.stringify({ current: "4.2.0", versions: { "4.2.0": { status: "live" } } }), "gives 4.2.0 no status"],
    ["no commit", JSON.stringify({ current: "4.2.0", versions: { "4.2.0": { status: "supported" } } }), "no full horizonCommit"],
    [
      "an unsupported current version",
      JSON.stringify({ current: "4.3.0", versions: { "4.2.0": { status: "supported", horizonCommit: COMMIT_420 }, "4.3.0": { status: "draft" } } }),
      "current version 4.3.0 isn't a supported version",
    ],
  ])("refuses %s", (_case, text, message) => {
    expect(() => parseTemplateIndex(text)).toThrow(message);
  });
});

describe("loadTemplateIndex", () => {
  it("reads versions.json from the template's main branch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ current: "4.2.0", versions: { "4.2.0": { status: "supported", horizonCommit: COMMIT_420 } } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadTemplateIndex()).resolves.toMatchObject({ current: { version: "4.2.0" } });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://raw.githubusercontent.com/acoderacom/claude-horizon/main/versions.json");
  });
});

describe("checkLiveTheme", () => {
  const horizon = (version?: string) => ({ name: "Horizon", themeName: "Horizon", version });

  it("matches any supported version", () => {
    expect(checkLiveTheme(horizon("4.2.0"), "", INDEX)).toEqual({ status: "match", horizon: INDEX.supported[0] });
    expect(checkLiveTheme(horizon("4.1.5"), "", INDEX)).toEqual({ status: "match", horizon: INDEX.supported[1] });
  });

  it("moves an older or newer live theme to the current version", () => {
    expect(checkLiveTheme(horizon("4.1.3"), "", INDEX)).toEqual({ status: "older", version: "4.1.3", current: INDEX.current });
    expect(checkLiveTheme(horizon("4.10.0"), "", INDEX)).toEqual({ status: "newer", version: "4.10.0", current: INDEX.current });
  });

  it("can't match a theme that isn't Horizon or that it can't read", () => {
    expect(checkLiveTheme({ name: "Dawn", themeName: "Dawn", version: "15.0.0" }, "", INDEX)).toEqual({
      status: "not-horizon",
      name: "Dawn",
      current: INDEX.current,
    });
    expect(checkLiveTheme(undefined, "Access denied for themes field", INDEX)).toEqual({
      status: "unknown",
      reason: "Access denied for themes field",
      current: INDEX.current,
    });
    expect(checkLiveTheme(horizon(), "", INDEX)).toMatchObject({ status: "unknown", reason: "its Horizon version couldn't be read" });
  });
});

describe("fillTemplate", () => {
  it("fills in the store, live theme, password and Horizon version", () => {
    const filled = fillTemplate(TEMPLATE, DETAILS);

    expect(filled).toContain(`## Store
- Store: mystore.myshopify.com (development store)
- Live theme: Horizon 4.2.0, ID gid://shopify/OnlineStoreTheme/111
- Storefront password (visitor gate on development and password-protected stores): \`pa$$word\`. The user enters it.
`);
    expect(filled).toContain("technical spec of stock Horizon 4.2.0 for agents.");
    expect(filled).toContain("must report `theme_version` 4.2.0, the version");
    expect(filled).not.toContain("[agent:");
  });

  it("leaves what setup doesn't know for Claude, and drops the password line when there's no password", () => {
    const filled = fillTemplate(TEMPLATE, { store: "mystore.myshopify.com", horizonVersion: "4.2.0", passwordProtected: false });

    expect(filled).toContain("- Store: mystore.myshopify.com ([agent: insert");
    expect(filled).toContain("- Live theme: Horizon [agent: insert the live theme's Horizon version], ID [agent:");
    expect(filled).not.toContain("Storefront password");
    // Unknown, so the line stays for Claude to ask about
    expect(fillTemplate(TEMPLATE, { store: "mystore.myshopify.com", horizonVersion: "4.2.0" })).toContain("[agent: insert the password");
  });

  it("updates a CLAUDE.md filled in earlier, including the Horizon version, and keeps everything else", () => {
    const earlier = `${fillTemplate(TEMPLATE, DETAILS)}\n- My own rule\n`;
    const updated = fillTemplate(earlier, {
      store: "other.myshopify.com",
      horizonVersion: "4.3.0",
      devStore: false,
      liveTheme: { id: "gid://shopify/OnlineStoreTheme/222", version: "4.3.0" },
      storefrontPassword: "new",
    });

    expect(updated).toContain("- Store: other.myshopify.com (live store)");
    expect(updated).toContain("- Live theme: Horizon 4.3.0, ID gid://shopify/OnlineStoreTheme/222");
    expect(updated).toContain("stores): `new`. The user enters it.");
    expect(updated).toContain("technical spec of stock Horizon 4.3.0 for agents.");
    expect(updated).toContain("must report `theme_version` 4.3.0, the version");
    expect(updated).toContain("- My own rule");
  });
});

describe("writeProjectDocs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shopify-mcp-docs-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Serves the template's files from raw.githubusercontent.com by path
  const serveTemplate = (files: Record<string, string>) => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const file = String(url).replace("https://raw.githubusercontent.com/acoderacom/claude-horizon/main/", "");
      return file in files ? new Response(files[file]) : new Response("Not Found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const TEMPLATE_FILES = {
    "CLAUDE.md": TEMPLATE,
    "customizations.md": `# Changes from stock Horizon ${VERSION}\n`,
    "versions/4.2.0/THEME.md": "spec 4.2.0 (`theme_version` 4.2.0)",
  };

  it("writes the shared docs and the version's THEME.md, with the placeholders filled in", async () => {
    const fetchMock = serveTemplate(TEMPLATE_FILES);

    await expect(writeProjectDocs(dir, { kind: "horizon", replaceThemeMd: false, details: DETAILS })).resolves.toEqual({
      files: [
        { name: "CLAUDE.md", action: "created" },
        { name: "THEME.md", action: "created" },
        { name: "customizations.md", action: "created" },
      ],
      placeholdersLeft: false,
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/main/")[1])).toEqual([
      "CLAUDE.md",
      "versions/4.2.0/THEME.md",
      "customizations.md",
    ]);
    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toContain("- Store: mystore.myshopify.com (development store)");
    expect(await readFile(path.join(dir, "THEME.md"), "utf8")).toBe("spec 4.2.0 (`theme_version` 4.2.0)");
    expect(await readFile(path.join(dir, "customizations.md"), "utf8")).toBe("# Changes from stock Horizon 4.2.0\n");
  });

  it("keeps the change log, and replaces THEME.md only when asked", async () => {
    serveTemplate(TEMPLATE_FILES);
    await writeFile(path.join(dir, "THEME.md"), "old spec");
    await writeFile(path.join(dir, "customizations.md"), "my changes");

    const kept = await writeProjectDocs(dir, {
      kind: "horizon",
      replaceThemeMd: false,
      details: { store: "mystore.myshopify.com", horizonVersion: "4.2.0" },
    });
    expect(kept.files.slice(1)).toEqual([
      { name: "THEME.md", action: "kept" },
      { name: "customizations.md", action: "kept" },
    ]);
    expect(kept.placeholdersLeft).toBe(true);

    const replaced = await writeProjectDocs(dir, { kind: "horizon", replaceThemeMd: true, details: DETAILS });
    expect(replaced.files).toEqual([
      { name: "CLAUDE.md", action: "updated" },
      { name: "THEME.md", action: "replaced" },
      { name: "customizations.md", action: "kept" },
    ]);
    expect(await readFile(path.join(dir, "THEME.md"), "utf8")).toBe("spec 4.2.0 (`theme_version` 4.2.0)");
    expect(await readFile(path.join(dir, "customizations.md"), "utf8")).toBe("my changes");
  });

  const OTHER_FILES = {
    "live-site/CLAUDE.md": OTHER_TEMPLATE,
    "live-site/customizations.md": "# Changes from the stock [agent: insert the theme's name and version]\n",
  };
  const COPY = { id: "gid://shopify/OnlineStoreTheme/333", name: "theme-copy-1", stock: "Dawn 15.4.0" };
  const OTHER_DETAILS: ProjectDetails = { store: "mystore.myshopify.com", passwordProtected: false, editTheme: COPY };

  it("writes a live site's docs with the chosen theme filled in and a blank THEME.md", async () => {
    const fetchMock = serveTemplate(OTHER_FILES);

    await expect(writeProjectDocs(dir, { kind: "other", replaceThemeMd: false, details: OTHER_DETAILS })).resolves.toEqual({
      files: [
        { name: "CLAUDE.md", action: "created" },
        { name: "THEME.md", action: "created" },
        { name: "customizations.md", action: "created" },
      ],
      placeholdersLeft: false,
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/main/")[1])).toEqual([
      "live-site/CLAUDE.md",
      "live-site/customizations.md",
    ]);
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("- Store: mystore.myshopify.com (live store)");
    expect(claude).toContain("- Theme to edit: theme-copy-1 (Dawn 15.4.0), ID gid://shopify/OnlineStoreTheme/333\n");
    expect(claude).not.toContain("Storefront password");
    expect(await readFile(path.join(dir, "THEME.md"), "utf8")).toBe("");
    expect(await readFile(path.join(dir, "customizations.md"), "utf8")).toBe("# Changes from the stock Dawn 15.4.0\n");
  });

  it("keeps a live site's store line as a live store, even for a development store", async () => {
    serveTemplate(OTHER_FILES);
    await writeProjectDocs(dir, { kind: "other", replaceThemeMd: false, details: { ...OTHER_DETAILS, devStore: true } });

    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toContain("- Store: mystore.myshopify.com (live store)");
  });

  it("leaves the stock theme for Claude when setup couldn't read it", async () => {
    serveTemplate(OTHER_FILES);
    await writeProjectDocs(dir, { kind: "other", replaceThemeMd: false, details: { ...OTHER_DETAILS, editTheme: { ...COPY, stock: undefined } } });

    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toContain("- Theme to edit: theme-copy-1, ID gid://shopify/OnlineStoreTheme/333\n");
    expect(await readFile(path.join(dir, "customizations.md"), "utf8")).toContain("[agent: insert the theme's name and version]");
  });

  it("keeps the THEME.md Claude wrote, updates the theme lines when run again, and blanks THEME.md only when asked", async () => {
    serveTemplate(OTHER_FILES);
    await writeFile(path.join(dir, "CLAUDE.md"), `${fillTemplate(OTHER_TEMPLATE, OTHER_DETAILS)}- My own rule\n`);
    await writeFile(path.join(dir, "THEME.md"), "# Dawn 15.4.0 spec");

    const kept = await writeProjectDocs(dir, { kind: "other", replaceThemeMd: false, details: OTHER_DETAILS });
    expect(kept.files.slice(0, 2)).toEqual([
      { name: "CLAUDE.md", action: "unchanged" },
      { name: "THEME.md", action: "kept" },
    ]);

    // Picking another copy updates the line, keeping the rest
    const other = { id: "gid://shopify/OnlineStoreTheme/444", name: "theme-copy-2", stock: "Dawn 15.4.0" };
    const switched = await writeProjectDocs(dir, { kind: "other", replaceThemeMd: false, details: { ...OTHER_DETAILS, editTheme: other } });
    expect(switched.files[0]).toEqual({ name: "CLAUDE.md", action: "updated" });
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("- Theme to edit: theme-copy-2 (Dawn 15.4.0), ID gid://shopify/OnlineStoreTheme/444\n");
    expect(claude).toContain("- Store: mystore.myshopify.com (live store)");
    expect(claude).toContain("- My own rule");

    const blanked = await writeProjectDocs(dir, { kind: "other", replaceThemeMd: true, details: OTHER_DETAILS });
    expect(blanked.files[1]).toEqual({ name: "THEME.md", action: "replaced" });
    expect(await readFile(path.join(dir, "THEME.md"), "utf8")).toBe("");
  });

  it("replaces a CLAUDE.md written for the other kind of theme", async () => {
    serveTemplate({ ...TEMPLATE_FILES, ...OTHER_FILES });
    await writeFile(path.join(dir, "CLAUDE.md"), fillTemplate(TEMPLATE, DETAILS));

    const toOther = await writeProjectDocs(dir, { kind: "other", replaceThemeMd: true, details: OTHER_DETAILS });
    expect(toOther.files[0]).toEqual({ name: "CLAUDE.md", action: "replaced" });
    expect(claudeMdKind(await readFile(path.join(dir, "CLAUDE.md"), "utf8"))).toBe("other");

    const toHorizon = await writeProjectDocs(dir, { kind: "horizon", replaceThemeMd: true, details: DETAILS });
    expect(toHorizon.files[0]).toEqual({ name: "CLAUDE.md", action: "replaced" });
    expect(claudeMdKind(await readFile(path.join(dir, "CLAUDE.md"), "utf8"))).toBe("horizon");
  });

  it("writes nothing when a template file is missing", async () => {
    serveTemplate({ "CLAUDE.md": TEMPLATE, "customizations.md": "log" });

    await expect(writeProjectDocs(dir, { kind: "horizon", replaceThemeMd: false, details: DETAILS })).rejects.toThrow("GitHub returned 404");
    await expect(readFile(path.join(dir, "CLAUDE.md"))).rejects.toThrow("ENOENT");
  });
});
