import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import {
  READ_ONLY,
  WRITE,
  pageSize,
  toolResult,
  type ToolRegistrar,
} from "./shared.js";

export function registerCustomerTools(
  server: ToolRegistrar,
  client: GraphQLClient
) {
  server.registerTool(
    "shopify_customers_list",
    {
      description: "List customers with optional search filter and pagination",
      inputSchema: {
        query: z.string().optional().describe("Search query to filter customers"),
        first: pageSize.optional().describe("Number of customers to return (default 10)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, first, after }) => {
      const result = await client.execute(
        `query ($first: Int!, $query: String, $after: String) {
          customers(first: $first, query: $query, after: $after) {
            edges {
              cursor
              node {
                id displayName
                defaultEmailAddress { emailAddress }
                defaultPhoneNumber { phoneNumber }
                numberOfOrders
                amountSpent { amount currencyCode }
                tags
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
    "shopify_customer_get",
    {
      description: "Get a single customer by ID",
      inputSchema: {
        id: z.string().describe("Customer GID"),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const result = await client.execute(
        `query ($id: ID!) {
          customer(id: $id) {
            id displayName firstName lastName
            defaultEmailAddress { emailAddress }
            defaultPhoneNumber { phoneNumber }
            numberOfOrders
            amountSpent { amount currencyCode }
            tags note
            addressesV2(first: 10) {
              nodes { address1 address2 city province country zip }
              pageInfo { hasNextPage }
            }
            orders(first: 10) {
              nodes { id name totalPriceSet { shopMoney { amount currencyCode } } createdAt }
              pageInfo { hasNextPage }
            }
            metafields(first: 10) {
              nodes { namespace key value type }
              pageInfo { hasNextPage }
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
    "shopify_customer_update",
    {
      description:
        "Update a customer. Only the fields you pass are changed; pass an empty string to clear a text field.",
      inputSchema: {
        id: z.string().describe("Customer GID"),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional().describe("Phone number in E.164 format"),
        tags: z.array(z.string()).optional(),
        note: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (input) => {
      const result = await client.execute(
        `mutation ($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id displayName defaultEmailAddress { emailAddress } }
            userErrors { field message }
          }
        }`,
        { input }
      );
      return toolResult(result);
    }
  );
}
