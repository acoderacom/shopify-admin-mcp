import { describe, expect, it } from "vitest";
import { readTar } from "../src/setup/github.js";
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
