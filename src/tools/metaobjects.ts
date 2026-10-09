import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  pageSize,
  toolResult,
  type ToolRegistrar,
} from "./shared.js";

const metaobjectFields = z.array(z.object({ key: z.string(), value: z.string() }));

export function registerMetaobjectTools(
  server: ToolRegistrar,
  client: GraphQLClient
) {
  server.registerTool(
    "shopify_metaobject_definitions_list",
    {
      description: "List metaobject definitions (types) in the store",
      inputSchema: {
        first: pageSize.optional().describe("Number of definitions to return (default 50)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ first, after }) => {
      const result = await client.execute(
        `query ($first: Int!, $after: String) {
          metaobjectDefinitions(first: $first, after: $after) {
            nodes {
              id type name description
              fieldDefinitions { key name type { name } required }
              metaobjectsCount
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: first ?? 50, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metaobjects_list",
    {
      description: "List metaobject entries of a given type",
      inputSchema: {
        type: z.string().describe('Metaobject type (e.g. "school", "conference")'),
        first: pageSize.optional().describe("Number of entries to return (default 20)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ type, first, after }) => {
      const result = await client.execute(
        `query ($type: String!, $first: Int!, $after: String) {
          metaobjects(type: $type, first: $first, after: $after) {
            edges {
              cursor
              node {
                id handle displayName type
                fields { key value }
                updatedAt
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { type, first: first ?? 20, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metaobject_get",
    {
      description: "Get a single metaobject by ID",
      inputSchema: {
        id: z.string().describe("Metaobject GID"),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const result = await client.execute(
        `query ($id: ID!) {
          metaobject(id: $id) {
            id handle displayName type
            fields { key value type }
            updatedAt
          }
        }`,
        { id }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metaobject_create",
    {
      description: "Create a new metaobject entry",
      inputSchema: {
        type: z.string().describe('Metaobject type (e.g. "school")'),
        handle: z.string().optional().describe("URL-friendly handle"),
        fields: metaobjectFields.describe("Array of field key-value pairs"),
      },
      annotations: WRITE,
    },
    async (metaobject) => {
      const result = await client.execute(
        `mutation ($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject { id handle displayName fields { key value } }
            userErrors { field message code }
          }
        }`,
        { metaobject }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metaobject_update",
    {
      description: "Update an existing metaobject entry",
      inputSchema: {
        id: z.string().describe("Metaobject GID"),
        handle: z.string().optional().describe("New handle"),
        fields: metaobjectFields.describe("Array of field key-value pairs to update"),
      },
      annotations: WRITE,
    },
    async ({ id, ...metaobject }) => {
      const result = await client.execute(
        `mutation ($id: ID!, $metaobject: MetaobjectUpdateInput!) {
          metaobjectUpdate(id: $id, metaobject: $metaobject) {
            metaobject { id handle displayName fields { key value } }
            userErrors { field message code }
          }
        }`,
        { id, metaobject }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metaobject_delete",
    {
      description: "Permanently delete a metaobject entry",
      inputSchema: {
        id: z.string().describe("Metaobject GID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const result = await client.execute(
        `mutation ($id: ID!) {
          metaobjectDelete(id: $id) {
            deletedId
            userErrors { field message code }
          }
        }`,
        { id }
      );
      return toolResult(result);
    }
  );
}
