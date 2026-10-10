import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAdminNode, checkDevMcpNode } from "../src/setup/node-version.js";

const manifest = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkAdminNode", () => {
  it("uses this package's engines requirement", () => {
    expect(checkAdminNode("22.12.0")).toEqual({ label: "shopify-admin-mcp", range: ">=22.12.0", ok: true });
    expect(checkAdminNode("20.19.0").ok).toBe(false);
  });
});

describe("checkDevMcpNode", () => {
  it("includes the requirement of the @shopify/cli dependency when the package declares none", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("dev-mcp")
        ? manifest({ version: "1.16.0", dependencies: { "@shopify/cli": ">=3.93.1" } })
        : manifest({ version: "3.94.0", engines: { node: ">=22.12.0" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkDevMcpNode("24.15.0")).resolves.toEqual({ label: "Shopify Dev MCP", range: ">=22.12.0", ok: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://registry.npmjs.org/@shopify%2fdev-mcp/latest",
      "https://registry.npmjs.org/@shopify%2fcli/latest",
    ]);
  });

  it("shows the strictest requirement and fails when any isn't met", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) =>
        String(url).includes("dev-mcp")
          ? manifest({ engines: { node: ">=18" }, dependencies: { "@shopify/cli": "*" } })
          : manifest({ engines: { node: ">=22.12.0" } })
      )
    );

    await expect(checkDevMcpNode("20.19.0")).resolves.toEqual({ label: "Shopify Dev MCP", range: ">=22.12.0", ok: false });
  });

  it("falls back to the last known requirement when npm can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("fetch failed"))));

    const check = await checkDevMcpNode("24.15.0");
    expect(check).toMatchObject({ range: ">=22.12.0", ok: true });
    expect(check.note).toContain("couldn't reach npm");
  });
});
