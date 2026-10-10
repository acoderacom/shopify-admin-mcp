import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadHorizon, saveHorizonZip, type HorizonVersion } from "../src/setup/horizon.js";
import { entry, gzipped, tar } from "./tar-helpers.js";
import { readZip } from "./zip-helpers.js";

const HORIZON: HorizonVersion = { version: "4.2.0", sha: "abc123" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadHorizon", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shopify-mcp-horizon-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const serve = (archive: Buffer) => {
    const fetchMock = vi.fn<typeof fetch>(async () => gzipped(archive));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("unpacks the version into ./theme without GitHub's top folder, replacing what was there", async () => {
    await mkdir(path.join(dir, "theme"));
    await writeFile(path.join(dir, "theme", "old.liquid"), "old");
    const fetchMock = serve(
      tar(
        entry("horizon-abc123/", "", "5"),
        entry("horizon-abc123/layout/theme.liquid", "<html></html>"),
        entry("horizon-abc123/config/settings_schema.json", "[]")
      )
    );

    await expect(downloadHorizon(dir, HORIZON)).resolves.toEqual({ dir: path.join(dir, "theme"), files: 2 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://github.com/Shopify/horizon/archive/abc123.tar.gz");
    expect(await readFile(path.join(dir, "theme", "layout", "theme.liquid"), "utf8")).toBe("<html></html>");
    expect(existsSync(path.join(dir, "theme", "old.liquid"))).toBe(false);
    expect(await readdir(dir)).toEqual(["theme"]);
  });

  it("refuses paths that leave the theme folder and keeps the existing one", async () => {
    await mkdir(path.join(dir, "theme"));
    await writeFile(path.join(dir, "theme", "old.liquid"), "old");
    serve(tar(entry("horizon-abc123/layout/theme.liquid", "ok"), entry("horizon-abc123/../evil.liquid", "evil")));

    await expect(downloadHorizon(dir, HORIZON)).rejects.toThrow("unexpected path");
    expect(await readFile(path.join(dir, "theme", "old.liquid"), "utf8")).toBe("old");
    expect(await readdir(dir)).toEqual(["theme"]);
  });

  it("reports a failed download", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("", { status: 404 })));

    await expect(downloadHorizon(dir, HORIZON)).rejects.toThrow("GitHub returned 404");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("saveHorizonZip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shopify-mcp-zip-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saves the version as horizon-<version>.zip with the theme folders at the top level", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      gzipped(tar(entry("horizon-abc123/layout/theme.liquid", "<html></html>"), entry("horizon-abc123/config/settings_schema.json", "[]")))
    );
    vi.stubGlobal("fetch", fetchMock);

    const saved = await saveHorizonZip(dir, HORIZON);

    expect(saved).toBe(path.join(dir, "horizon-4.2.0.zip"));
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://github.com/Shopify/horizon/archive/abc123.tar.gz");
    const files = readZip(await readFile(saved));
    expect([...files.keys()]).toEqual(["layout/theme.liquid", "config/settings_schema.json"]);
    expect(files.get("layout/theme.liquid")!.toString()).toBe("<html></html>");
    expect(await readdir(dir)).toEqual(["horizon-4.2.0.zip"]);
  });

  it("refuses a download that isn't a theme", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => gzipped(tar(entry("horizon-abc123/README.md", "hi")))));

    await expect(saveHorizonZip(dir, HORIZON)).rejects.toThrow("no layout/theme.liquid");
    expect(await readdir(dir)).toEqual([]);
  });
});
