import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphQLClient } from "./graphql/client.js";
import type { SchemaIndex } from "./graphql/schema-index.js";
import { readOnlyRegistrar } from "./tools/shared.js";
import { registerGraphQLProxy } from "./tools/graphql-proxy.js";
import { registerSchemaSearch } from "./tools/schema-search.js";
import { registerProductTools } from "./tools/products.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerMetaobjectTools } from "./tools/metaobjects.js";
import { registerMetafieldTools } from "./tools/metafields.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerInventoryTools } from "./tools/inventory.js";

export function createServer(
  client: GraphQLClient,
  schemaIndex: SchemaIndex,
  options: { readOnly: boolean }
): McpServer {
  const server = new McpServer({
    name: "shopify-graphql-admin",
    version: "1.0.0",
  });

  const registrar = options.readOnly ? readOnlyRegistrar(server) : server;

  registerGraphQLProxy(registrar, client, options.readOnly);
  registerSchemaSearch(registrar, schemaIndex);
  registerProductTools(registrar, client);
  registerCollectionTools(registrar, client);
  registerMetaobjectTools(registrar, client);
  registerMetafieldTools(registrar, client);
  registerCustomerTools(registrar, client);
  registerOrderTools(registrar, client);
  registerInventoryTools(registrar, client);

  return server;
}
