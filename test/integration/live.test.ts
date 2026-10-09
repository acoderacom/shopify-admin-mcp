/**
 * Runs against a real store. Skipped unless credentials are set:
 *   SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN (or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)
 * Write tests also need SHOPIFY_TEST_WRITES=1. They only touch "[MCP test]" entities
 * they create, and delete them afterwards. Use a development store.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthProvider } from "../../src/auth/provider.js";
import { GraphQLClient } from "../../src/graphql/client.js";
import { runIntrospection } from "../../src/graphql/introspection.js";
import { SchemaIndex } from "../../src/graphql/schema-index.js";
import { createServer } from "../../src/server.js";
import { parseArgs } from "../../src/utils/cli.js";
import { callTool, resultText } from "../helpers.js";

const env = process.env;
const hasCredentials =
  !!env.SHOPIFY_STORE &&
  (!!env.SHOPIFY_ACCESS_TOKEN || (!!env.SHOPIFY_CLIENT_ID && !!env.SHOPIFY_CLIENT_SECRET));
const writesEnabled = hasCredentials && env.SHOPIFY_TEST_WRITES === "1";

const TIMEOUT = 60_000;

// Shopify response payloads are checked by assertions, not types
type Data = any;

async function connectLive(readOnly: boolean) {
  const config = { ...parseArgs(["node", "shopify-admin-mcp"]), readOnly };
  const graphql = new GraphQLClient(new AuthProvider(config), config);
  const schema = await runIntrospection(graphql);
  const server = createServer(graphql, new SchemaIndex(schema), { readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "live-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, config, typeCount: schema.types.length };
}

/** Calls a tool, fails the test with Shopify's message on error, and returns `data`. */
async function data(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<Data> {
  const result = await callTool(client, tool, args);
  expect(result.isError, `${tool}: ${resultText(result).slice(0, 500)}`).toBeFalsy();
  return JSON.parse(resultText(result)).data;
}

const graphql = (client: Client, query: string, variables?: Record<string, unknown>) =>
  data(client, "shopify_graphql", variables ? { query, variables } : { query });

describe.skipIf(!hasCredentials)("live store: reads", { timeout: TIMEOUT }, () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await connectLive(false));
  }, TIMEOUT);

  afterAll(() => client?.close());

  it("connects with the configured API version", async () => {
    const d = await graphql(client, "{ shop { name myshopifyDomain } }");
    expect(d.shop.myshopifyDomain).toBe(parseArgs(["node", "x"]).store);
  });

  it("introspects a schema without the removed metafieldDelete mutation", async () => {
    const search = await callTool(client, "shopify_schema_search", { query: "metafieldsDelete", filter: "mutations" });
    expect(resultText(search)).toContain("metafieldsDelete");
    const details = await callTool(client, "shopify_schema_details", { name: "metafieldDelete" });
    expect(details.isError).toBe(true);
  });

  it("lists and gets products, metafields, and inventory", async () => {
    const list = await data(client, "shopify_products_list", { first: 2 });
    const product = list.products.edges[0]?.node;
    if (!product) return;

    const got = await data(client, "shopify_product_get", { id: product.id });
    expect(got.product.id).toBe(product.id);
    await data(client, "shopify_metafields_list", { ownerId: product.id, first: 5 });

    if (list.products.pageInfo.hasNextPage) {
      const next = await data(client, "shopify_products_list", { first: 1, after: list.products.pageInfo.endCursor });
      expect(next.products.edges[0].node.id).not.toBe(product.id);
    }

    const variants = await graphql(client, "{ productVariants(first: 1) { nodes { inventoryItem { id } } } }");
    const inventoryItemId = variants.productVariants.nodes[0]?.inventoryItem.id;
    if (inventoryItemId) {
      const levels = await data(client, "shopify_inventory_get_levels", { inventoryItemId });
      expect(levels.inventoryItem.id).toBe(inventoryItemId);
    }
  });

  it("lists and gets collections with sources", async () => {
    const list = await data(client, "shopify_collections_list", { first: 2 });
    const collection = list.collections.edges[0]?.node;
    if (!collection) return;
    expect(Array.isArray(collection.sources)).toBe(true);
    const got = await data(client, "shopify_collection_get", { id: collection.id, productsFirst: 2 });
    expect(got.collection.id).toBe(collection.id);
  });

  it("lists and gets customers", async () => {
    const list = await data(client, "shopify_customers_list", { first: 2 });
    const customer = list.customers.edges[0]?.node;
    if (!customer) return;
    const got = await data(client, "shopify_customer_get", { id: customer.id });
    expect(Array.isArray(got.customer.addressesV2.nodes)).toBe(true);
  });

  it("lists and gets orders", async () => {
    const list = await data(client, "shopify_orders_list", { first: 2 });
    const order = list.orders.edges[0]?.node;
    if (!order) return;
    const got = await data(client, "shopify_order_get", { id: order.id });
    expect(got.order.id).toBe(order.id);
  });

  it("lists metaobject definitions and entries", async () => {
    const defs = await data(client, "shopify_metaobject_definitions_list", { first: 10 });
    const def = defs.metaobjectDefinitions.nodes.find((d: Data) => d.metaobjectsCount > 0);
    if (!def) return;
    const list = await data(client, "shopify_metaobjects_list", { type: def.type, first: 1 });
    const entry = list.metaobjects.edges[0].node;
    const got = await data(client, "shopify_metaobject_get", { id: entry.id });
    expect(got.metaobject.type).toBe(def.type);
  });
});

