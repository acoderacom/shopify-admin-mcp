import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadHorizon, listHorizonVersions, type HorizonVersion } from "../src/setup/horizon.js";
import { entry, gzipped, tar } from "./tar-helpers.js";

const HORIZON: HorizonVersion = { version: "4.2.0", sha: "abc123", date: "2026-09-18T16:47:43Z" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listHorizonVersions", () => {
  it("reads versions from the release commits, newest first", async () => {
    const commit = (sha: string, message: string, date: string) => ({ sha, commit: { message, committer: { date } } });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json([
        commit("c5", "Horizon v4.2.0", "2026-09-18T16:47:43Z"),
        commit("c4", "Update the theme settings", "2026-09-10T10:00:00Z"),
        commit("c3", "Horizon v4.10.0\n\nRe-released", "2026-09-01T10:00:00Z"),
        commit("c2", "Horizon v4.2.0", "2026-08-01T10:00:00Z"),
        commit("c1", "Horizon v4.1.5", "2026-07-01T10:00:00Z"),
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listHorizonVersions()).resolves.toEqual([
      { version: "4.10.0", sha: "c3", date: "2026-09-01T10:00:00Z" },
      { version: "4.2.0", sha: "c5", date: "2026-09-18T16:47:43Z" },
      { version: "4.1.5", sha: "c1", date: "2026-07-01T10:00:00Z" },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/Shopify/horizon/commits?path=config/settings_schema.json&per_page=100");
    expect(init?.headers).toMatchObject({ "user-agent": "@acodera/shopify-admin-mcp" });
  });

  it("explains GitHub's rate limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }))
    );

    await expect(listHorizonVersions()).rejects.toThrow("GitHub's rate limit was reached");
  });
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
