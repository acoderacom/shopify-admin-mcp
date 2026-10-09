import { describe, expect, it } from "vitest";
import { callTool, connect, resultText } from "./helpers.js";

const THEME = "gid://shopify/OnlineStoreTheme/1";
const themeLookup = (role: string) => ({ data: { theme: { id: THEME, name: "Horizon", role } } });

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
    expect(fake.lastCall.query).toContain("themeFilesUpsert(");
    expect(fake.lastCall.variables).toEqual({
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
    expect(fake.lastCall.query).toContain("themeFilesUpsert(");
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
  ])("requires exactly one body per file: %j", async (file) => {
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
