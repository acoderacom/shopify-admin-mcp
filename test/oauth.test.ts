import { createHmac } from "node:crypto";
import { createServer, request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_PORT,
  REDIRECT_URI,
  approveInBrowser,
  authorizeUrl,
  exchangeCode,
  verifyCallback,
  type ApprovalInput,
} from "../src/setup/oauth.js";

const INPUT: ApprovalInput = { store: "mystore.myshopify.com", clientId: "client-id", clientSecret: "shpss_secret", scopes: "" };

// Signs callback parameters the way Shopify does: sorted key=value pairs, HMAC-SHA256 with the secret
function signed(params: Record<string, string>, secret = INPUT.clientSecret): URLSearchParams {
  const message = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return new URLSearchParams({ ...params, hmac: createHmac("sha256", secret).update(message).digest("hex") });
}

const callback = (state: string, overrides: Record<string, string> = {}) =>
  signed({ code: "auth-code", host: "YWRtaW4", shop: INPUT.store, state, timestamp: "1760000000", ...overrides });

// What the browser does after the approval: a GET to the redirect URI on localhost
function browserGet(query: URLSearchParams): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(`http://127.0.0.1:${OAUTH_PORT}/auth/callback?${query}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on("error", reject)
      .end();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorizeUrl", () => {
  it("asks the store to approve the app, redirecting to the local callback", () => {
    const url = new URL(authorizeUrl(INPUT, "nonce"));
    expect(url.origin + url.pathname).toBe("https://mystore.myshopify.com/admin/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "client-id", redirect_uri: REDIRECT_URI, state: "nonce" });
    expect(REDIRECT_URI).toBe("http://localhost:3457/auth/callback");
  });

  it("requests scopes only when some are given", () => {
    const url = new URL(authorizeUrl({ ...INPUT, scopes: " read_themes,write_themes " }, "nonce"));
    expect(url.searchParams.get("scope")).toBe("read_themes,write_themes");
  });
});

describe("verifyCallback", () => {
  it("accepts Shopify's signed callback and returns the code", () => {
    expect(verifyCallback(callback("nonce"), INPUT, "nonce")).toBe("auth-code");
  });

  it("refuses a wrong signature, state, store, or a missing code", () => {
    expect(() => verifyCallback(signed(Object.fromEntries(callback("nonce")), "other-secret"), INPUT, "nonce")).toThrow(
      "signature didn't match"
    );
    expect(() => verifyCallback(callback("other"), INPUT, "nonce")).toThrow("state mismatch");
    expect(() => verifyCallback(callback("nonce", { shop: "evil.myshopify.com" }), INPUT, "nonce")).toThrow(
      "came back for evil.myshopify.com"
    );
    expect(() => verifyCallback(callback("nonce", { shop: "mystore.myshopify.com.evil.example" }), INPUT, "nonce")).toThrow(
      "not mystore.myshopify.com"
    );
    const noCode = Object.fromEntries(callback("nonce"));
    delete noCode.code;
    delete noCode.hmac;
    expect(() => verifyCallback(signed(noCode), INPUT, "nonce")).toThrow("no authorization code");
  });

  it("refuses a tampered parameter", () => {
    const params = callback("nonce");
    params.set("code", "another-code");
    expect(() => verifyCallback(params, INPUT, "nonce")).toThrow("signature didn't match");
  });
});

describe("exchangeCode", () => {
  it("posts the code with the app's credentials and returns the token and scopes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ access_token: "shpat_abc", scope: "read_themes,write_themes" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeCode(INPUT, "auth-code")).resolves.toEqual({ accessToken: "shpat_abc", scope: "read_themes,write_themes" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://mystore.myshopify.com/admin/oauth/access_token");
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({
      client_id: "client-id",
      client_secret: "shpss_secret",
      code: "auth-code",
    });
  });

  it("reports Shopify's reason, including from an HTML error page", async () => {
    vi.stubGlobal("fetch", async () => new Response("<h1>400 - Oauth error invalid_request</h1>", { status: 400 }));
    await expect(exchangeCode(INPUT, "auth-code")).rejects.toThrow("Shopify didn't exchange the code for a token: invalid_request");
  });
});

describe("approveInBrowser", () => {
  it("receives the callback on localhost, exchanges the code, and tells the browser it worked", async () => {
    const shopify = vi.fn<typeof fetch>(async () => Response.json({ access_token: "shpat_abc", scope: "write_themes" }));
    vi.stubGlobal("fetch", shopify);
    let page: { status: number; body: string } | undefined;

    const result = await approveInBrowser(INPUT, (url) => {
      const state = new URL(url).searchParams.get("state")!;
      void browserGet(callback(state)).then((reply) => (page = reply));
    });

    expect(result).toEqual({ accessToken: "shpat_abc", scope: "write_themes" });
    await vi.waitFor(() => expect(page?.status).toBe(200));
    expect(page!.body).toContain("App approved");
    expect(page!.body).not.toContain("shpat_abc");
  });

  it("rejects a forged callback without exchanging anything", async () => {
    const shopify = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", shopify);
    let page: { status: number; body: string } | undefined;

    await expect(
      approveInBrowser(INPUT, (url) => {
        const state = new URL(url).searchParams.get("state")!;
        void browserGet(signed(Object.fromEntries(callback(state)), "guessed-secret")).then((reply) => (page = reply));
      })
    ).rejects.toThrow("signature didn't match");
    await vi.waitFor(() => expect(page?.status).toBe(400));
    expect(shopify).not.toHaveBeenCalled();
  });

  it("says so when the port is taken, and gives up after the timeout", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(OAUTH_PORT, "127.0.0.1", resolve));
    try {
      await expect(approveInBrowser(INPUT, () => {})).rejects.toThrow(`Port ${OAUTH_PORT} is in use`);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }

    await expect(approveInBrowser(INPUT, () => {}, 50)).rejects.toThrow("No approval arrived within 5 minutes");
  });
});
