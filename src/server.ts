import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphQLClient } from "./graphql/client.js";
import type { SchemaIndex } from "./graphql/schema-index.js";
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
import { registerFileTools } from "./tools/files.js";
import { registerThemeTools } from "./tools/themes.js";
import { registerMarketTools } from "./tools/markets.js";

// Resolves to the package root from both src/ (tests) and dist/ (published build)
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export type ServerOptions = Pick<Config, "readOnly"> &
  Partial<Pick<Config, "toolsets" | "uploadDir" | "allowLiveThemeWrites">>;

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
  files: registerFileTools,
  themes: registerThemeTools,
  markets: registerMarketTools,
};

export function createServer(
  client: GraphQLClient,
  schemaIndex: SchemaIndex,
  options: ServerOptions
): McpServer {
  const server = new McpServer({
    name: "shopify-admin-mcp",
    version,
  });

  const registrar = options.readOnly ? readOnlyRegistrar(server) : server;

  // Raw GraphQL and schema search are always available
  registerGraphQLProxy(registrar, client, options.readOnly);
  registerSchemaSearch(registrar, schemaIndex);

  for (const toolset of options.toolsets ?? TOOLSETS) {
    toolsetRegistrations[toolset](registrar, client, options);
  }

  return server;
}
