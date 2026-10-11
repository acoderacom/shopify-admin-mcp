import { z } from "zod";
import type { GraphQLClient, GraphQLResponse } from "../graphql/client.js";
import type { ServerOptions } from "../server.js";
import { sleep } from "../utils/sleep.js";
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  pageSize,
  readOnlyRegistrar,
  toolResult,
  type ToolRegistrar,
} from "./shared.js";
import { md5, readThemeFile, remoteBytes, themeFileBody, writeThemeFile, type RemoteBody } from "./theme-dir.js";
import { liveThemeGuard } from "./theme-guard.js";

const THEME_ROLES = ["MAIN", "UNPUBLISHED", "DEVELOPMENT", "DEMO", "ARCHIVED", "LOCKED"] as const;

// themeFilesUpsert writes the files in a background job, which usually finishes within seconds
const JOB_POLL_ATTEMPTS = 30;
const JOB_POLL_MS = 500;

const BODY_FIELDS = `body {
  ... on OnlineStoreThemeFileBodyText { content }
  ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
  ... on OnlineStoreThemeFileBodyUrl { url }
}`;

const themeFile = z
  .object({
    filename: z.string().describe('Theme file path, e.g. "sections/header.liquid" or "assets/logo.png"'),
    content: z.string().optional().describe("Text content (Liquid, JSON, CSS, JS)"),
    contentBase64: z.string().optional().describe("Base64-encoded content for binary files"),
    url: z.url({ protocol: /^https?$/ }).optional().describe("Public URL Shopify should fetch the content from"),
  })
  .refine(
    (file) => [file.content, file.contentBase64, file.url].filter((v) => v !== undefined).length <= 1,
    { message: "Provide at most one of content, contentBase64, or url" }
  );

type ThemeFileInput = z.infer<typeof themeFile>;

interface PreparedFile {
  filename: string;
  source: "theme folder" | "content" | "contentBase64" | "url";
  body: { type: string; value: string };
  /** The bytes sent, used to check what Shopify stored; unknown for URL bodies. */
  sent?: Buffer;
}

interface FileReport {
  filename: string;
  source: PreparedFile["source"];
  checksumMd5?: string;
  /** "pending" when the upsert job hadn't finished; "not checked" for URL bodies or when the check failed. */
  stored: "as sent" | "changed by Shopify" | "pending" | "not checked";
  themeFolder?: string;
  error?: string;
}

// Files written to local disk, so not read-only, but idempotent and limited to the theme folder
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function prepareFile(file: ThemeFileInput, themeDir: string | undefined): Promise<PreparedFile> {
  const { filename } = file;
  if (file.content !== undefined) {
    return { filename, source: "content", body: { type: "TEXT", value: file.content }, sent: Buffer.from(file.content, "utf8") };
  }
  if (file.contentBase64 !== undefined) {
    return {
      filename,
      source: "contentBase64",
      body: { type: "BASE64", value: file.contentBase64 },
      sent: Buffer.from(file.contentBase64, "base64"),
    };
  }
  if (file.url !== undefined) return { filename, source: "url", body: { type: "URL", value: file.url } };
  if (!themeDir) {
    throw new Error(
      `${filename} has no content. Pass content, contentBase64 or url, or start the server with --theme-dir <folder> (or SHOPIFY_THEME_DIR) to send theme files from that folder by filename.`
    );
  }
  const data = await readThemeFile(themeDir, filename);
  return { filename, source: "theme folder", body: themeFileBody(data), sent: data };
}

async function waitForJob(client: GraphQLClient, jobId: string): Promise<boolean> {
  for (let attempt = 0; attempt < JOB_POLL_ATTEMPTS; attempt++) {
    const res = await client.execute(`query ($id: ID!) { job(id: $id) { done } }`, { id: jobId });
    if ((res.data?.job as { done?: boolean } | null | undefined)?.done) return true;
    await sleep(JOB_POLL_MS);
  }
  return false;
}

type ThemeFileNode = { filename: string; checksumMd5?: string | null; body?: RemoteBody | null };

