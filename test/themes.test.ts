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
