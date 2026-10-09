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

export function registerCollectionTools(
  server: ToolRegistrar,
  client: GraphQLClient
) {
  server.registerTool(
    "shopify_collections_list",
    {
      description: "List collections with optional search filter and pagination",
      inputSchema: {
        query: z.string().optional().describe("Search query to filter collections"),
        first: pageSize.optional().describe("Number of collections to return (default 10)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, first, after }) => {
      const result = await client.execute(
        `query ($first: Int!, $query: String, $after: String) {
          collections(first: $first, query: $query, after: $after) {
            edges {
              cursor
              node {
                id title handle description productsCount { count }
                sources { __typename id title }
                image { url altText }
                updatedAt
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: first ?? 10, query, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_collection_get",
    {
      description: "Get a single collection by ID with its sources and products",
      inputSchema: {
        id: z.string().describe("Collection GID"),
        productsFirst: pageSize.optional().describe("Number of products to include (default 10)"),
      },
      annotations: READ_ONLY,
    },
    async ({ id, productsFirst }) => {
      const result = await client.execute(
        `query ($id: ID!, $productsFirst: Int!) {
          collection(id: $id) {
            id title handle description descriptionHtml sortOrder
            productsCount { count }
            sources { __typename id title description }
            image { url altText }
            products(first: $productsFirst) {
              nodes { id title handle status }
              pageInfo { hasNextPage endCursor }
            }
            metafields(first: 10) {
              nodes { namespace key value type }
            }
            updatedAt
          }
        }`,
        { id, productsFirst: productsFirst ?? 10 }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_collection_create",
    {
      description:
        "Create a new collection. Product membership is defined by sources (typed conditions and manual selections); inspect CollectionCreateSourceTargetInput with shopify_schema_details for the shape. Collections are created unpublished.",
      inputSchema: {
        title: z.string().describe("Collection title"),
        descriptionHtml: z.string().optional().describe("Collection description in HTML"),
        sources: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Collection sources as CollectionCreateSourceTargetInput objects"),
      },
      annotations: WRITE,
    },
    async (collection) => {
      const result = await client.execute(
        `mutation ($collection: CollectionCreateInput!) {
          collectionCreate(collection: $collection) {
            collection { id title handle }
            userErrors { field message }
          }
        }`,
        { collection }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_collection_update",
    {
      description:
        "Update an existing collection. Only the fields you pass are changed; pass an empty string to clear the description.",
      inputSchema: {
        id: z.string().describe("Collection GID"),
        title: z.string().optional().describe("Collection title"),
        descriptionHtml: z.string().optional().describe("Collection description in HTML"),
      },
      annotations: WRITE,
    },
    async (collection) => {
      const result = await client.execute(
        `mutation ($collection: CollectionUpdateInput!) {
          collectionUpdate(collection: $collection) {
            collection { id title handle }
            userErrors { field message }
          }
        }`,
        { collection }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_collection_delete",
    {
      description: "Permanently delete a collection (its products are not deleted)",
      inputSchema: {
        id: z.string().describe("Collection GID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const result = await client.execute(
        `mutation ($input: CollectionDeleteInput!) {
          collectionDelete(input: $input) {
            deletedCollectionId
            userErrors { field message }
          }
        }`,
        { input: { id } }
      );
      return toolResult(result);
    }
  );
}
