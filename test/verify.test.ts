import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCredentials } from "../src/setup/verify.js";

const AUTH = { mode: "access-token", accessToken: "shpat_test" } as const;
const SCHEMA = `[{ "name": "theme_info", "theme_name": "Horizon", "theme_version": "4.2.0" }]`;

// Answers the credentials check, then the store details query
function stubShopify(details: unknown, shop: Response = Response.json({ data: { shop: { name: "My Store" } } })) {
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) =>
    String(init?.body).includes("shop { name }") ? shop : Response.json(details)
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyCredentials", () => {
  it("reads the store type, the storefront password setting and the live theme", async () => {
    stubShopify({
      data: {
        shop: { plan: { partnerDevelopment: true } },
        onlineStore: { passwordProtection: { enabled: true } },
        themes: {
          nodes: [
            { id: "gid://shopify/OnlineStoreTheme/111", name: "Horizon", files: { nodes: [{ body: { content: SCHEMA } }] } },
          ],
        },
      },
    });

    await expect(verifyCredentials("mystore.myshopify.com", AUTH)).resolves.toEqual({
      ok: true,
      shopName: "My Store",
      devStore: true,
      passwordProtected: true,
      liveTheme: { id: "gid://shopify/OnlineStoreTheme/111", name: "Horizon", themeName: "Horizon", version: "4.2.0" },
    });
  });

  it("still connects when the app can't read themes, and says why", async () => {
    stubShopify({
      data: { shop: { plan: { partnerDevelopment: false } }, onlineStore: null, themes: null },
      errors: [{ message: "Access denied for themes field. Required access: `read_themes` access scope.", path: ["themes"] }],
    });

    const result = await verifyCredentials("mystore.myshopify.com", AUTH);
    expect(result).toMatchObject({ ok: true, shopName: "My Store", devStore: false, passwordProtected: undefined });
    expect(result.ok && result.liveThemeError).toContain("read_themes");
  });

  it("fails when the credentials are rejected", async () => {
    const fetchMock = stubShopify({}, new Response("Invalid API key or access token", { status: 401 }));

    const result = await verifyCredentials("mystore.myshopify.com", AUTH);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toContain("401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
