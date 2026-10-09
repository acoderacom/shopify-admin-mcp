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

export function registerMetafieldTools(
  server: ToolRegistrar,
  client: GraphQLClient
) {
  server.registerTool(
    "shopify_metafields_list",
    {
      description: "List metafields on a specific resource (product, collection, customer, etc.)",
      inputSchema: {
        ownerId: z.string().describe("GID of the owner resource (e.g. gid://shopify/Product/123)"),
        namespace: z.string().optional().describe("Filter by namespace"),
        first: pageSize.optional().describe("Number of metafields to return (default 20)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ ownerId, namespace, first, after }) => {
      const result = await client.execute(
        `query ($ownerId: ID!, $first: Int!, $namespace: String, $after: String) {
          node(id: $ownerId) {
            ... on HasMetafields {
              metafields(first: $first, namespace: $namespace, after: $after) {
                nodes { id namespace key value type updatedAt }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { ownerId, first: first ?? 20, namespace, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metafields_set",
    {
      description: "Set (upsert) up to 25 metafields on any resources",
      inputSchema: {
        metafields: z
          .array(
            z.object({
              ownerId: z.string().describe("GID of the owner resource"),
              namespace: z.string().describe("Metafield namespace"),
              key: z.string().describe("Metafield key"),
              value: z.string().describe("Metafield value (JSON string for complex types)"),
              type: z.string().describe("Metafield type (e.g. single_line_text_field, json, number_integer)"),
            })
          )
          .min(1)
          .max(25)
          .describe("Array of metafields to set"),
      },
      annotations: WRITE,
    },
    async ({ metafields }) => {
      const result = await client.execute(
        `mutation ($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key value type }
            userErrors { field message code }
          }
        }`,
        { metafields }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metafield_delete",
    {
      description: "Delete a metafield, identified by its owner, namespace, and key",
      inputSchema: {
        ownerId: z.string().describe("GID of the owner resource"),
        namespace: z.string().describe("Metafield namespace"),
        key: z.string().describe("Metafield key"),
      },
      annotations: DESTRUCTIVE,
    },
    async (metafield) => {
      const result = await client.execute(
        `mutation ($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields { ownerId namespace key }
            userErrors { field message }
          }
        }`,
        { metafields: [metafield] }
      );
      return toolResult(result);
    }
  );
}
