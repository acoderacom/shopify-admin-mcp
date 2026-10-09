import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_VERSION, parseArgs } from "../src/utils/cli.js";

const ENV_KEYS = [
  "SHOPIFY_STORE",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_API_VERSION",
  "SHOPIFY_READ_ONLY",
  "SHOPIFY_TOOLSETS",
  "SHOPIFY_UPLOAD_DIR",
  "SHOPIFY_ALLOW_LIVE_THEME_WRITES",
];

const parse = (...args: string[]) => parseArgs(["node", "shopify-admin-mcp", ...args]);

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("defaults to API 2026-10 and appends .myshopify.com", () => {
    const config = parse("--store", "MyStore", "--access-token", "shpat_x");
    expect(DEFAULT_API_VERSION).toBe("2026-10");
    expect(config).toEqual({
      store: "mystore.myshopify.com",
      apiVersion: "2026-10",
      readOnly: false,
      allowLiveThemeWrites: false,
      auth: { mode: "access-token", accessToken: "shpat_x" },
    });
  });

  it("accepts a full store URL", () => {
    const config = parse("--store", "https://my-store.myshopify.com/", "--access-token", "t");
    expect(config.store).toBe("my-store.myshopify.com");
  });

  it.each([
    "evil.com#.myshopify.com",
    "evil.com/.myshopify.com",
    "mystore.myshopify.com.evil.com",
    "evil.com?.myshopify.com",
    "my_store",
    "-store",
  ])("rejects store %j so credentials never leave *.myshopify.com", (store) => {
    expect(() => parse("--store", store, "--access-token", "t")).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid store"));
  });

  it.each(["2026-11", "latest", "../../x", "2026-10/../x"])("rejects API version %j", (version) => {
    expect(() =>
      parse("--store", "mystore", "--access-token", "t", "--api-version", version)
    ).toThrow("exit 1");
  });

  it.each(["2026-07", "2027-01", "unstable"])("accepts API version %j", (version) => {
    const config = parse("--store", "mystore", "--access-token", "t", "--api-version", version);
    expect(config.apiVersion).toBe(version);
  });

  it("reads configuration from environment variables", () => {
    vi.stubEnv("SHOPIFY_STORE", "envstore");
    vi.stubEnv("SHOPIFY_CLIENT_ID", "id");
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "secret");
    vi.stubEnv("SHOPIFY_API_VERSION", "2026-07");
    vi.stubEnv("SHOPIFY_READ_ONLY", "TRUE");

    expect(parse()).toEqual({
      store: "envstore.myshopify.com",
      apiVersion: "2026-07",
      readOnly: true,
      allowLiveThemeWrites: false,
      auth: { mode: "client-credentials", clientId: "id", clientSecret: "secret" },
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("enables read-only mode with --read-only", () => {
    expect(parse("--store", "s", "--access-token", "t", "--read-only").readOnly).toBe(true);
  });

  it("warns when secrets are passed as flags", () => {
    parse("--store", "s", "--client-id", "id", "--client-secret", "secret");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("process listings"));
  });

  it("prefers an access token over client credentials", () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", "id");
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "secret");
    expect(parse("--store", "s", "--access-token", "t").auth.mode).toBe("access-token");
  });

  it("parses toolsets, the upload directory, and live theme writes", () => {
    const config = parse(
      "--store", "s", "--access-token", "t",
      "--toolsets", "products, themes",
      "--upload-dir", "uploads",
      "--allow-live-theme-writes"
    );
    expect(config.toolsets).toEqual(["products", "themes"]);
    expect(config.uploadDir).toBe(path.resolve("uploads"));
    expect(config.allowLiveThemeWrites).toBe(true);
  });

  it("reads toolsets, upload directory, and live theme writes from the environment", () => {
    vi.stubEnv("SHOPIFY_TOOLSETS", "files");
    vi.stubEnv("SHOPIFY_UPLOAD_DIR", "/tmp/uploads");
    vi.stubEnv("SHOPIFY_ALLOW_LIVE_THEME_WRITES", "1");
    const config = parse("--store", "s", "--access-token", "t");
    expect(config).toMatchObject({ toolsets: ["files"], uploadDir: "/tmp/uploads", allowLiveThemeWrites: true });
  });

  it("rejects unknown toolsets", () => {
    expect(() => parse("--store", "s", "--access-token", "t", "--toolsets", "products,shipping")).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Unknown toolset(s): shipping"));
  });

  describe("blank and unexpanded values", () => {
    const store = ["--store", "mystore"];

    it("uses the access token when the client credentials are unexpanded placeholders", () => {
      vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "shpat_real");
      vi.stubEnv("SHOPIFY_CLIENT_ID", "${SHOPIFY_CLIENT_ID}");
      vi.stubEnv("SHOPIFY_CLIENT_SECRET", "${SHOPIFY_CLIENT_SECRET}");
      expect(parse(...store).auth).toEqual({ mode: "access-token", accessToken: "shpat_real" });
    });

    it("uses client credentials when the access token is an unexpanded placeholder", () => {
      vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "${SHOPIFY_ACCESS_TOKEN}");
      vi.stubEnv("SHOPIFY_CLIENT_ID", "id");
      vi.stubEnv("SHOPIFY_CLIENT_SECRET", "secret");
      expect(parse(...store).auth).toEqual({ mode: "client-credentials", clientId: "id", clientSecret: "secret" });
    });

    it.each(["", "   ", "$SHOPIFY_ACCESS_TOKEN", "${SHOPIFY_ACCESS_TOKEN:-}", "${ SHOPIFY_ACCESS_TOKEN }"])(
      "treats an access token of %j as not set",
      (value) => {
        vi.stubEnv("SHOPIFY_ACCESS_TOKEN", value);
        vi.stubEnv("SHOPIFY_CLIENT_ID", "id");
        vi.stubEnv("SHOPIFY_CLIENT_SECRET", "secret");
        expect(parse(...store).auth.mode).toBe("client-credentials");
      }
    );

    it("trims surrounding whitespace from real values", () => {
      vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "  shpat_real\n");
      expect(parse(...store).auth).toEqual({ mode: "access-token", accessToken: "shpat_real" });
    });

    it("ignores placeholder flags in args and falls back to the environment", () => {
      vi.stubEnv("SHOPIFY_CLIENT_ID", "id");
      vi.stubEnv("SHOPIFY_CLIENT_SECRET", "secret");
      const config = parse(...store, "--access-token", "${SHOPIFY_ACCESS_TOKEN}", "--api-version", "${API_VERSION}");
      expect(config.auth.mode).toBe("client-credentials");
      expect(config.apiVersion).toBe("2026-10");
      expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("process listings"));
    });

    it("ignores placeholder options and keeps their defaults", () => {
      vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "t");
      vi.stubEnv("SHOPIFY_TOOLSETS", "${SHOPIFY_TOOLSETS}");
      vi.stubEnv("SHOPIFY_UPLOAD_DIR", "");
      vi.stubEnv("SHOPIFY_READ_ONLY", "${SHOPIFY_READ_ONLY}");
      const config = parse(...store);
      expect(config).toMatchObject({ readOnly: false, allowLiveThemeWrites: false });
      expect(config.toolsets).toBeUndefined();
      expect(config.uploadDir).toBeUndefined();
    });

    it("treats a placeholder store as missing", () => {
      vi.stubEnv("SHOPIFY_STORE", "${SHOPIFY_STORE}");
      vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "t");
      expect(() => parse()).toThrow("exit 1");
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--store is required"));
    });

    it("explains which client credential is missing", () => {
      vi.stubEnv("SHOPIFY_CLIENT_ID", "id");
      vi.stubEnv("SHOPIFY_CLIENT_SECRET", "${SHOPIFY_CLIENT_SECRET}");
      expect(() => parse(...store)).toThrow("exit 1");
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("SHOPIFY_CLIENT_SECRET (--client-secret) is missing"));
    });
  });

  it("requires a store", () => {
    expect(() => parse("--access-token", "t")).toThrow("exit 1");
  });

  it("requires credentials", () => {
    expect(() => parse("--store", "s", "--client-id", "id")).toThrow("exit 1");
  });
});
