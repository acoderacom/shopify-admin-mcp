import { openAsBlob } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { GraphQLClient, GraphQLResponse } from "../graphql/client.js";
import { sleep } from "../utils/sleep.js";
import type { ServerOptions } from "../server.js";
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  pageSize,
  toolResult,
  type ToolRegistrar,
} from "./shared.js";

type FileContentType = "IMAGE" | "VIDEO" | "MODEL_3D" | "FILE";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".glb": "model/gltf-binary",
  ".usdz": "model/vnd.usdz+zip",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

const UPLOAD_TIMEOUT_MS = 300_000;
const STATUS_POLL_ATTEMPTS = 20;

const FILE_FIELDS = `
  id alt fileStatus createdAt
  fileErrors { code message details }
  preview { image { url } }
  ... on MediaImage { mimeType image { url width height } }
  ... on GenericFile { mimeType url originalFileSize }
  ... on Video { filename sources { url mimeType } }
  ... on Model3d { filename sources { url mimeType } }
`;

function mimeTypeFor(filename: string): string {
  return MIME_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function contentTypeFor(mimeType: string): FileContentType {
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("model/")) return "MODEL_3D";
  return "FILE";
}

// Local uploads are confined to one directory (symlinks resolved) so a prompt can't
// make the server publish arbitrary files from this machine to the store's public CDN
async function resolveUploadPath(filePath: string, uploadDir: string | undefined) {
  if (!uploadDir) {
    throw new Error(
      "Local file uploads are disabled. Start the server with --upload-dir <directory> (or SHOPIFY_UPLOAD_DIR) to allow uploads from that directory, or pass a public url instead."
    );
  }
  const root = await realpath(uploadDir);
  const resolved = await realpath(path.resolve(root, filePath));
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`"${filePath}" is outside the upload directory ${root}`);
  }
  if (!(await stat(resolved)).isFile()) {
    throw new Error(`"${filePath}" is not a file`);
  }
  return resolved;
}

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

