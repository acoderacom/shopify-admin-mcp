import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import type { ServerOptions } from "../server.js";
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  pageSize,
  toolResult,
  type ToolRegistrar,
} from "./shared.js";

const THEME_ROLES = ["MAIN", "UNPUBLISHED", "DEVELOPMENT", "DEMO", "ARCHIVED", "LOCKED"] as const;

const themeFile = z
  .object({
    filename: z.string().describe('Theme file path, e.g. "sections/header.liquid" or "assets/logo.png"'),
    content: z.string().optional().describe("Text content (Liquid, JSON, CSS, JS)"),
    contentBase64: z.string().optional().describe("Base64-encoded content for binary files"),
    url: z.url({ protocol: /^https?$/ }).optional().describe("Public URL Shopify should fetch the content from"),
  })
  .refine(
    (file) => [file.content, file.contentBase64, file.url].filter((v) => v !== undefined).length === 1,
    { message: "Provide exactly one of content, contentBase64, or url" }
  );

function fileBody(file: z.infer<typeof themeFile>) {
  if (file.content !== undefined) return { type: "TEXT", value: file.content };
  if (file.contentBase64 !== undefined) return { type: "BASE64", value: file.contentBase64 };
  return { type: "URL", value: file.url! };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// Editing the published theme changes the live storefront immediately, so writes go to
// a duplicate unless the server was started with --allow-live-theme-writes
async function liveThemeGuard(
  client: GraphQLClient,
  themeId: string,
  options: ServerOptions
): Promise<string | null> {
  const res = await client.execute(`query ($id: ID!) { theme(id: $id) { id name role } }`, {
    id: themeId,
  });
  const theme = res.data?.theme as { name: string; role: string } | null | undefined;
  if (!theme) return `Theme ${themeId} not found`;
  if (theme.role === "MAIN" && !options.allowLiveThemeWrites) {
    return `"${theme.name}" is the live theme. Duplicate it with shopify_theme_duplicate, edit the copy, and publish it from the Shopify admin. To edit the live theme directly, restart the server with --allow-live-theme-writes.`;
  }
  return null;
}

export function registerThemeTools(
  server: ToolRegistrar,
  client: GraphQLClient,
  options: ServerOptions
) {
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
      description: "Read the content of specific theme files (text files return content, binary files return base64 or a URL)",
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
              userErrors { code filename }
            }
          }
        }`,
        { id: themeId, filenames }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_theme_files_upsert",
    {
      description:
        "Create or overwrite up to 50 files in a theme. Writes to the live (MAIN) theme are refused unless the server allows them; duplicate the theme first.",
      inputSchema: {
        themeId: z.string().describe("Theme GID (use an unpublished theme)"),
        files: z.array(themeFile).min(1).max(50).describe("Files to write"),
      },
      annotations: WRITE,
    },
    async ({ themeId, files }) => {
      const blocked = await liveThemeGuard(client, themeId, options);
      if (blocked) return errorResult(blocked);

      const result = await client.execute(
        `mutation ($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
          themeFilesUpsert(themeId: $themeId, files: $files) {
            upsertedThemeFiles { filename }
            job { id }
            userErrors { field message code filename }
          }
        }`,
        { themeId, files: files.map((file) => ({ filename: file.filename, body: fileBody(file) })) }
      );
      return toolResult(result);
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
      const blocked = await liveThemeGuard(client, themeId, options);
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
