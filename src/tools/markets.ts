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

const MARKET_FIELDS = `
  id name handle status type
  conditions {
    conditionTypes
    regionsCondition { regions(first: 250) { nodes { id name ... on MarketRegionCountry { code } } } }
  }
  currencySettings { baseCurrency { currencyCode currencyName } localCurrencies roundingEnabled }
  webPresences(first: 10) {
    nodes { id subfolderSuffix domain { host } defaultLocale { locale } alternateLocales { locale } }
  }
`;

const countryCodes = z
  .array(z.string().regex(/^[A-Z]{2}$/, "Use ISO 3166-1 alpha-2 codes, e.g. ID"))
  .min(1);

const currencySettings = z
  .object({
    baseCurrency: z.string().optional().describe("ISO 4217 currency code, e.g. IDR"),
    localCurrencies: z.boolean().optional().describe("Convert prices to each buyer's local currency"),
    roundingEnabled: z.boolean().optional().describe("Round converted prices"),
  })
  .optional()
  .describe("Currency settings for the market");

const regions = (codes: string[]) => ({
  regionsCondition: { regions: codes.map((countryCode) => ({ countryCode })) },
});

export function registerMarketTools(server: ToolRegistrar, client: GraphQLClient) {
  server.registerTool(
    "shopify_markets_list",
    {
      description: "List markets with their regions, currency settings, and web presences (domains and languages)",
      inputSchema: {
        query: z.string().optional().describe('Search filter, e.g. "status:ACTIVE"'),
        first: pageSize.optional().describe("Number of markets to return (default 20)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, first, after }) => {
      const result = await client.execute(
        `query ($first: Int!, $query: String, $after: String) {
          markets(first: $first, query: $query, after: $after) {
            nodes { ${MARKET_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: first ?? 20, query, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_market_get",
    {
      description: "Get a market with its catalogs and price lists",
      inputSchema: {
        id: z.string().describe("Market GID"),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const result = await client.execute(
        `query ($id: ID!) {
          market(id: $id) {
            ${MARKET_FIELDS}
            catalogs(first: 10) {
              nodes { id title status priceList { id name currency } publication { id } }
            }
          }
        }`,
        { id }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_market_create",
    {
      description: "Create a market for one or more countries",
      inputSchema: {
        name: z.string().describe("Market name (not shown to customers)"),
        handle: z.string().optional().describe('Unique handle, e.g. "sg"'),
        status: z.enum(["ACTIVE", "DRAFT"]).optional().describe("Market status (default ACTIVE)"),
        countryCodes: countryCodes.optional().describe("Countries in the market (ISO alpha-2)"),
        currencySettings,
      },
      annotations: WRITE,
    },
    async ({ countryCodes, ...input }) => {
      const result = await client.execute(
        `mutation ($input: MarketCreateInput!) {
          marketCreate(input: $input) {
            market { ${MARKET_FIELDS} }
            userErrors { field message code }
          }
        }`,
        { input: { ...input, conditions: countryCodes ? regions(countryCodes) : undefined } }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_market_update",
    {
      description: "Update a market's name, handle, status, countries, or currency settings",
      inputSchema: {
        id: z.string().describe("Market GID"),
        name: z.string().optional(),
        handle: z.string().optional(),
        status: z.enum(["ACTIVE", "DRAFT"]).optional(),
        addCountryCodes: countryCodes.optional().describe("Countries to add (ISO alpha-2)"),
        removeCountryCodes: countryCodes.optional().describe("Countries to remove (ISO alpha-2)"),
        currencySettings,
      },
      annotations: WRITE,
    },
    async ({ id, addCountryCodes, removeCountryCodes, ...input }) => {
      const conditions =
        addCountryCodes || removeCountryCodes
          ? {
              conditionsToAdd: addCountryCodes ? regions(addCountryCodes) : undefined,
              conditionsToDelete: removeCountryCodes ? regions(removeCountryCodes) : undefined,
            }
          : undefined;
      const result = await client.execute(
        `mutation ($id: ID!, $input: MarketUpdateInput!) {
          marketUpdate(id: $id, input: $input) {
            market { ${MARKET_FIELDS} }
            userErrors { field message code }
          }
        }`,
        { id, input: { ...input, conditions } }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_market_delete",
    {
      description: "Permanently delete a market and its market-specific settings",
      inputSchema: {
        id: z.string().describe("Market GID"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const result = await client.execute(
        `mutation ($id: ID!) {
          marketDelete(id: $id) {
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
