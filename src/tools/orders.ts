import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import { READ_ONLY, pageSize, toolResult, type ToolRegistrar } from "./shared.js";

export function registerOrderTools(
  server: ToolRegistrar,
  client: GraphQLClient
) {
  server.registerTool(
    "shopify_orders_list",
    {
      description:
        "List orders with optional search filter and pagination. Only the last 60 days are visible unless the app has the read_all_orders scope.",
      inputSchema: {
        query: z.string().optional().describe("Search query to filter orders"),
        first: pageSize.optional().describe("Number of orders to return (default 10)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, first, after }) => {
      const result = await client.execute(
        `query ($first: Int!, $query: String, $after: String) {
          orders(first: $first, query: $query, after: $after) {
            edges {
              cursor
              node {
                id name displayFinancialStatus displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                customer { id displayName defaultEmailAddress { emailAddress } }
                lineItems(first: 5) {
                  nodes { title quantity }
                }
                createdAt
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
    "shopify_order_get",
    {
      description: "Get a single order by ID",
      inputSchema: {
        id: z.string().describe("Order GID"),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const result = await client.execute(
        `query ($id: ID!) {
          order(id: $id) {
            id name displayFinancialStatus displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            customer { id displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
            shippingAddress { address1 address2 city province country zip }
            lineItems(first: 50) {
              nodes {
                title quantity sku
                originalTotalSet { shopMoney { amount currencyCode } }
                variant { id title }
              }
            }
            fulfillments { status trackingInfo { number url } }
            tags note
            metafields(first: 10) {
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
}
