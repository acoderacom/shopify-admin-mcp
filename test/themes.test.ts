import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, connect, resultText, type RecordedCall } from "./helpers.js";

vi.mock("../src/utils/sleep.js", () => ({ sleep: async () => {} }));

const THEME = "gid://shopify/OnlineStoreTheme/1";
const JOB = "gid://shopify/Job/1";
const themeLookup = (role: string) => ({ data: { theme: { id: THEME, name: "Horizon", role } } });
const upserted = (filenames: string[]) => ({
  data: { themeFilesUpsert: { upsertedThemeFiles: filenames.map((filename) => ({ filename })), job: { id: JOB }, userErrors: [] } },
});
const jobDone = { data: { job: { done: true } } };
const checksums = (files: Record<string, string>) => ({
  data: { theme: { files: { nodes: Object.entries(files).map(([filename, checksumMd5]) => ({ filename, checksumMd5 })) } } },
});
const md5 = (data: string | Buffer) => createHash("md5").update(data).digest("hex");
const upsertCall = (calls: RecordedCall[]) => calls.find((call) => call.query.includes("themeFilesUpsert("));
const output = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

describe("shopify_theme_files_upsert", () => {
  it("maps text, base64, and URL bodies onto the theme file input", async () => {
    const { client, fake } = await connect();
    fake.responses.push(themeLookup("UNPUBLISHED"));

    const result = await callTool(client, "shopify_theme_files_upsert", {
      themeId: THEME,
      files: [
        { filename: "snippets/note.liquid", content: "{{ shop.name }}" },
        { filename: "assets/logo.png", contentBase64: "iVBORw0KGgo=" },
        { filename: "assets/hero.jpg", url: "https://cdn.example.com/hero.jpg" },
      ],
    });

    expect(result.isError, resultText(result)).toBeFalsy();
    expect(upsertCall(fake.calls)?.variables).toEqual({
      themeId: THEME,
      files: [
        { filename: "snippets/note.liquid", body: { type: "TEXT", value: "{{ shop.name }}" } },
        { filename: "assets/logo.png", body: { type: "BASE64", value: "iVBORw0KGgo=" } },
        { filename: "assets/hero.jpg", body: { type: "URL", value: "https://cdn.example.com/hero.jpg" } },
      ],
    });
  });

  it("refuses to write to the live theme by default", async () => {
    const { client, fake } = await connect();
    fake.responses.push(themeLookup("MAIN"));

    const result = await callTool(client, "shopify_theme_files_upsert", {
      themeId: THEME,
      files: [{ filename: "snippets/note.liquid", content: "x" }],
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("shopify_theme_duplicate");
    expect(fake.calls).toHaveLength(1);
  });

  it("writes to the live theme when the server allows it", async () => {
    const { client, fake } = await connect({ allowLiveThemeWrites: true });
    fake.responses.push(themeLookup("MAIN"));

    const result = await callTool(client, "shopify_theme_files_upsert", {
      themeId: THEME,
      files: [{ filename: "snippets/note.liquid", content: "x" }],
    });

    expect(result.isError).toBeFalsy();
    expect(upsertCall(fake.calls)).toBeDefined();
  });

  it("reports an unknown theme", async () => {
    const { client, fake } = await connect();
    fake.responses.push({ data: { theme: null } });

    const result = await callTool(client, "shopify_theme_files_upsert", {
      themeId: THEME,
      files: [{ filename: "a.liquid", content: "x" }],
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("not found");
  });

  it.each([
    [{ filename: "a.liquid" }],
    [{ filename: "a.liquid", content: "x", url: "https://example.com/a" }],
  ])("requires one body per file when there's no theme folder: %j", async (file) => {
    const { client, fake } = await connect();
    const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [file] });

    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("shopify_theme_files_delete", () => {
  it("deletes files from an unpublished theme", async () => {
    const { client, fake } = await connect();
    fake.responses.push(themeLookup("UNPUBLISHED"));

    await callTool(client, "shopify_theme_files_delete", { themeId: THEME, filenames: ["snippets/note.liquid"] });

    expect(fake.lastCall.query).toContain("themeFilesDelete(");
    expect(fake.lastCall.variables).toEqual({ themeId: THEME, files: ["snippets/note.liquid"] });
  });

  it("refuses to delete from the live theme by default", async () => {
    const { client, fake } = await connect();
    fake.responses.push(themeLookup("MAIN"));

    const result = await callTool(client, "shopify_theme_files_delete", { themeId: THEME, filenames: ["layout/theme.liquid"] });

    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("shopify_graphql and the live theme", () => {
  const upsert = (themeId: string) =>
    `mutation { themeFilesUpsert(themeId: "${themeId}", files: [{ filename: "a.liquid", body: { type: TEXT, value: "x" } }]) { userErrors { message } } }`;

  it("refuses theme file writes to the live theme", async () => {
    const { client, fake } = await connect();
    fake.responses.push(themeLookup("MAIN"));

    const result = await callTool(client, "shopify_graphql", {
      query: "mutation ($id: ID!) { themeFilesDelete(themeId: $id, files: [\"layout/theme.liquid\"]) { userErrors { message } } }",
      variables: { id: THEME },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("is the live theme");
    expect(fake.calls).toHaveLength(1);
    expect(fake.lastCall.variables).toEqual({ id: THEME });
  });

  it("forwards theme file writes to an unpublished theme", async () => {
    const { client, fake } = await connect();
    fake.responses.push(themeLookup("UNPUBLISHED"));

    const result = await callTool(client, "shopify_graphql", { query: upsert(THEME) });

    expect(result.isError, resultText(result)).toBeFalsy();
    expect(fake.calls).toHaveLength(2);
    expect(fake.lastCall.query).toContain("themeFilesUpsert(");
  });

  it("checks every theme a document writes to, including through fragments", async () => {
    const { client, fake } = await connect();
    fake.responses.push(themeLookup("UNPUBLISHED"), themeLookup("MAIN"));
    const query = `mutation { ...Copy ... on Mutation { a: themeFilesUpsert(themeId: "gid://shopify/OnlineStoreTheme/2", files: []) { userErrors { message } } } }
      fragment Copy on Mutation { themeFilesCopy(themeId: "${THEME}", files: []) { userErrors { message } } }`;

    const result = await callTool(client, "shopify_graphql", { query });

    expect(result.isError).toBe(true);
    expect(fake.calls.map((c) => c.variables)).toEqual([
      { id: THEME },
      { id: "gid://shopify/OnlineStoreTheme/2" },
    ]);
  });

  it("refuses publishing a theme", async () => {
    const { client, fake } = await connect();
    const result = await callTool(client, "shopify_graphql", {
      query: `mutation { themePublish(id: "${THEME}") { theme { id } } }`,
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("--allow-live-theme-writes");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses theme file writes whose theme can't be determined", async () => {
    const { client, fake } = await connect();
    const result = await callTool(client, "shopify_graphql", {
      query: "mutation ($id: ID!) { themeFilesUpsert(themeId: $id, files: []) { userErrors { message } } }",
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Couldn't determine which theme");
    expect(fake.calls).toHaveLength(0);
  });

  it("doesn't look up themes for other mutations", async () => {
    const { client, fake } = await connect();
    await callTool(client, "shopify_graphql", {
      query: 'mutation { productDelete(input: { id: "gid://shopify/Product/1" }) { deletedProductId } }',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("allows live theme writes and publishing when the server allows them", async () => {
    const { client, fake } = await connect({ allowLiveThemeWrites: true });
    await callTool(client, "shopify_graphql", { query: upsert(THEME) });
    await callTool(client, "shopify_graphql", { query: `mutation { themePublish(id: "${THEME}") { theme { id } } }` });

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((c) => !c.query.includes("theme(id:"))).toBe(true);
  });
});

describe("shopify_theme_files_get", () => {
  const files = (userErrors: unknown[]) => ({
    data: { theme: { id: THEME, name: "Horizon", role: "MAIN", files: { nodes: [], pageInfo: { hasNextPage: false }, userErrors } } },
  });

  it("flags files that couldn't be read", async () => {
    const { client, fake } = await connect();
    fake.responses.push(files([{ code: "NOT_FOUND", filename: "sections/missing.liquid" }]));

    const result = await callTool(client, "shopify_theme_files_get", { themeId: THEME, filenames: ["sections/missing.liquid"] });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("sections/missing.liquid");
  });

  it("doesn't flag an empty userErrors list", async () => {
    const { client, fake } = await connect();
    fake.responses.push(files([]));

    const result = await callTool(client, "shopify_theme_files_get", { themeId: THEME, filenames: ["layout/theme.liquid"] });
    expect(result.isError).toBeFalsy();
  });
});

describe("with theme edits disabled", () => {
  it("registers only the tools that read themes", async () => {
    const { client } = await connect({ disableThemeWrites: true, allowLiveThemeWrites: true });

    const names = (await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes("theme"));
    expect(names.sort()).toEqual(["shopify_theme_files_get", "shopify_theme_files_list", "shopify_themes_list"]);
  });

  it("refuses every theme mutation in raw GraphQL, without asking Shopify", async () => {
    const { client, fake } = await connect({ disableThemeWrites: true, allowLiveThemeWrites: true });

    for (const query of [
      `mutation { themeFilesUpsert(themeId: "${THEME}", files: [{ filename: "a.liquid", body: { type: TEXT, value: "x" } }]) { userErrors { message } } }`,
      `mutation { themeCreate(source: "https://example.com/theme.zip", name: "Copy") { theme { id } } }`,
      `mutation Spread { ...Publish } fragment Publish on Mutation { themePublish(id: "${THEME}") { theme { id } } }`,
    ]) {
      const result = await callTool(client, "shopify_graphql", { query });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("theme edits are disabled on this server");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("still forwards queries and other mutations", async () => {
    const { client, fake } = await connect({ disableThemeWrites: true });
    fake.responses.push({ data: { themes: { nodes: [] } } }, { data: { productDelete: { deletedProductId: null } } });

    const read = await callTool(client, "shopify_graphql", { query: "{ themes(first: 5) { nodes { id } } }" });
    const write = await callTool(client, "shopify_graphql", {
      query: 'mutation { productDelete(input: { id: "gid://shopify/Product/1" }) { deletedProductId } }',
    });

    expect(read.isError, resultText(read)).toBeFalsy();
    expect(write.isError, resultText(write)).toBeFalsy();
    expect(fake.calls).toHaveLength(2);
  });
});

describe("theme files and the local theme folder", () => {
  const NOTE = "{{ 'cx.note' | t }}\n";
  // Bytes that aren't UTF-8 text, as in an image
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff]);
  let root: string;
  let themeDir: string;
  let outside: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "shopify-mcp-theme-")));
    themeDir = path.join(root, "theme");
    outside = path.join(root, "outside");
    await mkdir(path.join(themeDir, "snippets"), { recursive: true });
    await mkdir(path.join(themeDir, "assets"));
    await mkdir(path.join(themeDir, "config"));
    await mkdir(outside);
    await writeFile(path.join(themeDir, "snippets/note.liquid"), NOTE);
    await writeFile(path.join(themeDir, "assets/logo.png"), PNG);
    await writeFile(path.join(themeDir, "config/settings_data.json"), '{"current":{"page_width":"narrow"}}');
    await writeFile(path.join(outside, "secret.liquid"), "secret");
    await symlink(path.join(outside, "secret.liquid"), path.join(themeDir, "snippets/link.liquid"));
    await symlink(outside, path.join(themeDir, "blocks"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  describe("shopify_theme_files_upsert", () => {
    it("sends files from the theme folder by filename, as text or base64, and confirms Shopify stored them", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(
        themeLookup("UNPUBLISHED"),
        upserted(["snippets/note.liquid", "assets/logo.png"]),
        jobDone,
        checksums({ "snippets/note.liquid": md5(NOTE), "assets/logo.png": md5(PNG) })
      );

      const result = await callTool(client, "shopify_theme_files_upsert", {
        themeId: THEME,
        files: [{ filename: "snippets/note.liquid" }, { filename: "assets/logo.png" }],
      });

      expect(result.isError, resultText(result)).toBeFalsy();
      expect(upsertCall(fake.calls)?.variables?.files).toEqual([
        { filename: "snippets/note.liquid", body: { type: "TEXT", value: NOTE } },
        { filename: "assets/logo.png", body: { type: "BASE64", value: PNG.toString("base64") } },
      ]);
      expect(fake.calls[2]).toEqual({ query: expect.stringContaining("job(id: $id)"), variables: { id: JOB } });
      expect(output(result).files).toEqual([
        { filename: "snippets/note.liquid", source: "theme folder", checksumMd5: md5(NOTE), stored: "as sent" },
        { filename: "assets/logo.png", source: "theme folder", checksumMd5: md5(PNG), stored: "as sent" },
      ]);
    });

    it("mixes files from the folder with files passed as content", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(
        themeLookup("UNPUBLISHED"),
        upserted(["snippets/note.liquid", "snippets/new.liquid"]),
        jobDone,
        checksums({ "snippets/note.liquid": md5(NOTE), "snippets/new.liquid": md5("new") })
      );

      const result = await callTool(client, "shopify_theme_files_upsert", {
        themeId: THEME,
        files: [{ filename: "snippets/note.liquid" }, { filename: "snippets/new.liquid", content: "new" }],
      });

      expect(output(result).files.map((f: { source: string; stored: string }) => [f.source, f.stored])).toEqual([
        ["theme folder", "as sent"],
        ["content", "as sent"],
      ]);
    });

    it("explains how to turn the theme folder on when a file has no content", async () => {
      const { client, fake } = await connect();
      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "snippets/note.liquid" }] });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("--theme-dir");
      expect(fake.calls).toHaveLength(0);
    });

    it.each([
      ["a path that climbs out", "snippets/../../outside/secret.liquid"],
      ["an absolute path", path.join("/", "etc", "passwd")],
      ["a symlink to a file outside", "snippets/link.liquid"],
      ["a symlinked folder", "blocks/secret.liquid"],
      ["a folder that isn't a theme folder", "notes/todo.liquid"],
      ["a file at the top of the folder", "README.md"],
      ["a Windows separator", "snippets\\note.liquid"],
    ])("refuses %s before contacting Shopify", async (_case, filename) => {
      const { client, fake } = await connect({ themeDir });
      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename }] });

      expect(result.isError, resultText(result)).toBe(true);
      expect(resultText(result)).not.toContain("secret\"");
      expect(fake.calls).toHaveLength(0);
    });

    it("reports a file that isn't in the folder", async () => {
      const { client, fake } = await connect({ themeDir });
      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "snippets/missing.liquid" }] });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("snippets/missing.liquid isn't in the theme folder");
      expect(fake.calls).toHaveLength(0);
    });

    it("reports a theme folder that doesn't exist", async () => {
      const { client } = await connect({ themeDir: path.join(root, "gone") });
      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "snippets/note.liquid" }] });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("doesn't exist");
    });

    it("replaces a folder file that Shopify stored differently with Shopify's copy", async () => {
      const rebuilt = '{\n  "current": {\n    "page_width": "narrow"\n  }\n}';
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(
        themeLookup("UNPUBLISHED"),
        upserted(["config/settings_data.json"]),
        jobDone,
        checksums({ "config/settings_data.json": "0000" }),
        { data: { theme: { files: { nodes: [{ filename: "config/settings_data.json", body: { content: rebuilt } }] } } } }
      );

      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "config/settings_data.json" }] });

      expect(result.isError, resultText(result)).toBeFalsy();
      expect(output(result).files[0]).toMatchObject({ stored: "changed by Shopify", themeFolder: "updated to Shopify's copy" });
      expect(await readFile(path.join(themeDir, "config/settings_data.json"), "utf8")).toBe(rebuilt);
    });

    it("updates a JSON file that Shopify stored as sent but returns regenerated", async () => {
      const template = '{"sections":{},"order":[]}';
      const served = `/* generated by Shopify */\n{\n  "sections": {},\n  "order": []\n}\n`;
      await mkdir(path.join(themeDir, "templates"));
      await writeFile(path.join(themeDir, "templates/page.faq.json"), template);
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(
        themeLookup("UNPUBLISHED"),
        upserted(["templates/page.faq.json"]),
        jobDone,
        checksums({ "templates/page.faq.json": md5(template) }),
        { data: { theme: { files: { nodes: [{ filename: "templates/page.faq.json", body: { content: served } }] } } } }
      );

      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "templates/page.faq.json" }] });

      expect(output(result).files[0]).toMatchObject({ stored: "changed by Shopify", themeFolder: "updated to Shopify's copy" });
      expect(await readFile(path.join(themeDir, "templates/page.faq.json"), "utf8")).toBe(served);
    });

    it("counts a file as stored when its content matches though the checksum doesn't", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(
        themeLookup("UNPUBLISHED"),
        upserted(["snippets/note.liquid"]),
        jobDone,
        checksums({ "snippets/note.liquid": "0000" }),
        { data: { theme: { files: { nodes: [{ filename: "snippets/note.liquid", body: { content: NOTE } }] } } } }
      );

      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "snippets/note.liquid" }] });
      expect(output(result).files[0].stored).toBe("as sent");
    });

    it("doesn't write anything locally for a file passed as content", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(
        themeLookup("UNPUBLISHED"),
        upserted(["snippets/note.liquid"]),
        jobDone,
        checksums({ "snippets/note.liquid": "0000" }),
        { data: { theme: { files: { nodes: [{ filename: "snippets/note.liquid", body: { content: "changed" } }] } } } }
      );

      const result = await callTool(client, "shopify_theme_files_upsert", {
        themeId: THEME,
        files: [{ filename: "snippets/note.liquid", content: "sent" }],
      });

      expect(output(result).files[0]).toEqual({ filename: "snippets/note.liquid", source: "content", checksumMd5: md5("sent"), stored: "changed by Shopify" });
      expect(await readFile(path.join(themeDir, "snippets/note.liquid"), "utf8")).toBe(NOTE);
    });

    it("reports files as pending when the upsert job doesn't finish", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(themeLookup("UNPUBLISHED"), upserted(["snippets/note.liquid"]));

      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "snippets/note.liquid" }] });

      expect(result.isError).toBeFalsy();
      expect(output(result).files[0].stored).toBe("pending");
      expect(fake.calls.filter((call) => call.query.includes("job(id:"))).toHaveLength(30);
    });

    it("keeps the write's result when checking what was stored fails", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(themeLookup("UNPUBLISHED"), upserted(["snippets/note.liquid"]), jobDone, new Error("socket hang up"));

      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "snippets/note.liquid" }] });

      expect(result.isError).toBeFalsy();
      expect(output(result).files[0]).toMatchObject({ stored: "not checked", error: "socket hang up" });
    });

    it("doesn't check URL bodies, since their bytes aren't known", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(themeLookup("UNPUBLISHED"), upserted(["assets/hero.jpg"]));

      const result = await callTool(client, "shopify_theme_files_upsert", {
        themeId: THEME,
        files: [{ filename: "assets/hero.jpg", url: "https://cdn.example.com/hero.jpg" }],
      });

      expect(output(result).files).toEqual([{ filename: "assets/hero.jpg", source: "url", stored: "not checked" }]);
      expect(fake.calls).toHaveLength(2);
    });

    it("returns Shopify's errors without checking anything", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(themeLookup("UNPUBLISHED"), {
        data: { themeFilesUpsert: { upsertedThemeFiles: [], job: null, userErrors: [{ message: "Liquid syntax error", filename: "snippets/note.liquid" }] } },
      });

      const result = await callTool(client, "shopify_theme_files_upsert", { themeId: THEME, files: [{ filename: "snippets/note.liquid" }] });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Liquid syntax error");
      expect(fake.calls).toHaveLength(2);
    });
  });

  describe("shopify_theme_files_pull", () => {
    const pulled = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({
      data: {
        theme: {
          id: THEME,
          name: "Horizon",
          role: "MAIN",
          files: { nodes, pageInfo: { hasNextPage: false, endCursor: null }, userErrors: [], ...extra },
        },
      },
    });

    it("is offered only with a theme folder, stays when theme edits are off, and isn't in read-only mode", async () => {
      const names = async (options: Parameters<typeof connect>[0]) =>
        (await (await connect(options)).client.listTools()).tools.map((tool) => tool.name);

      expect(await names({})).not.toContain("shopify_theme_files_pull");
      expect(await names({ themeDir })).toContain("shopify_theme_files_pull");
      expect(await names({ themeDir, disableThemeWrites: true })).toContain("shopify_theme_files_pull");
      expect(await names({ themeDir, readOnly: true })).not.toContain("shopify_theme_files_pull");
    });

    it("writes files into the theme folder without returning their content, leaving matching files alone", async () => {
      const { client, fake } = await connect({ themeDir });
      const account = '{"sections":{}}';
      fake.responses.push(
        pulled([
          { filename: "snippets/note.liquid", body: { content: NOTE } },
          { filename: "snippets/new.liquid", body: { content: "{% render 'note' %}" } },
          { filename: "assets/icon.png", body: { contentBase64: PNG.toString("base64") } },
          { filename: "templates/customers/account.json", body: { content: account } },
        ])
      );

      const result = await callTool(client, "shopify_theme_files_pull", { themeId: THEME, filenames: ["snippets/*", "assets/icon.png", "templates/*"] });

      expect(result.isError, resultText(result)).toBeFalsy();
      expect(fake.lastCall.variables).toEqual({ id: THEME, filenames: ["snippets/*", "assets/icon.png", "templates/*"], after: undefined });
      expect(output(result).files.map((f: { filename: string; status: string }) => [f.filename, f.status])).toEqual([
        ["snippets/note.liquid", "unchanged"],
        ["snippets/new.liquid", "written"],
        ["assets/icon.png", "written"],
        ["templates/customers/account.json", "written"],
      ]);
      expect(resultText(result)).not.toContain("render 'note'");
      expect(await readFile(path.join(themeDir, "snippets/new.liquid"), "utf8")).toBe("{% render 'note' %}");
      expect(await readFile(path.join(themeDir, "assets/icon.png"))).toEqual(PNG);
      expect(await readFile(path.join(themeDir, "templates/customers/account.json"), "utf8")).toBe(account);
    });

    it("downloads URL bodies from Shopify's hosts only", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(PNG));
      vi.stubGlobal("fetch", fetchMock);
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(
        pulled([
          { filename: "assets/photo.png", body: { url: "https://cdn.shopify.com/s/files/1/photo.png" } },
          { filename: "assets/other.png", body: { url: "https://example.com/other.png" } },
        ])
      );

      const result = await callTool(client, "shopify_theme_files_pull", { themeId: THEME, filenames: ["assets/*"] });

      expect(result.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(themeDir, "assets/photo.png"))).toEqual(PNG);
      expect(output(result).files[1]).toMatchObject({ filename: "assets/other.png", status: "skipped", error: expect.stringContaining("isn't a Shopify host") });
    });

    it("never writes outside the theme folder", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(
        pulled([
          { filename: "snippets/../../outside/escape.liquid", body: { content: "x" } },
          { filename: "blocks/escape.liquid", body: { content: "x" } },
          { filename: "snippets/link.liquid", body: { content: "x" } },
        ])
      );

      const result = await callTool(client, "shopify_theme_files_pull", { themeId: THEME, filenames: ["*"] });

      expect(result.isError).toBe(true);
      expect(output(result).files.every((f: { status: string }) => f.status === "skipped")).toBe(true);
      expect(await readFile(path.join(outside, "secret.liquid"), "utf8")).toBe("secret");
      await expect(readFile(path.join(outside, "escape.liquid"))).rejects.toThrow("ENOENT");
    });

    it("passes the cursor on and reports more pages", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(pulled([], { pageInfo: { hasNextPage: true, endCursor: "c2" } }));

      const result = await callTool(client, "shopify_theme_files_pull", { themeId: THEME, filenames: ["sections/*"], after: "c1" });

      expect(fake.lastCall.variables).toMatchObject({ after: "c1" });
      expect(output(result).pageInfo).toEqual({ hasNextPage: true, endCursor: "c2" });
    });

    it("flags files Shopify couldn't read and an unknown theme", async () => {
      const { client, fake } = await connect({ themeDir });
      fake.responses.push(pulled([], { userErrors: [{ code: "NOT_FOUND", filename: "sections/missing.liquid" }] }), { data: { theme: null } });

      const missing = await callTool(client, "shopify_theme_files_pull", { themeId: THEME, filenames: ["sections/missing.liquid"] });
      expect(missing.isError).toBe(true);
      expect(resultText(missing)).toContain("sections/missing.liquid");

      const unknown = await callTool(client, "shopify_theme_files_pull", { themeId: THEME, filenames: ["layout/theme.liquid"] });
      expect(unknown.isError).toBe(true);
      expect(resultText(unknown)).toContain("not found");
    });
  });

  it("tells the client about the theme folder", async () => {
    expect((await connect({ themeDir })).client.getInstructions()).toContain(`local folder ${themeDir}`);
    expect((await connect({ themeDir, readOnly: true })).client.getInstructions()).not.toContain("local folder");
    expect((await connect({ themeDir, toolsets: ["products"] })).client.getInstructions()).not.toContain("local folder");
  });
});
