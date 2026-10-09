import { Kind, parse, type DocumentNode } from "graphql";
import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import type { ServerOptions } from "../server.js";
import { DESTRUCTIVE, READ_ONLY, toolResult, type ToolRegistrar } from "./shared.js";
import { rawLiveThemeGuard } from "./theme-guard.js";

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// Parsing (rather than pattern matching) the document means comments, strings,
// and multiple operations can't be used to slip a mutation past read-only mode
function findWriteOperation(document: DocumentNode): string | null {
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

function toolDescription(options: ServerOptions): string {
  if (options.readOnly) {
    return "Execute a raw GraphQL query against the Shopify Admin API. The server is in read-only mode, so mutations are rejected. Use shopify_schema_search to discover available queries and types first.";
  }
  const base =
    "Execute a raw GraphQL query or mutation against the Shopify Admin API. Use shopify_schema_search to discover available queries, mutations, and types first.";
  return options.allowLiveThemeWrites
    ? base
    : `${base} Theme file writes to the live theme and themePublish are refused unless the server allows live theme writes.`;
}

export function registerGraphQLProxy(
  server: ToolRegistrar,
  client: GraphQLClient,
  options: ServerOptions
) {
  server.registerTool(
    "shopify_graphql",
    {
      description: toolDescription(options),
      inputSchema: {
        query: z.string().describe("The GraphQL query or mutation string"),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional variables object for the query"),
      },
      annotations: options.readOnly ? READ_ONLY : DESTRUCTIVE,
    },
    async ({ query, variables }) => {
      try {
        const document = parse(query);
        if (options.readOnly) {
          const operation = findWriteOperation(document);
          if (operation) {
            return errorResult(
              `${operation} operations are disabled because the server is running in read-only mode`
            );
          }
        } else if (!options.allowLiveThemeWrites) {
          // The theme tools' live-theme guard would mean little if raw GraphQL could skip it
          const blocked = await rawLiveThemeGuard(client, document, variables);
          if (blocked) return errorResult(blocked);
        }
        return toolResult(await client.execute(query, variables));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
