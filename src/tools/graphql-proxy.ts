import { Kind, parse } from "graphql";
import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import { DESTRUCTIVE, READ_ONLY, toolResult, type ToolRegistrar } from "./shared.js";

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// Parsing (rather than pattern matching) the document means comments, strings,
// and multiple operations can't be used to slip a mutation past read-only mode
function findWriteOperation(query: string): string | null {
  const document = parse(query);
  for (const definition of document.definitions) {
    if (
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition.operation !== "query"
    ) {
      return definition.operation;
    }
  }
  return null;
}

export function registerGraphQLProxy(
  server: ToolRegistrar,
  client: GraphQLClient,
  readOnly: boolean
) {
  server.registerTool(
    "shopify_graphql",
    {
      description: readOnly
        ? "Execute a raw GraphQL query against the Shopify Admin API. The server is in read-only mode, so mutations are rejected. Use shopify_schema_search to discover available queries and types first."
        : "Execute a raw GraphQL query or mutation against the Shopify Admin API. Use shopify_schema_search to discover available queries, mutations, and types first.",
      inputSchema: {
        query: z.string().describe("The GraphQL query or mutation string"),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional variables object for the query"),
      },
      annotations: readOnly ? READ_ONLY : DESTRUCTIVE,
    },
    async ({ query, variables }) => {
      try {
        if (readOnly) {
          const operation = findWriteOperation(query);
          if (operation) {
            return errorResult(
              `${operation} operations are disabled because the server is running in read-only mode`
            );
          }
        }
        return toolResult(await client.execute(query, variables));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
