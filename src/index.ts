#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "./utils/cli.js";
import { AuthProvider } from "./auth/provider.js";
import { GraphQLClient } from "./graphql/client.js";
import { runIntrospection } from "./graphql/introspection.js";
import { lazySchemaIndex } from "./graphql/schema-index.js";
import { createServer } from "./server.js";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function main() {
  const config = parseArgs(process.argv);

  console.error(
    `Connecting to ${config.store} (API ${config.apiVersion}, ${config.auth.mode === "access-token" ? "access token" : "client credentials"}${config.readOnly ? ", read-only" : ""})...`
  );

  const client = new GraphQLClient(new AuthProvider(config), config);

  // A small query that needs no access scopes validates the credentials and store up front
  try {
    const res = await client.execute("{ shop { name } }");
    const shop = res.data?.shop as { name: string } | null | undefined;
    if (!shop) {
      throw new Error(res.errors?.map((e) => e.message).join(", ") || "Shopify returned no shop");
    }
    console.error(`Authenticated with ${shop.name}`);
  } catch (err) {
    console.error(`Authentication failed: ${message(err)}`);
    process.exit(1);
  }

  // Introspection downloads the whole schema, so it runs after the server is connected
  // instead of delaying the client's handshake
  const loadSchemaIndex = lazySchemaIndex(async () => {
    const schema = await runIntrospection(client);
    console.error(`Schema loaded: ${schema.types.length} types`);
    return schema;
  });

  const server = createServer(client, loadSchemaIndex, config);
  await server.connect(new StdioServerTransport());
  console.error("Shopify GraphQL Admin MCP Server running");

  loadSchemaIndex().catch((err) => {
    console.error(
      `Schema introspection failed: ${message(err)}. The schema tools will retry when they're next called.`
    );
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
