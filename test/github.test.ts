import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRaw, readTar } from "../src/setup/github.js";
import { entry, paxPath, tar } from "./tar-helpers.js";

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

describe("githubRaw", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a file from raw.githubusercontent.com", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubRaw("acoderacom/claude-horizon", "main", "versions.json")).resolves.toBe("{}");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://raw.githubusercontent.com/acoderacom/claude-horizon/main/versions.json");
  });

  it("explains GitHub's rate limit and other failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }))
    );
    await expect(githubRaw("o/r", "main", "f")).rejects.toThrow("GitHub's rate limit was reached");

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("", { status: 404 })));
    await expect(githubRaw("o/r", "main", "f")).rejects.toThrow("GitHub returned 404");
  });
});