async function themeFileNodes(client: GraphQLClient, themeId: string, filenames: string[], fields: string) {
  const res = await client.execute(
    `query ($id: ID!, $filenames: [String!]) {
      theme(id: $id) { files(filenames: $filenames, first: 50) { nodes { ${fields} } } }
    }`,
    { id: themeId, filenames }
  );
  const nodes = (res.data?.theme as { files?: { nodes?: ThemeFileNode[] } } | null | undefined)?.files?.nodes ?? [];
  return new Map(nodes.map((node) => [node.filename, node]));
}

/**
 * Once the upsert job is done, compares the content Shopify returns with the bytes sent. Shopify
 * regenerates JSON files (adding its header and reformatting them; config/settings_data.json is
 * rebuilt from its data), so a file sent from the theme folder that comes back different is
 * replaced with Shopify's copy, keeping local and live in step.
 */
async function checkStored(
  client: GraphQLClient,
  themeId: string,
  files: PreparedFile[],
  jobId: string | undefined,
  themeDir: string | undefined
): Promise<FileReport[]> {
  const reports = files.map((file): FileReport & { sent?: Buffer } => ({
    filename: file.filename,
    source: file.source,
    ...(file.sent ? { checksumMd5: md5(file.sent), stored: "pending" as const } : { stored: "not checked" as const }),
    sent: file.sent,
  }));
  const strip = () => reports.map(({ sent: _sent, ...report }) => report);
  const checked = reports.filter((report) => report.sent);
  if (checked.length === 0) return strip();

  try {
    if (jobId && !(await waitForJob(client, jobId))) return strip();

    // Checksums first; content only for the files whose checksum differs, and for JSON files,
    // which Shopify returns regenerated (with its header, reformatted) even when it stored them as sent
    const sums = await themeFileNodes(client, themeId, checked.map((r) => r.filename), "filename checksumMd5");
    const differing = checked.filter((report) => {
      const node = sums.get(report.filename);
      if (node?.checksumMd5 === report.checksumMd5) report.stored = "as sent";
      return report.stored !== "as sent" || report.filename.endsWith(".json");
    });
    if (differing.length === 0) return strip();

    const bodies = await themeFileNodes(client, themeId, differing.map((r) => r.filename), `filename ${BODY_FIELDS}`);
    for (const report of differing) {
      const node = bodies.get(report.filename);
      if (!node?.body) continue;
      const stored = await remoteBytes(node.body);
      if (stored.equals(report.sent!)) {
        report.stored = "as sent";
        continue;
      }
      report.stored = "changed by Shopify";
      if (report.source === "theme folder" && themeDir) {
        await writeThemeFile(themeDir, report.filename, stored);
        report.themeFolder = "updated to Shopify's copy";
      }
    }
  } catch (err) {
    for (const report of checked) {
      if (report.stored === "pending") {
        report.stored = "not checked";
        report.error = errorMessage(err);
      }
    }
  }
  return strip();
}

