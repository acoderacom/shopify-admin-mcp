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

const productFields = {
  descriptionHtml: z.string().optional().describe("Product description in HTML"),
  vendor: z.string().optional().describe("Product vendor"),
  productType: z.string().optional().describe("Product type"),
  tags: z.array(z.string()).optional().describe("Product tags"),
  status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional().describe("Product status"),
};

export function registerProductTools(
  server: ToolRegistrar,
  client: GraphQLClient
) {
  server.registerTool(
    "shopify_products_list",
    {
      description: "List products with optional search filter and pagination",
      inputSchema: {
        query: z.string().optional().describe("Search query to filter products"),
        first: pageSize.optional().describe("Number of products to return (default 10)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, first, after }) => {
      const result = await client.execute(
        `query ($first: Int!, $query: String, $after: String) {
          products(first: $first, query: $query, after: $after) {
            edges {
              cursor
              node {
                id title handle status vendor productType
                totalInventory
                priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
                featuredMedia { preview { image { url altText } } }
                createdAt updatedAt
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
    "shopify_product_get",
    {
      description: "Get a single product by ID",
      inputSchema: {
        id: z.string().describe("Product GID (e.g. gid://shopify/Product/123)"),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const result = await client.execute(
        `query ($id: ID!) {
          product(id: $id) {
            id title handle descriptionHtml status vendor productType tags
            totalInventory
            priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
            featuredMedia { preview { image { url altText } } }
            variants(first: 50) {
              nodes { id title price sku inventoryQuantity selectedOptions { name value } }
            }
            metafields(first: 20) {
              nodes { namespace key value type }
            }
            createdAt updatedAt
          }
        }`,
        { id }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_product_create",
    {
      description:
        "Create a new product. Products are created unpublished; publish them separately to make them visible on sales channels.",
      inputSchema: {
        title: z.string().describe("Product title"),
        ...productFields,
      },
      annotations: WRITE,
    },
    async (product) => {
      const result = await client.execute(
        `mutation ($product: ProductCreateInput!) {
          productCreate(product: $product) {
            product { id title handle status }
            userErrors { field message }
          }
        }`,
        { product }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_product_update",
    {
      description:
        "Update an existing product. Only the fields you pass are changed; pass an empty string to clear a text field.",
      inputSchema: {
        id: z.string().describe("Product GID"),
        title: z.string().optional().describe("Product title"),
        ...productFields,
      },
      annotations: WRITE,
    },
    async (product) => {
      const result = await client.execute(
        `mutation ($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product { id title handle status }
            userErrors { field message }
          }
        }`,
        { product }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_product_delete",
    {
      description: "Permanently delete a product and all of its variants",
      inputSchema: {
        id: z.string().describe("Product GID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const result = await client.execute(
        `mutation ($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors { field message }
          }
        }`,
        { input: { id } }
      );
      return toolResult(result);
    }
  );
}
