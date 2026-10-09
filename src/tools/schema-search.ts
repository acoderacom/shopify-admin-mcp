import { z } from "zod";
import type { SchemaIndexLoader } from "../graphql/schema-index.js";
import { READ_ONLY, type ToolRegistrar } from "./shared.js";

// Schema tools read the cached introspection result; Shopify is only called to load it once
const SCHEMA_ANNOTATIONS = { ...READ_ONLY, openWorldHint: false };

export function registerSchemaSearch(
  server: ToolRegistrar,
  loadSchemaIndex: SchemaIndexLoader
) {
  server.registerTool(
    "shopify_schema_search",
    {
      description:
        "Search the Shopify Admin GraphQL schema by keyword. Returns matching types, queries, and mutations. Use this to discover what's available before writing queries.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .describe('Search keyword (e.g. "metaobject", "product", "collection")'),
        filter: z
          .enum(["all", "types", "queries", "mutations"])
          .optional()
          .describe("Filter results by category (default: all)"),
      },
      annotations: SCHEMA_ANNOTATIONS,
    },
    async ({ query, filter }) => {
      const schemaIndex = await loadSchemaIndex();
      const results = schemaIndex.search(query, filter ?? "all");
      const lines: string[] = [];

      if (results.queries.length > 0) {
        lines.push("## Queries\n");
        for (const name of results.queries) {
          const q = schemaIndex.getQuery(name);
          if (q) lines.push(`- ${schemaIndex.formatFieldSummary(q)}`);
        }
        lines.push("");
      }

      if (results.mutations.length > 0) {
        lines.push("## Mutations\n");
        for (const name of results.mutations) {
          const m = schemaIndex.getMutation(name);
          if (m) lines.push(`- ${schemaIndex.formatFieldSummary(m)}`);
        }
        lines.push("");
      }

      if (results.types.length > 0) {
        lines.push("## Types\n");
        for (const name of results.types) {
          const t = schemaIndex.getType(name);
          if (t) {
            const desc = t.description
              ? ` — ${t.description.slice(0, 100)}`
              : "";
            lines.push(`- ${t.name} (${t.kind})${desc}`);
          }
        }
        lines.push("");
      }

      if (lines.length === 0) {
        lines.push(`No results found for "${query}".`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.registerTool(
    "shopify_schema_details",
    {
      description:
        "Get complete details for a specific GraphQL type, query, or mutation including all fields, arguments, and nested types.",
      inputSchema: {
        name: z
          .string()
          .describe(
            'Exact name of the type, query, or mutation (e.g. "Product", "productCreate", "ProductCreateInput")'
          ),
      },
      annotations: SCHEMA_ANNOTATIONS,
    },
    async ({ name }) => {
      const details = (await loadSchemaIndex()).getDetails(name);
      if (!details) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No type, query, or mutation found with name "${name}". Use shopify_schema_search to find the correct name.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: details }],
      };
    }
  );
}