export function registerThemeTools(
  registrar: ToolRegistrar,
  client: GraphQLClient,
  options: ServerOptions
) {
  // With theme edits disabled, only the tools that read themes are registered
  const server = options.disableThemeWrites ? readOnlyRegistrar(registrar) : registrar;
  server.registerTool(
    "shopify_themes_list",
    {
      description: "List the store's online store themes and their roles (MAIN is the live theme)",
      inputSchema: {
        roles: z.array(z.enum(THEME_ROLES)).optional().describe("Only return themes with these roles"),
      },
      annotations: READ_ONLY,
    },
    async ({ roles }) => {
      const result = await client.execute(
        `query ($roles: [ThemeRole!]) {
          themes(first: 50, roles: $roles) {
            nodes { id name role processing processingFailed themeStoreId createdAt updatedAt }
            pageInfo { hasNextPage }
          }
        }`,
        { roles }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_theme_files_list",
    {
      description: "List files in a theme (names, sizes, checksums) without their content",
      inputSchema: {
        themeId: z.string().describe("Theme GID"),
        filenames: z
          .array(z.string())
          .optional()
          .describe('Filename patterns; * matches any characters, e.g. ["sections/*", "templates/*.json"]'),
        first: pageSize.optional().describe("Number of files to return (default 100)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ themeId, filenames, first, after }) => {
      const result = await client.execute(
        `query ($id: ID!, $filenames: [String!], $first: Int!, $after: String) {
          theme(id: $id) {
            id name role
            files(filenames: $filenames, first: $first, after: $after) {
              nodes { filename size contentType checksumMd5 updatedAt }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: themeId, filenames, first: first ?? 100, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_theme_files_get",
    {
      description:
        "Read the content of specific theme files (text files return content, binary files return base64 or a URL). Up to 50 files are returned; pageInfo.hasNextPage shows when a pattern matched more.",
      inputSchema: {
        themeId: z.string().describe("Theme GID"),
        filenames: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe('Filenames or patterns, e.g. ["layout/theme.liquid", "sections/header.liquid"]'),
      },
      annotations: READ_ONLY,
    },
    async ({ themeId, filenames }) => {
      const result = await client.execute(
        `query ($id: ID!, $filenames: [String!]) {
          theme(id: $id) {
            id name role
            files(filenames: $filenames, first: 50) {
              nodes {
                filename size contentType checksumMd5 updatedAt
                body {
                  ... on OnlineStoreThemeFileBodyText { content }
                  ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
                  ... on OnlineStoreThemeFileBodyUrl { url }
                }
              }
              pageInfo { hasNextPage }
              userErrors { code filename }
            }
          }
        }`,
        { id: themeId, filenames }
      );
      // Files that can't be read are reported on the connection rather than a mutation payload
      const files = (result.data?.theme as { files?: { userErrors?: unknown[] } } | null | undefined)?.files;
      const response = toolResult(result);
      return files?.userErrors?.length ? { ...response, isError: true } : response;
    }
  );

  // Pulling writes only to the local theme folder, so it stays available when theme edits are disabled
  const themeDir = options.themeDir;
  if (themeDir) {
    registrar.registerTool(
      "shopify_theme_files_pull",
      {
        description: `Copy theme files from Shopify into the local theme folder (${themeDir}) without returning their content. Up to 50 files per call; when pageInfo.hasNextPage is true, call again with pageInfo.endCursor as after. Files whose content already matches are left alone.`,
        inputSchema: {
          themeId: z.string().describe("Theme GID"),
          filenames: z
            .array(z.string())
            .min(1)
            .max(50)
            .describe('Filenames or patterns; * matches any characters, e.g. ["templates/index.json", "sections/*"]'),
          after: z.string().optional().describe("Cursor for pagination"),
        },
        annotations: LOCAL_WRITE,
      },
      async ({ themeId, filenames, after }) => {
        const result = await client.execute(
          `query ($id: ID!, $filenames: [String!], $after: String) {
            theme(id: $id) {
              id name role
              files(filenames: $filenames, first: 50, after: $after) {
                nodes { filename ${BODY_FIELDS} }
                pageInfo { hasNextPage endCursor }
                userErrors { code filename }
              }
            }
          }`,
          { id: themeId, filenames, after }
        );
        const theme = result.data?.theme as
          | {
              id: string;
              name: string;
              role: string;
              files: { nodes: ThemeFileNode[]; pageInfo: unknown; userErrors?: unknown[] };
            }
          | null
          | undefined;
        if (!theme) return result.errors?.length ? toolResult(result) : errorResult(`Theme ${themeId} not found`);

        let failed = false;
        const pulled = [];
        for (const node of theme.files.nodes) {
          try {
            const data = await remoteBytes(node.body ?? {});
            const status = await writeThemeFile(themeDir, node.filename, data);
            pulled.push({ filename: node.filename, status, bytes: data.length, checksumMd5: md5(data) });
          } catch (err) {
            failed = true;
            pulled.push({ filename: node.filename, status: "skipped", error: errorMessage(err) });
          }
        }
        const userErrors = theme.files.userErrors ?? [];
        const output = {
          theme: { id: theme.id, name: theme.name, role: theme.role },
          folder: themeDir,
          files: pulled,
          pageInfo: theme.files.pageInfo,
          ...(userErrors.length ? { userErrors } : {}),
          ...(result.errors?.length ? { errors: result.errors } : {}),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          isError: failed || userErrors.length > 0,
        };
      }
    );
  }

  server.registerTool(
    "shopify_theme_files_upsert",
    {
      description:
        "Create or overwrite up to 50 files in a theme, then report whether Shopify stored each one as sent. Writes to the live (MAIN) theme are refused unless the server allows them; duplicate the theme first." +
        (options.themeDir
          ? ` Give a file only its filename to send it from the local theme folder (${options.themeDir}), so its content doesn't have to be passed.`
          : ""),
      inputSchema: {
        themeId: z.string().describe("Theme GID (use an unpublished theme)"),
        files: z.array(themeFile).min(1).max(50).describe("Files to write"),
      },
      annotations: WRITE,
    },
    async ({ themeId, files }) => {
      // Files are read before anything is sent, so a bad path stops the whole write
      const prepared: PreparedFile[] = [];
      for (const file of files) {
        try {
          prepared.push(await prepareFile(file, options.themeDir));
        } catch (err) {
          return errorResult(errorMessage(err));
        }
      }

      const blocked = await liveThemeGuard(client, themeId, options.allowLiveThemeWrites);
      if (blocked) return errorResult(blocked);

      const result = await client.execute(
        `mutation ($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
          themeFilesUpsert(themeId: $themeId, files: $files) {
            upsertedThemeFiles { filename }
            job { id }
            userErrors { field message code filename }
          }
        }`,
        { themeId, files: prepared.map(({ filename, body }) => ({ filename, body })) }
      );
      const response = toolResult(result);
      if (response.isError) return response;

      const jobId = (result.data?.themeFilesUpsert as { job?: { id?: string } | null } | null | undefined)?.job?.id;
      const reports = await checkStored(client, themeId, prepared, jobId ?? undefined, options.themeDir);
      const output: GraphQLResponse & { files: FileReport[] } = { ...result, files: reports };
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }], isError: false };
    }
  );

  server.registerTool(
    "shopify_theme_files_delete",
    {
      description: "Delete files from a theme. Refused on the live (MAIN) theme unless the server allows it.",
      inputSchema: {
        themeId: z.string().describe("Theme GID"),
        filenames: z.array(z.string()).min(1).max(50).describe("Exact filenames to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ themeId, filenames }) => {
      const blocked = await liveThemeGuard(client, themeId, options.allowLiveThemeWrites);
      if (blocked) return errorResult(blocked);

      const result = await client.execute(
        `mutation ($themeId: ID!, $files: [String!]!) {
          themeFilesDelete(themeId: $themeId, files: $files) {
            deletedThemeFiles { filename }
            userErrors { field message code filename }
          }
        }`,
        { themeId, files: filenames }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_theme_duplicate",
    {
      description: "Duplicate a theme as a new unpublished theme, e.g. to edit a safe copy of the live theme",
      inputSchema: {
        themeId: z.string().describe("Theme GID to copy"),
        name: z.string().optional().describe("Name for the copy"),
      },
      annotations: WRITE,
    },
    async ({ themeId, name }) => {
      const result = await client.execute(
        `mutation ($id: ID!, $name: String) {
          themeDuplicate(id: $id, name: $name) {
            newTheme { id name role processing }
            userErrors { field message code }
          }
        }`,
        { id: themeId, name }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_theme_delete",
    {
      description: "Permanently delete an unpublished theme. The live theme can't be deleted.",
      inputSchema: {
        themeId: z.string().describe("Theme GID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ themeId }) => {
      const result = await client.execute(
        `mutation ($id: ID!) {
          themeDelete(id: $id) {
            deletedThemeId
            userErrors { field message code }
          }
        }`,
        { id: themeId }
      );
      return toolResult(result);
    }
  );
}
