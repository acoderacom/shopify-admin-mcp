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

const ownerType = z
  .string()
  .describe("MetafieldOwnerType, e.g. PRODUCT, PRODUCTVARIANT, COLLECTION, CUSTOMER, ORDER, SHOP, MARKET");

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
    "shopify_metafield_definitions_list",
    {
      description: "List metafield definitions for a resource type (their namespace, key, type, and validations)",
      inputSchema: {
        ownerType: ownerType,
        namespace: z.string().optional().describe("Filter by namespace"),
        first: pageSize.optional().describe("Number of definitions to return (default 50)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ ownerType, namespace, first, after }) => {
      const result = await client.execute(
        `query ($ownerType: MetafieldOwnerType!, $namespace: String, $first: Int!, $after: String) {
          metafieldDefinitions(ownerType: $ownerType, namespace: $namespace, first: $first, after: $after) {
            nodes {
              id name namespace key description ownerType
              type { name }
              validations { name value }
              pinnedPosition
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { ownerType, namespace, first: first ?? 50, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metafield_definition_create",
    {
      description:
        "Create a metafield definition so a metafield is typed, validated, and editable in the Shopify admin",
      inputSchema: {
        ownerType: ownerType,
        namespace: z.string().optional().describe('Namespace, e.g. "custom" (defaults to the app namespace)'),
        key: z.string().describe("Key, unique within the namespace"),
        name: z.string().describe("Name shown in the admin"),
        type: z.string().describe("Metafield type, e.g. single_line_text_field, number_integer, product_reference"),
        description: z.string().optional(),
        validations: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .optional()
          .describe('Validation rules, e.g. [{ "name": "max", "value": "100" }]'),
        pin: z.boolean().optional().describe("Pin the definition in the admin"),
        capabilities: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('MetafieldCapabilityCreateInput, e.g. { "adminFilterable": { "enabled": true } }'),
      },
      annotations: WRITE,
    },
    async (definition) => {
      const result = await client.execute(
        `mutation ($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id name namespace key ownerType type { name } }
            userErrors { field message code }
          }
        }`,
        { definition }
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
