import { describe, expect, it } from "vitest";
import { createZip } from "../src/setup/zip.js";
import { readZip } from "./zip-helpers.js";

describe("createZip", () => {
  it("stores each file deflated, with its path and contents intact", () => {
    const big = Buffer.from("{% render 'icon' %}\n".repeat(500));
    const zip = createZip([
      { path: "layout/theme.liquid", data: Buffer.from("<html>{{ content_for_layout }}</html>") },
      { path: "assets/über.css", data: Buffer.from("body {}") },
      { path: "snippets/big.liquid", data: big },
      { path: "assets/empty.js", data: Buffer.alloc(0) },
    ]);

    const files = readZip(zip);
    expect([...files.keys()]).toEqual(["layout/theme.liquid", "assets/über.css", "snippets/big.liquid", "assets/empty.js"]);
    expect(files.get("layout/theme.liquid")!.toString()).toBe("<html>{{ content_for_layout }}</html>");
    expect(files.get("snippets/big.liquid")!.equals(big)).toBe(true);
    expect(files.get("assets/empty.js")!.length).toBe(0);
    // Deflate shrinks the repetitive file well below its size
    expect(zip.length).toBeLessThan(big.length / 4);
  });
});
