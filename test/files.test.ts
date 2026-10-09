import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, connect, resultText } from "./helpers.js";

// Poll for file processing without real delays
vi.mock("../src/utils/sleep.js", () => ({ sleep: async () => {} }));

const PRODUCT = "gid://shopify/Product/1";
const FILE_ID = "gid://shopify/MediaImage/1";
const STAGED_URL = "https://shopify-staged-uploads.storage.googleapis.com/";
const RESOURCE_URL = "https://shopify-staged-uploads.storage.googleapis.com/tmp/logo.png";

const staged = {
  data: {
    stagedUploadsCreate: {
      stagedTargets: [
        { url: STAGED_URL, resourceUrl: RESOURCE_URL, parameters: [{ name: "key", value: "tmp/logo.png" }, { name: "policy", value: "p" }] },
      ],
      userErrors: [],
    },
  },
};
const created = { data: { fileCreate: { files: [{ id: FILE_ID, fileStatus: "UPLOADED" }], userErrors: [] } } };
const fileNode = (fileStatus: string) => ({ data: { node: { id: FILE_ID, fileStatus, image: { url: "https://cdn.shopify.com/logo.png" } } } });

let root: string;
let uploadDir: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "shopify-mcp-"));
  uploadDir = path.join(root, "uploads");
  await mkdir(uploadDir);
  await writeFile(path.join(uploadDir, "logo.png"), "fake png bytes");
  await writeFile(path.join(root, "secret.txt"), "do not upload");

  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("shopify_file_upload from a local path", () => {
  it("stages the file, uploads it, creates the file, and waits until it is ready", async () => {
    const { client, fake } = await connect({ uploadDir });
    fake.responses.push(staged, created, fileNode("PROCESSING"), fileNode("READY"));

    const result = await callTool(client, "shopify_file_upload", { path: "logo.png", alt: "Logo" });

    expect(result.isError, resultText(result)).toBeFalsy();
    expect(fake.calls[0]!.variables).toEqual({
      input: [{ resource: "IMAGE", filename: "logo.png", mimeType: "image/png", fileSize: "14", httpMethod: "POST" }],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(STAGED_URL);
    const form = init!.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]);
    expect(await (form.get("file") as File).text()).toBe("fake png bytes");

    expect(fake.calls[1]!.variables).toEqual({
      files: [{ originalSource: RESOURCE_URL, contentType: "IMAGE", alt: "Logo" }],
    });
    expect(fake.calls).toHaveLength(4);
    expect(JSON.parse(resultText(result)).data.file.fileStatus).toBe("READY");
  });

  it("attaches the file to a product once it is ready", async () => {
    const { client, fake } = await connect({ uploadDir });
    fake.responses.push(staged, created, fileNode("READY"), {
      data: { fileUpdate: { files: [{ id: FILE_ID }], userErrors: [] } },
    });

    const result = await callTool(client, "shopify_file_upload", { path: "logo.png", productId: PRODUCT });

    expect(result.isError).toBeFalsy();
    expect(fake.lastCall.query).toContain("fileUpdate(");
    expect(fake.lastCall.variables).toEqual({ files: [{ id: FILE_ID, referencesToAdd: [PRODUCT] }] });
  });

  it("reports files that Shopify fails to process", async () => {
    const { client, fake } = await connect({ uploadDir });
    fake.responses.push(staged, created, {
      data: { node: { id: FILE_ID, fileStatus: "FAILED", fileErrors: [{ code: "UNSUPPORTED", message: "Bad image" }] } },
    });

    const result = await callTool(client, "shopify_file_upload", { path: "logo.png", productId: PRODUCT });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Bad image");
    expect(fake.calls.some((c) => c.query.includes("fileUpdate("))).toBe(false);
  });

  it("reports Shopify's reason when it won't stage the upload", async () => {
    const { client, fake } = await connect({ uploadDir });
    fake.responses.push({
      data: { stagedUploadsCreate: { stagedTargets: null, userErrors: [{ field: ["input"], message: "File size is too large" }] } },
    });

    const result = await callTool(client, "shopify_file_upload", { path: "logo.png" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("File size is too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is disabled without an upload directory", async () => {
    const { client, fake } = await connect();
    const result = await callTool(client, "shopify_file_upload", { path: path.join(uploadDir, "logo.png") });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("--upload-dir");
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["../secret.txt", "/etc/hosts"])("refuses paths outside the upload directory: %s", async (filePath) => {
    const { client, fake } = await connect({ uploadDir });
    const result = await callTool(client, "shopify_file_upload", { path: filePath });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("outside the upload directory");
    expect(fake.calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses symlinks that point outside the upload directory", async () => {
    await symlink(path.join(root, "secret.txt"), path.join(uploadDir, "innocent.png"));
    const { client, fake } = await connect({ uploadDir });

    const result = await callTool(client, "shopify_file_upload", { path: "innocent.png" });

    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses directories", async () => {
    await mkdir(path.join(uploadDir, "nested"));
    const { client } = await connect({ uploadDir });
    const result = await callTool(client, "shopify_file_upload", { path: "nested" });
    expect(result.isError).toBe(true);
  });
});

describe("shopify_file_upload from a URL", () => {
  it("lets Shopify fetch the URL directly", async () => {
    const { client, fake } = await connect();
    fake.responses.push(created, fileNode("READY"));

    const result = await callTool(client, "shopify_file_upload", { url: "https://example.com/files/guide.pdf" });

    expect(result.isError).toBeFalsy();
    expect(fake.calls[0]!.variables).toEqual({
      files: [{ originalSource: "https://example.com/files/guide.pdf", contentType: "FILE" }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the content type to Shopify when the URL has no known extension", async () => {
    const { client, fake } = await connect();
    fake.responses.push(created, fileNode("READY"));

    await callTool(client, "shopify_file_upload", { url: "https://example.com/image?id=1" });

    expect(fake.calls[0]!.variables).toEqual({ files: [{ originalSource: "https://example.com/image?id=1" }] });
  });

  it.each(["file:///etc/passwd", "ftp://example.com/a.png", "not a url"])("rejects %s", async (url) => {
    const { client, fake } = await connect();
    const result = await callTool(client, "shopify_file_upload", { url });

    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("requires exactly one of url or path", async () => {
    const { client } = await connect({ uploadDir });
    const neither = await callTool(client, "shopify_file_upload", {});
    const both = await callTool(client, "shopify_file_upload", { url: "https://example.com/a.png", path: "logo.png" });

    expect(neither.isError).toBe(true);
    expect(both.isError).toBe(true);
  });
});
