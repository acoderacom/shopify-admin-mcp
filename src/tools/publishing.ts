import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import { READ_ONLY, WRITE, toolResult, type ToolRegistrar } from "./shared.js";

const publishTarget = {
  id: z.string().describe("GID of the product or collection"),
  publicationIds: z
    .array(z.string())
    .min(1)
    .describe("Publication GIDs from shopify_publications_list (e.g. the Online Store publication)"),
};

export function registerPublishingTools(
  server: ToolRegistrar,
  client: GraphQLClient
) {
  server.registerTool(
    "shopify_publications_list",
    {
      description:
        "List the publications (sales channels and catalogs) that products and collections can be published to",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const result = await client.execute(
        `query {
          publications(first: 50) {
            nodes {
              id autoPublish supportsFuturePublishing
              catalog { id title }
              channels(first: 5) { nodes { id name handle } }
            }
          }
        }`
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_publish",
    {
      description:
        "Publish a product or collection to one or more publications. Products must be ACTIVE to be visible on a channel.",
      inputSchema: {
        ...publishTarget,
        publishDate: z
          .string()
          .optional()
          .describe("ISO 8601 date-time to schedule publishing (Online Store only)"),
      },
      annotations: WRITE,
    },
    async ({ id, publicationIds, publishDate }) => {
      const result = await client.execute(
        `mutation ($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            publishable { ... on Product { id title } ... on Collection { id title } }
            userErrors { field message }
          }
        }`,
        { id, input: publicationIds.map((publicationId) => ({ publicationId, publishDate })) }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_unpublish",
    {
      description: "Unpublish a product or collection from one or more publications",
      inputSchema: publishTarget,
      annotations: WRITE,
    },
    async ({ id, publicationIds }) => {
      const result = await client.execute(
        `mutation ($id: ID!, $input: [PublicationInput!]!) {
          publishableUnpublish(id: $id, input: $input) {
            publishable { ... on Product { id title } ... on Collection { id title } }
            userErrors { field message }
          }
        }`,
        { id, input: publicationIds.map((publicationId) => ({ publicationId })) }
      );
      return toolResult(result);
    }
  );
}
