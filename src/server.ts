import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphQLClient } from "./graphql/client.js";
import type { SchemaIndexLoader } from "./graphql/schema-index.js";
import { TOOLSETS, type Config, type Toolset } from "./utils/cli.js";
import { readOnlyRegistrar, type ToolRegistrar } from "./tools/shared.js";
import { registerGraphQLProxy } from "./tools/graphql-proxy.js";
import { registerSchemaSearch } from "./tools/schema-search.js";
import { registerProductTools } from "./tools/products.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerPublishingTools } from "./tools/publishing.js";
import { registerMetaobjectTools } from "./tools/metaobjects.js";
import { registerMetafieldTools } from "./tools/metafields.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerDiscountTools } from "./tools/discounts.js";
import { registerFileTools } from "./tools/files.js";
import { registerThemeTools } from "./tools/themes.js";
import { registerMarketTools } from "./tools/markets.js";

// Resolves to the package root from both src/ (tests) and dist/ (published build)
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export type ServerOptions = Pick<Config, "readOnly"> &
  Partial<Pick<Config, "toolsets" | "uploadDir" | "allowLiveThemeWrites" | "disableThemeWrites" | "disableRawGraphql">>;

type RegisterToolset = (
  server: ToolRegistrar,
  client: GraphQLClient,
  options: ServerOptions
) => void;

const toolsetRegistrations: Record<Toolset, RegisterToolset> = {
  products: registerProductTools,
  collections: registerCollectionTools,
  publishing: registerPublishingTools,
  metafields: registerMetafieldTools,
  metaobjects: registerMetaobjectTools,
  customers: registerCustomerTools,
  orders: registerOrderTools,
  inventory: registerInventoryTools,
  discounts: registerDiscountTools,
  files: registerFileTools,
  themes: registerThemeTools,
  markets: registerMarketTools,
};

// Sent to the MCP client at initialization to orient the model before it picks a tool
function instructions(options: ServerOptions): string {
  const lines = [
    "Tools for one Shopify store's Admin GraphQL API. Resources are identified by global IDs such as gid://shopify/Product/123.",
    "List tools page with first and after: pass pageInfo.endCursor as after. Nested lists include pageInfo.hasNextPage, which is true when they hold more items than were returned.",
  ];
  lines.push(
    options.readOnly
      ? "The server is read-only, so only tools that read data are available."
      : "Mutations report validation problems as userErrors, and a call that returns userErrors is marked as an error."
  );
  if (options.disableThemeWrites && !options.readOnly) {
    lines.push("Theme edits are disabled: themes and their files can be read but not changed, published, created or deleted.");
  }
  if (!options.disableRawGraphql) {
    lines.push(
      "For anything the other tools don't cover, use shopify_graphql after checking field and argument names with shopify_schema_search and shopify_schema_details."
    );
  }
  return lines.join("\n");
}

export function createServer(
  client: GraphQLClient,
  loadSchemaIndex: SchemaIndexLoader,
  options: ServerOptions
): McpServer {
  const server = new McpServer(
    { name: "shopify-admin-mcp", version },
    { instructions: instructions(options) }
  );

  const registrar = options.readOnly ? readOnlyRegistrar(server) : server;

  // Schema search is always available; raw GraphQL unless the server was told to leave it out
  if (!options.disableRawGraphql) registerGraphQLProxy(registrar, client, options);
  registerSchemaSearch(registrar, loadSchemaIndex);

  for (const toolset of options.toolsets ?? TOOLSETS) {
    toolsetRegistrations[toolset](registrar, client, options);
  }

  return server;
}
