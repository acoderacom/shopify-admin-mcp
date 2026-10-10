import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadHorizon, listHorizonVersions, readTar, type HorizonVersion } from "../src/setup/horizon.js";

// Builds tar archives the way git archive does: ustar headers, plus pax headers where needed
function header(name: string, size: number, type: string, prefix = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156);
  block.write("ustar\u000000", 257);
  block.write(prefix, 345, 155);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function entry(name: string, content: string | Buffer, type = "0", prefix = ""): Buffer {
  const data = Buffer.from(content);
  return Buffer.concat([header(name, data.length, type, prefix), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function paxPath(value: string): Buffer {
  const body = ` path=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length++;
  return entry("PaxHeader", `${length}${body}`, "x");
}

const tar = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);

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

describe("readTar", () => {
  it("reads regular files, with long paths from ustar prefixes and pax headers", () => {
    const longName = `snippets/${"a".repeat(120)}.liquid`;
    const files = readTar(
      tar(
        entry("pax_global_header", "52 comment=abc123\n", "g"),
        entry("horizon-abc/", "", "5"),
        entry("horizon-abc/layout/theme.liquid", "<html></html>"),
        entry("gift-card-recipient.liquid", "{{ gift }}", "0", "horizon-abc/snippets"),
        paxPath(`horizon-abc/${longName}`),
        entry("horizon-abc/snippets/aaaa", "long"),
        entry("horizon-abc/link", "", "2")
      )
    );

    expect(files.map((file) => [file.path, file.data.toString()])).toEqual([
      ["horizon-abc/layout/theme.liquid", "<html></html>"],
      ["horizon-abc/snippets/gift-card-recipient.liquid", "{{ gift }}"],
      [`horizon-abc/${longName}`, "long"],
    ]);
  });

  it("rejects a damaged or cut-off archive", () => {
    const archive = tar(entry("horizon-abc/layout/theme.liquid", "<html></html>"));
    const damaged = Buffer.from(archive);
    damaged[10] = 0x41;

    expect(() => readTar(damaged)).toThrow("The archive is damaged");
    expect(() => readTar(archive.subarray(0, 700))).toThrow("The archive ended early");
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
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(gzipSync(archive)));
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
