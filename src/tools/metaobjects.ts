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
    "shopify_metaobject_definition_create",
    {
      description: "Create a metaobject definition (a custom content type with typed fields)",
      inputSchema: {
        type: z.string().describe('Type identifier, e.g. "designer" (can\'t be changed later)'),
        name: z.string().optional().describe("Name shown in the admin"),
        description: z.string().optional(),
        displayNameKey: z.string().optional().describe("Key of the field used as each entry's display name"),
        fieldDefinitions: z
          .array(
            z.object({
              key: z.string(),
              type: z.string().describe("Metafield type, e.g. single_line_text_field, file_reference"),
              name: z.string().optional(),
              description: z.string().optional(),
              required: z.boolean().optional(),
              validations: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
            })
          )
          .min(1),
        access: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('MetaobjectAccessInput, e.g. { "storefront": "PUBLIC_READ" }'),
        capabilities: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('MetaobjectCapabilityCreateInput, e.g. { "publishable": { "enabled": true } }'),
      },
      annotations: WRITE,
    },
    async (definition) => {
      const result = await client.execute(
        `mutation ($definition: MetaobjectDefinitionCreateInput!) {
          metaobjectDefinitionCreate(definition: $definition) {
            metaobjectDefinition { id type name displayNameKey fieldDefinitions { key name type { name } required } }
            userErrors { field message code }
          }
        }`,
        { definition }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_metaobject_upsert",
    {
      description:
        "Create a metaobject entry, or update it if one with the same type and handle exists. Only the fields you pass are changed.",
      inputSchema: {
        type: z.string().describe("Metaobject type"),
        handle: z.string().describe("Handle that identifies the entry within its type"),
        fields: metaobjectFields.describe("Array of field key-value pairs"),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ type, handle, fields }) => {
      const result = await client.execute(
        `mutation ($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
          metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
            metaobject { id handle displayName fields { key value } }
            userErrors { field message code }
          }
        }`,
        { handle: { type, handle }, metaobject: { fields } }
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
