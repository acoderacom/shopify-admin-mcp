import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/provider.js";
import { GraphQLClient } from "../src/graphql/client.js";
import type { Config } from "../src/utils/cli.js";

const tokenConfig: Config = {
  store: "mystore.myshopify.com",
  apiVersion: "2026-10",
  readOnly: false,
  allowLiveThemeWrites: false,
  auth: { mode: "access-token", accessToken: "shpat_test" },
};

const oauthConfig: Config = {
  ...tokenConfig,
  auth: { mode: "client-credentials", clientId: "client-id", clientSecret: "client-secret" },
};

const ENDPOINT = "https://mystore.myshopify.com/admin/api/2026-10/graphql.json";
const TOKEN_URL = "https://mystore.myshopify.com/admin/oauth/access_token";

function jsonResponse(body: unknown, status = 200, apiVersion = "2026-10") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-shopify-api-version": apiVersion },
  });
}

const tokenResponse = (token: string, expiresIn = 86399) =>
  jsonResponse({ access_token: token, scope: "read_products", expires_in: expiresIn });

const throttled = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: {
    cost: {
      requestedQueryCost: 102,
      throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 2, restoreRate: 50 },
    },
  },
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let delays: number[];

const requestInit = (call: number) => fetchMock.mock.calls[call]?.[1] as RequestInit;
const requestHeaders = (call: number) => requestInit(call).headers as Record<string, string>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});

  // Resolve retry back-off immediately while recording the requested delay
  delays = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GraphQLClient", () => {
  it("posts the query to the versioned endpoint with the access token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { shop: { name: "Test" } } }));
    const client = new GraphQLClient(new AuthProvider(tokenConfig), tokenConfig);

    const result = await client.execute("{ shop { name } }", { a: 1 });

    expect(result).toEqual({ data: { shop: { name: "Test" } } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(ENDPOINT);
    expect(requestHeaders(0)["X-Shopify-Access-Token"]).toBe("shpat_test");
    expect(JSON.parse(requestInit(0).body as string)).toEqual({
      query: "{ shop { name } }",
      variables: { a: 1 },
    });
    expect(requestInit(0).signal).toBeInstanceOf(AbortSignal);
  });

  it("waits for the cost bucket to refill before retrying a THROTTLED response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(throttled))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const client = new GraphQLClient(new AuthProvider(tokenConfig), tokenConfig);

    await expect(client.execute("{ shop { name } }")).resolves.toEqual({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // (102 requested - 2 available) / 50 per second = 2s
    expect(delays).toEqual([2000]);
  });

  it("returns the throttled response after three retries", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(throttled));
    const client = new GraphQLClient(new AuthProvider(tokenConfig), tokenConfig);

    const result = await client.execute("{ shop { name } }");

    expect(result.errors?.[0]?.extensions?.code).toBe("THROTTLED");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries HTTP 429 with increasing back-off", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const client = new GraphQLClient(new AuthProvider(tokenConfig), tokenConfig);

    await expect(client.execute("{ shop { name } }")).resolves.toEqual({ data: { ok: true } });
    expect(delays).toEqual([1000, 2000]);
  });

  it("does not retry server errors, since a mutation may already have run", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 502 }));
    const client = new GraphQLClient(new AuthProvider(tokenConfig), tokenConfig);

    await expect(client.execute("mutation { x }")).rejects.toThrow("(502): boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not try to refresh a static access token on 401", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const client = new GraphQLClient(new AuthProvider(tokenConfig), tokenConfig);

    await expect(client.execute("{ shop { name } }")).rejects.toThrow("(401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes a client-credentials token once on 401", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(tokenResponse("token-2"))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const client = new GraphQLClient(new AuthProvider(oauthConfig), oauthConfig);

    await expect(client.execute("{ shop { name } }")).resolves.toEqual({ data: { ok: true } });
    expect(requestHeaders(1)["X-Shopify-Access-Token"]).toBe("token-1");
    expect(requestHeaders(3)["X-Shopify-Access-Token"]).toBe("token-2");
  });

  it("warns once when Shopify serves a different API version", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ data: {} }, 200, "2026-01"));
    const client = new GraphQLClient(new AuthProvider(tokenConfig), tokenConfig);

    await client.execute("{ a }");
    await client.execute("{ b }");

    const warnings = vi.mocked(console.error).mock.calls.filter((args) =>
      String(args[0]).includes("Shopify served 2026-01")
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("AuthProvider", () => {
  it("returns a static access token without network calls", async () => {
    await expect(new AuthProvider(tokenConfig).getAccessToken()).resolves.toBe("shpat_test");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a client-credentials token as a form-encoded body", async () => {
    fetchMock.mockResolvedValue(tokenResponse("token-1"));

    await expect(new AuthProvider(oauthConfig).getAccessToken()).resolves.toBe("token-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(TOKEN_URL);
    expect(requestHeaders(0)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = requestInit(0).body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });

  it("caches the token and shares one request between concurrent callers", async () => {
    fetchMock.mockImplementation(async () => tokenResponse("token-1"));
    const auth = new AuthProvider(oauthConfig);

    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
    await auth.getAccessToken();

    expect(tokens).toEqual(["token-1", "token-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes a token that expires within five minutes", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("short-lived", 200))
      .mockResolvedValueOnce(tokenResponse("token-2"));
    const auth = new AuthProvider(oauthConfig);

    await auth.getAccessToken();
    await expect(auth.getAccessToken()).resolves.toBe("token-2");
  });

  it("reports a failed token exchange with its status", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"shop_not_permitted"}', { status: 400 })
    );
    await expect(new AuthProvider(oauthConfig).getAccessToken()).rejects.toThrow(
      "OAuth token exchange failed (400)"
    );
  });
});