describe.skipIf(!hasCredentials)("live store: read-only mode", { timeout: TIMEOUT }, () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await connectLive(true));
  }, TIMEOUT);

  afterAll(() => client?.close());

  it("blocks raw mutations before they reach Shopify", async () => {
    const result = await callTool(client, "shopify_graphql", {
      query: 'mutation { productDelete(input: {id: "gid://shopify/Product/0"}) { deletedProductId } }',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("read-only mode");
  });

  it("still runs raw queries", async () => {
    const d = await graphql(client, "{ shop { name } }");
    expect(d.shop.name).toBeTruthy();
  });
});

describe.skipIf(!writesEnabled)("live store: writes", { timeout: TIMEOUT }, () => {
  const label = `[MCP test] ${new Date().toISOString()}`;
  const created: {
    productId?: string;
    collectionId?: string;
    definitionId?: string;
    metaobjectId?: string;
    customerId?: string;
  } = {};
  let client: Client;

  beforeAll(async () => {
    ({ client } = await connectLive(false));
  }, TIMEOUT);

  // Best-effort cleanup so a failed assertion never leaves test data behind
  afterAll(async () => {
    if (!client) return;
    const cleanups: Array<[string, Record<string, unknown>] | undefined> = [
      created.collectionId ? ["shopify_collection_delete", { id: created.collectionId }] : undefined,
      created.productId ? ["shopify_product_delete", { id: created.productId }] : undefined,
      created.metaobjectId ? ["shopify_metaobject_delete", { id: created.metaobjectId }] : undefined,
    ];
    for (const cleanup of cleanups) if (cleanup) await callTool(client, ...cleanup);
    if (created.definitionId) {
      await callTool(client, "shopify_graphql", {
        query: "mutation ($id: ID!) { metaobjectDefinitionDelete(id: $id) { deletedId userErrors { message } } }",
        variables: { id: created.definitionId },
      });
    }
    if (created.customerId) {
      await callTool(client, "shopify_graphql", {
        query: "mutation ($input: CustomerDeleteInput!) { customerDelete(input: $input) { deletedCustomerId userErrors { message } } }",
        variables: { input: { id: created.customerId } },
      });
    }
    await client.close();
  }, TIMEOUT);

  it("reports userErrors from a rejected create", async () => {
    const result = await callTool(client, "shopify_product_create", { title: "" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("userErrors");
  });

  it("creates, updates, and reads a draft product", async () => {
    const d = await data(client, "shopify_product_create", {
      title: label,
      status: "DRAFT",
      descriptionHtml: "<p>temporary</p>",
      tags: ["mcp-test"],
    });
    created.productId = d.productCreate.product.id;

    await data(client, "shopify_product_update", {
      id: created.productId,
      title: `${label} (updated)`,
      descriptionHtml: "",
    });
    const got = await data(client, "shopify_product_get", { id: created.productId });
    expect(got.product.title).toBe(`${label} (updated)`);
    expect(got.product.descriptionHtml).toBe("");
    expect(got.product.status).toBe("DRAFT");
  });

  it("sets, lists, and deletes a metafield", async () => {
    const ownerId = created.productId!;
    const identifier = { ownerId, namespace: "mcp_test", key: "note" };

    await data(client, "shopify_metafields_set", {
      metafields: [{ ...identifier, value: "hello", type: "single_line_text_field" }],
    });
    const listed = await data(client, "shopify_metafields_list", { ownerId, namespace: "mcp_test" });
    expect(listed.node.metafields.nodes).toEqual([expect.objectContaining({ key: "note", value: "hello" })]);

    const deleted = await data(client, "shopify_metafield_delete", identifier);
    expect(deleted.metafieldsDelete.deletedMetafields).toEqual([identifier]);
  });

  it("adjusts inventory with compare-and-swap and idempotency", async () => {
    const setup = await graphql(
      client,
      `query ($id: ID!) {
        product(id: $id) {
          variants(first: 1) {
            nodes { inventoryItem { id tracked inventoryLevels(first: 1) { nodes { location { id } } } } }
          }
        }
        locations(first: 1) { nodes { id } }
      }`,
      { id: created.productId }
    );
    const item = setup.product.variants.nodes[0].inventoryItem;
    let locationId: string = item.inventoryLevels.nodes[0]?.location.id ?? setup.locations.nodes[0].id;

    if (!item.tracked) {
      await graphql(
        client,
        "mutation ($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { inventoryItem { tracked } userErrors { field message } } }",
        { id: item.id }
      );
    }
    if (item.inventoryLevels.nodes.length === 0) {
      await graphql(
        client,
        `mutation ($inventoryItemId: ID!, $locationId: ID!, $key: String!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $key) {
            inventoryLevel { id }
            userErrors { field message }
          }
        }`,
        { inventoryItemId: item.id, locationId, key: randomUUID() }
      );
    }

    const available = async () => {
      const d = await data(client, "shopify_inventory_get_levels", { inventoryItemId: item.id });
      const level = d.inventoryItem.inventoryLevels.nodes.find((n: Data) => n.location.id === locationId);
      return level.quantities.find((q: Data) => q.name === "available").quantity as number;
    };
    const start = await available();
    const adjust = (delta: number, changeFromQuantity: number | null) =>
      callTool(client, "shopify_inventory_adjust", { inventoryItemId: item.id, locationId, delta, changeFromQuantity });

    const added = await adjust(5, start);
    expect(added.isError, resultText(added)).toBeFalsy();
    expect(await available()).toBe(start + 5);

    // The quantity moved, so a check against the old value must be rejected
    const stale = await adjust(1, start);
    expect(stale.isError).toBe(true);
    expect(await available()).toBe(start + 5);

    const reverted = await adjust(-5, null);
    expect(reverted.isError, resultText(reverted)).toBeFalsy();
    expect(await available()).toBe(start);
  });

  it("creates a collection with a manual source, updates it, and deletes it", async () => {
    const d = await data(client, "shopify_collection_create", {
      title: label,
      descriptionHtml: "<p>temporary</p>",
      sources: [{ source: { title: "MCP test picks", inclusion: { selections: [{ productId: created.productId }] } } }],
    });
    created.collectionId = d.collectionCreate.collection.id;

    await data(client, "shopify_collection_update", { id: created.collectionId, title: `${label} (updated)`, descriptionHtml: "" });
    const got = await data(client, "shopify_collection_get", { id: created.collectionId });
    expect(got.collection.title).toBe(`${label} (updated)`);
    expect(got.collection.sources).toHaveLength(1);

    const deleted = await data(client, "shopify_collection_delete", { id: created.collectionId });
    expect(deleted.collectionDelete.deletedCollectionId).toBe(created.collectionId);
    created.collectionId = undefined;
  });

  it("creates, updates, and deletes a metaobject", async () => {
    const type = `mcp_test_${Date.now()}`;
    const def = await graphql(
      client,
      `mutation ($definition: MetaobjectDefinitionCreateInput!) {
        metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id type } userErrors { field message } }
      }`,
      { definition: { type, name: "MCP test", fieldDefinitions: [{ key: "name", name: "Name", type: "single_line_text_field" }] } }
    );
    created.definitionId = def.metaobjectDefinitionCreate.metaobjectDefinition.id;

    const d = await data(client, "shopify_metaobject_create", { type, fields: [{ key: "name", value: "one" }] });
    created.metaobjectId = d.metaobjectCreate.metaobject.id;

    await data(client, "shopify_metaobject_update", { id: created.metaobjectId, fields: [{ key: "name", value: "two" }] });
    const got = await data(client, "shopify_metaobject_get", { id: created.metaobjectId });
    expect(got.metaobject.fields).toEqual([expect.objectContaining({ key: "name", value: "two" })]);

    const deleted = await data(client, "shopify_metaobject_delete", { id: created.metaobjectId });
    expect(deleted.metaobjectDelete.deletedId).toBe(created.metaobjectId);
    created.metaobjectId = undefined;
  });

  it("updates a customer it created", async () => {
    const c = await graphql(
      client,
      "mutation ($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }",
      { input: { firstName: "MCP", lastName: "Test", email: `mcp-test+${Date.now()}@example.com`, tags: ["mcp-test"] } }
    );
    created.customerId = c.customerCreate.customer.id;

    await data(client, "shopify_customer_update", { id: created.customerId, note: "temporary", tags: ["mcp-test", "updated"] });
    await data(client, "shopify_customer_update", { id: created.customerId, note: "" });
    const got = await data(client, "shopify_customer_get", { id: created.customerId });
    expect(got.customer.tags.sort()).toEqual(["mcp-test", "updated"]);
    expect(got.customer.note ?? "").toBe("");
  });

  it("deletes the test product", async () => {
    const deleted = await data(client, "shopify_product_delete", { id: created.productId });
    expect(deleted.productDelete.deletedProductId).toBe(created.productId);
    created.productId = undefined;
  });
});