async function stageLocalFile(
  client: GraphQLClient,
  filePath: string,
  filename: string,
  contentType: FileContentType
): Promise<{ resourceUrl: string } | { failed: GraphQLResponse }> {
  const mimeType = mimeTypeFor(filename);
  const blob = await openAsBlob(filePath, { type: mimeType });

  const staged = await client.execute(
    `mutation ($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        { resource: contentType, filename, mimeType, fileSize: String(blob.size), httpMethod: "POST" },
      ],
    }
  );
  const payload = staged.data?.stagedUploadsCreate as
    | { stagedTargets: StagedTarget[] | null; userErrors: unknown[] }
    | null
    | undefined;
  // stagedTargets is null when Shopify rejects the input; the userErrors explain why
  const target = payload?.stagedTargets?.[0];
  if (!target || payload.userErrors.length > 0) return { failed: staged };

  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", blob, filename);

  const res = await fetch(target.url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Staged upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return { resourceUrl: target.resourceUrl };
}

// Files are processed asynchronously; wait briefly so the result can include the CDN URL
async function waitForFile(client: GraphQLClient, id: string) {
  let node: { fileStatus?: string } | undefined;
  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
    const res = await client.execute(
      `query ($id: ID!) { node(id: $id) { ... on File { ${FILE_FIELDS} } } }`,
      { id }
    );
    node = res.data?.node as { fileStatus?: string } | undefined;
    if (node?.fileStatus === "READY" || node?.fileStatus === "FAILED") break;
    await sleep(1000);
  }
  return node;
}

export function registerFileTools(
  server: ToolRegistrar,
  client: GraphQLClient,
  options: ServerOptions
) {
  server.registerTool(
    "shopify_files_list",
    {
      description:
        "List files in the store's Files library (images, videos, 3D models, documents), newest first",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Search filter, e.g. "filename:logo", "media_type:IMAGE", "status:READY"'),
        first: pageSize.optional().describe("Number of files to return (default 20)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, first, after }) => {
      const result = await client.execute(
        `query ($first: Int!, $query: String, $after: String) {
          files(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
            nodes { __typename ${FILE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: first ?? 20, query, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_file_upload",
    {
      description:
        "Upload a file to the store's Files library from a public URL or a local path, wait for processing, and optionally attach it to a product as media. Local paths must be inside the server's --upload-dir.",
      inputSchema: {
        url: z
          .url({ protocol: /^https?$/ })
          .optional()
          .describe("Public http(s) URL Shopify should fetch the file from"),
        path: z
          .string()
          .optional()
          .describe("Local file path, absolute or relative to the upload directory"),
        filename: z.string().optional().describe("Filename to store the file under (defaults to the source name)"),
        alt: z.string().optional().describe("Alt text for accessibility"),
        contentType: z
          .enum(["IMAGE", "VIDEO", "MODEL_3D", "FILE"])
          .optional()
          .describe("File type (detected from the extension when omitted)"),
        productId: z
          .string()
          .optional()
          .describe("Product GID to attach the uploaded image, video, or 3D model to as media"),
      },
      annotations: WRITE,
    },
    async ({ url, path: filePath, filename, alt, contentType, productId }) => {
      if (Boolean(url) === Boolean(filePath)) {
        return {
          content: [{ type: "text" as const, text: "Error: provide exactly one of url or path" }],
          isError: true,
        };
      }

      let originalSource: string;
      let type = contentType;

      if (filePath) {
        const resolved = await resolveUploadPath(filePath, options.uploadDir);
        const name = filename ?? path.basename(resolved);
        type ??= contentTypeFor(mimeTypeFor(name));
        const staged = await stageLocalFile(client, resolved, name, type);
        if ("failed" in staged) return toolResult(staged.failed);
        originalSource = staged.resourceUrl;
      } else {
        originalSource = url!;
        // Leave the type for Shopify to detect when the URL has no recognisable extension
        const detected = mimeTypeFor(new URL(originalSource).pathname);
        if (!type && detected !== "application/octet-stream") type = contentTypeFor(detected);
      }

      const created = await client.execute(
        `mutation ($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files { id fileStatus }
            userErrors { field message code }
          }
        }`,
        { files: [{ originalSource, contentType: type, alt, filename }] }
      );
      const createdFile = (
        created.data?.fileCreate as { files?: Array<{ id: string }> } | undefined
      )?.files?.[0];
      const createdResult = toolResult(created);
      if (!createdFile || createdResult.isError) return createdResult;

      const file = await waitForFile(client, createdFile.id);
      const response: GraphQLResponse = { data: { file } };
      let failed = file?.fileStatus === "FAILED";

      if (productId && !failed) {
        if (file?.fileStatus === "READY") {
          const attached = await client.execute(
            `mutation ($files: [FileUpdateInput!]!) {
              fileUpdate(files: $files) {
                files { id }
                userErrors { field message code }
              }
            }`,
            { files: [{ id: createdFile.id, referencesToAdd: [productId] }] }
          );
          response.data!.fileUpdate = attached.data?.fileUpdate;
          response.errors = attached.errors;
        } else {
          response.errors = [
            {
              message: `File is still ${file?.fileStatus ?? "processing"}; attach it to the product once it is READY`,
            },
          ];
          failed = true;
        }
      }

      const result = toolResult(response);
      return failed ? { ...result, isError: true } : result;
    }
  );

  server.registerTool(
    "shopify_file_delete",
    {
      description:
        "Permanently delete files from the Files library. Products, themes, and pages that use them will show broken media.",
      inputSchema: {
        fileIds: z.array(z.string()).min(1).describe("File GIDs to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ fileIds }) => {
      const result = await client.execute(
        `mutation ($fileIds: [ID!]!) {
          fileDelete(fileIds: $fileIds) {
            deletedFileIds
            userErrors { field message code }
          }
        }`,
        { fileIds }
      );
      return toolResult(result);
    }
  );
}
