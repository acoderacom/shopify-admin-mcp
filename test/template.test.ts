import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLiveTheme, fillClaudeMd, listDocsVersions, writeProjectDocs, type ProjectDetails } from "../src/setup/template.js";
import { entry, gzipped, tar } from "./tar-helpers.js";

// The store lines of the template's CLAUDE.md
const TEMPLATE = `# Project

## Store
- Store: [agent: insert the store's myshopify.com domain] ([agent: insert "development store" or "live store"])
- Live theme: Horizon [agent: insert the live theme's Horizon version], ID [agent: insert the live theme's ID, gid://shopify/OnlineStoreTheme/…]
- Storefront password (visitor gate on development and password-protected stores): [agent: insert the password in backticks, or delete this line if the storefront has none]. The user enters it.

## Files in this folder
`;

const DETAILS: ProjectDetails = {
  store: "mystore.myshopify.com",
  devStore: true,
  liveTheme: { id: "gid://shopify/OnlineStoreTheme/111", version: "4.2.0" },
  passwordProtected: true,
  storefrontPassword: "pa$$word",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listDocsVersions", () => {
  it("reads the Horizon versions from the template's tags, newest first", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json([{ name: "horizon-4.2.0" }, { name: "draft" }, { name: "horizon-4.10.0" }, { name: "horizon-3.5.1" }])
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listDocsVersions()).resolves.toEqual(["4.10.0", "4.2.0", "3.5.1"]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.github.com/repos/acoderacom/claude-horizon/tags?per_page=100");
  });
});

describe("checkLiveTheme", () => {
  const horizon = (version?: string) => ({ name: "Horizon", themeName: "Horizon", version });

  it("matches a live Horizon version the template covers", () => {
    expect(checkLiveTheme(horizon("4.2.0"), "", ["4.2.0"])).toEqual({ status: "match", version: "4.2.0" });
    expect(checkLiveTheme(horizon("4.1.5"), "", ["4.2.0", "4.1.5"])).toEqual({ status: "match", version: "4.1.5" });
  });

  it("points an older or newer live theme at the newest template version", () => {
    expect(checkLiveTheme(horizon("4.1.3"), "", ["4.2.0", "4.0.0"])).toEqual({ status: "older", version: "4.1.3", templateVersion: "4.2.0" });
    expect(checkLiveTheme(horizon("4.10.0"), "", ["4.2.0"])).toEqual({ status: "newer", version: "4.10.0", templateVersion: "4.2.0" });
  });

  it("can't match a theme that isn't Horizon or that it can't read", () => {
    expect(checkLiveTheme({ name: "Dawn", themeName: "Dawn", version: "15.0.0" }, "", ["4.2.0"])).toEqual({
      status: "not-horizon",
      name: "Dawn",
      templateVersion: "4.2.0",
    });
    expect(checkLiveTheme(undefined, "Access denied for themes field", ["4.2.0"])).toEqual({
      status: "unknown",
      reason: "Access denied for themes field",
      templateVersion: "4.2.0",
    });
    expect(checkLiveTheme(horizon(), "", ["4.2.0"])).toMatchObject({ status: "unknown", reason: "its Horizon version couldn't be read" });
  });
});

describe("fillClaudeMd", () => {
  it("fills in the store, live theme and password", () => {
    expect(fillClaudeMd(TEMPLATE, DETAILS)).toContain(`## Store
- Store: mystore.myshopify.com (development store)
- Live theme: Horizon 4.2.0, ID gid://shopify/OnlineStoreTheme/111
- Storefront password (visitor gate on development and password-protected stores): \`pa$$word\`. The user enters it.
`);
  });

  it("leaves what setup doesn't know for Claude, and drops the password line when there's no password", () => {
    const filled = fillClaudeMd(TEMPLATE, { store: "mystore.myshopify.com", passwordProtected: false });

    expect(filled).toContain("- Store: mystore.myshopify.com ([agent: insert");
    expect(filled).toContain("- Live theme: Horizon [agent: insert the live theme's Horizon version], ID [agent:");
    expect(filled).not.toContain("Storefront password");
    // Unknown, so the line stays for Claude to ask about
    expect(fillClaudeMd(TEMPLATE, { store: "mystore.myshopify.com" })).toContain("[agent: insert the password");
  });

  it("updates a CLAUDE.md filled in earlier and keeps everything else", () => {
    const earlier = `${fillClaudeMd(TEMPLATE, DETAILS)}\n- My own rule\n`;
    const updated = fillClaudeMd(earlier, {
      store: "other.myshopify.com",
      devStore: false,
      liveTheme: { id: "gid://shopify/OnlineStoreTheme/222", version: "4.2.1" },
      storefrontPassword: "new",
    });

    expect(updated).toContain("- Store: other.myshopify.com (live store)");
    expect(updated).toContain("- Live theme: Horizon 4.2.1, ID gid://shopify/OnlineStoreTheme/222");
    expect(updated).toContain("stores): `new`. The user enters it.");
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

  const serveTemplate = (files: Record<string, string>) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      gzipped(tar(...Object.entries(files).map(([name, content]) => entry(`claude-horizon-horizon-4.2.0/${name}`, content))))
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const TEMPLATE_FILES = { "CLAUDE.md": TEMPLATE, "THEME.md": "spec 4.2.0", "customizations.md": "log", "README.md": "repo" };

  it("writes the three docs from the version's tag, with CLAUDE.md filled in", async () => {
    const fetchMock = serveTemplate(TEMPLATE_FILES);

    await expect(writeProjectDocs(dir, { docsVersion: "4.2.0", replaceThemeMd: false, details: DETAILS })).resolves.toEqual({
      files: [
        { name: "CLAUDE.md", action: "created" },
        { name: "THEME.md", action: "created" },
        { name: "customizations.md", action: "created" },
      ],
      placeholdersLeft: false,
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://github.com/acoderacom/claude-horizon/archive/horizon-4.2.0.tar.gz");
    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toContain("- Store: mystore.myshopify.com (development store)");
    expect(await readFile(path.join(dir, "THEME.md"), "utf8")).toBe("spec 4.2.0");
  });

  it("keeps the change log, and replaces THEME.md only when asked", async () => {
    serveTemplate(TEMPLATE_FILES);
    await writeFile(path.join(dir, "THEME.md"), "old spec");
    await writeFile(path.join(dir, "customizations.md"), "my changes");

    const kept = await writeProjectDocs(dir, { docsVersion: "4.2.0", replaceThemeMd: false, details: { store: "mystore.myshopify.com" } });
    expect(kept.files.slice(1)).toEqual([
      { name: "THEME.md", action: "kept" },
      { name: "customizations.md", action: "kept" },
    ]);
    expect(kept.placeholdersLeft).toBe(true);

    const replaced = await writeProjectDocs(dir, { docsVersion: "4.2.0", replaceThemeMd: true, details: DETAILS });
    expect(replaced.files).toEqual([
      { name: "CLAUDE.md", action: "updated" },
      { name: "THEME.md", action: "replaced" },
      { name: "customizations.md", action: "kept" },
    ]);
    expect(await readFile(path.join(dir, "THEME.md"), "utf8")).toBe("spec 4.2.0");
    expect(await readFile(path.join(dir, "customizations.md"), "utf8")).toBe("my changes");
  });

  it("writes nothing when the template is incomplete", async () => {
    serveTemplate({ "CLAUDE.md": TEMPLATE });

    await expect(writeProjectDocs(dir, { docsVersion: "4.2.0", replaceThemeMd: false, details: DETAILS })).rejects.toThrow(
      "The template is missing THEME.md, customizations.md"
    );
    await expect(readFile(path.join(dir, "CLAUDE.md"))).rejects.toThrow("ENOENT");
  });
});
