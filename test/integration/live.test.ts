/**
 * Runs against a real store. Skipped unless credentials are set:
 *   SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN (or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)
 * Write tests also need SHOPIFY_TEST_WRITES=1. They only touch "[MCP test]" entities
 * they create, and delete them afterwards. Use a development store.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthProvider } from "../../src/auth/provider.js";
import { GraphQLClient } from "../../src/graphql/client.js";
import { runIntrospection } from "../../src/graphql/introspection.js";
import { SchemaIndex } from "../../src/graphql/schema-index.js";
import { createServer, type ServerOptions } from "../../src/server.js";
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

async function connectLive(readOnly: boolean, options: Partial<ServerOptions> = {}) {
  const config = { ...parseArgs(["node", "shopify-admin-mcp"]), readOnly, ...options };
  const graphql = new GraphQLClient(new AuthProvider(config), config);
  const schema = await runIntrospection(graphql);
  const server = createServer(graphql, async () => new SchemaIndex(schema), config);
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries `check` until it returns a value, for changes Shopify applies asynchronously. */
async function eventually<T>(check: () => Promise<T | undefined>, attempts = 40, delayMs = 3000): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check();
    if (value !== undefined) return value;
    await pause(delayMs);
  }
  throw new Error("Timed out waiting for Shopify to finish processing");
}

// A valid 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

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

  it("lists publications, files, metafield definitions, and markets", async () => {
    const publications = await data(client, "shopify_publications_list");
    expect(publications.publications.nodes.length).toBeGreaterThan(0);
    await data(client, "shopify_files_list", { first: 5 });
    await data(client, "shopify_metafield_definitions_list", { ownerType: "PRODUCT", first: 5 });

    const markets = await data(client, "shopify_markets_list", { first: 5 });
    const market = markets.markets.nodes[0];
    if (market) {
      const got = await data(client, "shopify_market_get", { id: market.id });
      expect(got.market.id).toBe(market.id);
    }
  });

  it("reads the live theme's files without changing them", async () => {
    const themes = await data(client, "shopify_themes_list", { roles: ["MAIN"] });
    const main = themes.themes.nodes[0];
    const list = await data(client, "shopify_theme_files_list", { themeId: main.id, filenames: ["layout/*"] });
    expect(list.theme.files.nodes.map((f: Data) => f.filename)).toContain("layout/theme.liquid");

    const got = await data(client, "shopify_theme_files_get", { themeId: main.id, filenames: ["layout/theme.liquid"] });
    expect(got.theme.files.nodes[0].body.content).toContain("<html");
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
    metafieldDefinitionId?: string;
    customerId?: string;
    fileIds: string[];
  } = { fileIds: [] };
  let client: Client;
  let uploadDir: string;

  beforeAll(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), "shopify-mcp-live-"));
    await writeFile(path.join(uploadDir, "mcp-test.png"), PNG);
    ({ client } = await connectLive(false, { uploadDir }));
  }, TIMEOUT);

  // Best-effort cleanup so a failed assertion never leaves test data behind
  afterAll(async () => {
    if (!client) return;
    const cleanups: Array<[string, Record<string, unknown>] | undefined> = [
      created.fileIds.length ? ["shopify_file_delete", { fileIds: created.fileIds }] : undefined,
      created.collectionId ? ["shopify_collection_delete", { id: created.collectionId }] : undefined,
      created.productId ? ["shopify_product_delete", { id: created.productId }] : undefined,
      created.metaobjectId ? ["shopify_metaobject_delete", { id: created.metaobjectId }] : undefined,
    ];
    for (const cleanup of cleanups) if (cleanup) await callTool(client, ...cleanup);
    if (created.metafieldDefinitionId) {
      await callTool(client, "shopify_graphql", {
        query: "mutation ($id: ID!) { metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) { deletedDefinitionId userErrors { message } } }",
        variables: { id: created.metafieldDefinitionId },
      });
    }
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
    await rm(uploadDir, { recursive: true, force: true });
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
      productOptions: [{ name: "Size", values: ["S"] }],
    });
    created.productId = d.productCreate.product.id;
    expect(d.productCreate.product.options).toEqual([{ name: "Size", values: ["S"] }]);

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

  it("adds and updates variants", async () => {
    const productId = created.productId!;
    const added = await data(client, "shopify_product_variants_create", {
      productId,
      variants: [
        { optionValues: [{ optionName: "Size", name: "M" }], price: "120000", sku: "MCP-TEST-M" },
        { optionValues: [{ optionName: "Size", name: "L" }], price: "130000", sku: "MCP-TEST-L" },
      ],
    });
    const medium = added.productVariantsBulkCreate.productVariants.find((v: Data) => v.sku === "MCP-TEST-M");
    expect(medium.selectedOptions).toEqual([{ name: "Size", value: "M" }]);

    const updated = await data(client, "shopify_product_variants_update", {
      productId,
      variants: [{ id: medium.id, price: "99000", compareAtPrice: "150000", sku: "MCP-TEST-M2" }],
    });
    const variant = updated.productVariantsBulkUpdate.productVariants[0];
    expect(Number(variant.price)).toBe(99000);
    expect(Number(variant.compareAtPrice)).toBe(150000);
    expect(variant.sku).toBe("MCP-TEST-M2");

    const got = await data(client, "shopify_product_get", { id: productId });
    expect(got.product.variants.nodes.map((v: Data) => v.title).sort()).toEqual(["L", "M", "S"]);
  });

  it("publishes and unpublishes the product", async () => {
    const publications = await data(client, "shopify_publications_list");
    const publicationIds = [publications.publications.nodes[0].id];

    const published = await data(client, "shopify_publish", { id: created.productId, publicationIds });
    expect(published.publishablePublish.publishable.id).toBe(created.productId);
    await data(client, "shopify_unpublish", { id: created.productId, publicationIds });
  });

  it("uploads a local image, attaches it to the product, and deletes it", async () => {
    const d = await data(client, "shopify_file_upload", {
      path: "mcp-test.png",
      alt: "MCP test image",
      productId: created.productId,
    });
    created.fileIds.push(d.file.id);
    expect(d.file.fileStatus).toBe("READY");
    expect(d.file.image.url).toMatch(/^https:\/\/cdn\.shopify\.com\//);
    expect(d.fileUpdate.userErrors).toEqual([]);

    const media = await graphql(client, "query ($id: ID!) { product(id: $id) { media(first: 10) { nodes { id } } } }", {
      id: created.productId,
    });
    expect(media.product.media.nodes.length).toBeGreaterThan(0);
  });

  it("uploads a file from a URL", async () => {
    const source = await graphql(client, "{ files(first: 1, query: \"media_type:IMAGE status:READY\") { nodes { ... on MediaImage { image { url } } } } }");
    const url = source.files.nodes[0]?.image?.url;
    if (!url) return;

    // Shopify requires a custom filename to keep the source's extension
    const filename = `mcp-test-from-url${path.extname(new URL(url).pathname)}`;
    const d = await data(client, "shopify_file_upload", { url, filename });
    created.fileIds.push(d.file.id);
    expect(d.file.fileStatus).toBe("READY");

    const deleted = await data(client, "shopify_file_delete", { fileIds: created.fileIds });
    expect(deleted.fileDelete.deletedFileIds.sort()).toEqual([...created.fileIds].sort());
    created.fileIds = [];
  });

  it("refuses local files outside the upload directory", async () => {
    const result = await callTool(client, "shopify_file_upload", { path: "/etc/hosts" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("outside the upload directory");
  });

  it("creates and lists a metafield definition", async () => {
    const key = `def_${Date.now()}`;
    const d = await data(client, "shopify_metafield_definition_create", {
      ownerType: "PRODUCT",
      namespace: "mcp_test",
      key,
      name: "MCP test",
      type: "single_line_text_field",
      validations: [{ name: "max", value: "50" }],
    });
    created.metafieldDefinitionId = d.metafieldDefinitionCreate.createdDefinition.id;

    const listed = await data(client, "shopify_metafield_definitions_list", { ownerType: "PRODUCT", namespace: "mcp_test" });
    expect(listed.metafieldDefinitions.nodes.map((n: Data) => n.key)).toContain(key);
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

    await data(client, "shopify_collection_update", {
      id: created.collectionId,
      sourcesToCreate: [{ source: { title: "MCP test extra", inclusion: { selections: [{ productId: created.productId }] } } }],
    });
    const withExtra = await data(client, "shopify_collection_get", { id: created.collectionId });
    expect(withExtra.collection.sources).toHaveLength(2);

    const extra = withExtra.collection.sources.find((source: Data) => source.title === "MCP test extra");
    await data(client, "shopify_collection_update", { id: created.collectionId, sourcesToDelete: [extra.id] });
    const afterDelete = await data(client, "shopify_collection_get", { id: created.collectionId });
    expect(afterDelete.collection.sources).toHaveLength(1);

    const deleted = await data(client, "shopify_collection_delete", { id: created.collectionId });
    expect(deleted.collectionDelete.deletedCollectionId).toBe(created.collectionId);
    created.collectionId = undefined;
  });

  it("creates a metaobject definition, then creates, upserts, updates, and deletes an entry", async () => {
    const type = `mcp_test_${Date.now()}`;
    const def = await data(client, "shopify_metaobject_definition_create", {
      type,
      name: "MCP test",
      displayNameKey: "name",
      fieldDefinitions: [{ key: "name", name: "Name", type: "single_line_text_field", required: true }],
    });
    created.definitionId = def.metaobjectDefinitionCreate.metaobjectDefinition.id;

    const d = await data(client, "shopify_metaobject_create", { type, handle: "mcp-one", fields: [{ key: "name", value: "one" }] });
    created.metaobjectId = d.metaobjectCreate.metaobject.id;

    const upserted = await data(client, "shopify_metaobject_upsert", { type, handle: "mcp-one", fields: [{ key: "name", value: "two" }] });
    expect(upserted.metaobjectUpsert.metaobject.id).toBe(created.metaobjectId);

    await data(client, "shopify_metaobject_update", { id: created.metaobjectId, fields: [{ key: "name", value: "three" }] });
    const got = await data(client, "shopify_metaobject_get", { id: created.metaobjectId });
    expect(got.metaobject.fields).toEqual([expect.objectContaining({ key: "name", value: "three" })]);

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

describe.skipIf(!writesEnabled)("live store: themes", { timeout: 300_000 }, () => {
  let client: Client;
  let mainThemeId: string;
  let copyId: string | undefined;

  beforeAll(async () => {
    ({ client } = await connectLive(false));
    const themes = await data(client, "shopify_themes_list", { roles: ["MAIN"] });
    mainThemeId = themes.themes.nodes[0].id;
  }, TIMEOUT);

  afterAll(async () => {
    if (copyId) await callTool(client, "shopify_theme_delete", { themeId: copyId });
    await client?.close();
  }, TIMEOUT);

  it("duplicates the live theme and waits for the copy to finish processing", async () => {
    const d = await data(client, "shopify_theme_duplicate", { themeId: mainThemeId, name: `[MCP test] ${Date.now()}` });
    copyId = d.themeDuplicate.newTheme.id;
    expect(d.themeDuplicate.newTheme.role).not.toBe("MAIN");

    await eventually(async () => {
      const themes = await data(client, "shopify_themes_list");
      const copy = themes.themes.nodes.find((t: Data) => t.id === copyId);
      return copy && !copy.processing ? copy : undefined;
    });
  });

  it("writes, reads, and deletes a file in the copy", async () => {
    const filename = "snippets/mcp-test.liquid";
    const content = `{% comment %}MCP test ${Date.now()}{% endcomment %}`;

    const upserted = await data(client, "shopify_theme_files_upsert", { themeId: copyId, files: [{ filename, content }] });
    expect(upserted.themeFilesUpsert.upsertedThemeFiles).toEqual([{ filename }]);

    const body = await eventually(async () => {
      // The file reports an error until Shopify's upsert job has written it
      const got = await callTool(client, "shopify_theme_files_get", { themeId: copyId, filenames: [filename] });
      if (got.isError) return undefined;
      const file = JSON.parse(resultText(got)).data.theme.files.nodes[0];
      return file?.body.content === content ? file.body.content : undefined;
    }, 10, 1000);
    expect(body).toBe(content);

    const deleted = await data(client, "shopify_theme_files_delete", { themeId: copyId, filenames: [filename] });
    expect(deleted.themeFilesDelete.deletedThemeFiles).toEqual([{ filename }]);
  });

  it("sends files from a theme folder by filename and pulls them back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shopify-mcp-live-theme-"));
    const sendDir = path.join(root, "send");
    const pullDir = path.join(root, "pull");
    const stamp = Date.now();
    const files: Record<string, Buffer> = {
      "snippets/mcp-test-local.liquid": Buffer.from(`{% comment %}MCP test ${stamp}{% endcomment %}\n`),
      // A 1x1 PNG, so the file goes as base64
      "assets/mcp-test.png": Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      ),
      // Shopify adds its generated header to JSON templates, so this one comes back changed
      "templates/page.mcp-test.json": Buffer.from(JSON.stringify({ sections: { main: { type: "main-page", settings: {} } }, order: ["main"] })),
    };
    const filenames = Object.keys(files);
    const local = await connectLive(false, { themeDir: sendDir });
    try {
      for (const [filename, data] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(sendDir, filename)), { recursive: true });
        await writeFile(path.join(sendDir, filename), data);
      }

      const sent = await callTool(local.client, "shopify_theme_files_upsert", { themeId: copyId, files: filenames.map((filename) => ({ filename })) });
      expect(sent.isError, resultText(sent).slice(0, 500)).toBeFalsy();
      const reports = JSON.parse(resultText(sent)).files as Array<{ filename: string; stored: string; themeFolder?: string }>;
      console.log("upsert from the theme folder:", JSON.stringify(reports));
      for (const report of reports) expect(["as sent", "changed by Shopify"], report.filename).toContain(report.stored);
      expect(reports.find((r) => r.filename === "snippets/mcp-test-local.liquid")?.stored).toBe("as sent");
      for (const report of reports.filter((r) => r.stored === "changed by Shopify")) {
        expect(report.themeFolder).toBe("updated to Shopify's copy");
      }

      // Pulling into an empty folder gives the same bytes as the send folder, which now matches Shopify
      const puller = await connectLive(false, { themeDir: pullDir });
      await mkdir(pullDir);
      const pulled = await callTool(puller.client, "shopify_theme_files_pull", { themeId: copyId, filenames });
      expect(pulled.isError, resultText(pulled).slice(0, 500)).toBeFalsy();
      console.log("pull:", JSON.stringify(JSON.parse(resultText(pulled)).files));
      for (const filename of filenames) {
        expect(await readFile(path.join(pullDir, filename)), filename).toEqual(await readFile(path.join(sendDir, filename)));
      }
      expect(resultText(pulled)).not.toContain(`MCP test ${stamp}`);

      // Pulling again leaves every file alone
      const again = JSON.parse(resultText(await callTool(puller.client, "shopify_theme_files_pull", { themeId: copyId, filenames })));
      expect(again.files.map((f: Data) => f.status)).toEqual(filenames.map(() => "unchanged"));
      await puller.client.close();
    } finally {
      await callTool(local.client, "shopify_theme_files_delete", { themeId: copyId, filenames });
      await local.client.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to write to the live theme", async () => {
    const result = await callTool(client, "shopify_theme_files_upsert", {
      themeId: mainThemeId,
      files: [{ filename: "snippets/mcp-test.liquid", content: "x" }],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("live theme");
  });

  it("refuses raw GraphQL writes to the live theme", async () => {
    const result = await callTool(client, "shopify_graphql", {
      query:
        "mutation ($themeId: ID!) { themeFilesUpsert(themeId: $themeId, files: [{ filename: \"snippets/mcp-test.liquid\", body: { type: TEXT, value: \"x\" } }]) { userErrors { message } } }",
      variables: { themeId: mainThemeId },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("live theme");
  });

  it("deletes the copy", async () => {
    const d = await data(client, "shopify_theme_delete", { themeId: copyId });
    expect(d.themeDelete.deletedThemeId).toBe(copyId);
    copyId = undefined;
  });
});

describe.skipIf(!writesEnabled)("live store: markets", { timeout: TIMEOUT }, () => {
  let client: Client;
  let marketId: string | undefined;

  beforeAll(async () => {
    ({ client } = await connectLive(false));
  }, TIMEOUT);

  afterAll(async () => {
    if (marketId) await callTool(client, "shopify_market_delete", { id: marketId });
    await client?.close();
  }, TIMEOUT);

  it("creates a draft market", async () => {
    const d = await data(client, "shopify_market_create", {
      name: `[MCP test] ${Date.now()}`,
      status: "DRAFT",
      countryCodes: ["SG"],
      currencySettings: { baseCurrency: "SGD", localCurrencies: false },
    });
    const market = d.marketCreate.market;
    marketId = market.id;
    expect(market.status).toBe("DRAFT");
    expect(market.conditions.regionsCondition.regions.nodes.map((r: Data) => r.code)).toEqual(["SG"]);
    expect(market.currencySettings.baseCurrency.currencyCode).toBe("SGD");
  });

  it("updates its name and countries", async () => {
    const d = await data(client, "shopify_market_update", {
      id: marketId,
      name: "[MCP test] SEA",
      addCountryCodes: ["MY"],
      removeCountryCodes: ["SG"],
    });
    const market = d.marketUpdate.market;
    expect(market.name).toBe("[MCP test] SEA");
    expect(market.conditions.regionsCondition.regions.nodes.map((r: Data) => r.code)).toEqual(["MY"]);

    const got = await data(client, "shopify_market_get", { id: marketId });
    expect(got.market.status).toBe("DRAFT");
  });

  it("deletes it", async () => {
    const d = await data(client, "shopify_market_delete", { id: marketId });
    expect(d.marketDelete.deletedId).toBe(marketId);
    marketId = undefined;
  });
});

describe.skipIf(!writesEnabled)("live store: discounts", { timeout: TIMEOUT }, () => {
  const stamp = Date.now();
  // A year out, so none of these discounts can apply to real carts while the tests run
  const startsAt = new Date(stamp + 365 * 24 * 60 * 60 * 1000).toISOString();
  const created: string[] = [];
  let client: Client;
  let productId: string;
  let collectionId: string;

  beforeAll(async () => {
    ({ client } = await connectLive(false));
    const d = await graphql(client, "{ products(first: 1) { nodes { id } } collections(first: 1) { nodes { id } } }");
    productId = d.products.nodes[0].id;
    collectionId = d.collections.nodes[0].id;
  }, TIMEOUT);

  afterAll(async () => {
    for (const id of created) await callTool(client, "shopify_discount_delete", { id });
    await client?.close();
  }, TIMEOUT);

  const create = async (tool: string, args: Record<string, unknown>) => {
    const d = await data(client, tool, { startsAt, ...args });
    const payload = Object.values(d)[0] as Data;
    const node = payload.codeDiscountNode ?? payload.automaticDiscountNode;
    created.push(node.id);
    return { id: node.id as string, discount: (node.codeDiscount ?? node.automaticDiscount) as Data };
  };

  it("creates amount-off, free shipping, and buy X get Y discounts as codes and automatic", async () => {
    const percent = await create("shopify_discount_amount_off_create", {
      method: "code", title: `[MCP test] percent ${stamp}`, code: `MCPTEST${stamp}`, percentOff: 10,
      minimumSubtotal: "50000", usageLimit: 5, appliesOncePerCustomer: true,
    });
    expect(percent.discount).toMatchObject({ __typename: "DiscountCodeBasic", status: "SCHEDULED", usageLimit: 5 });
    expect(percent.discount.codes.nodes).toEqual([{ code: `MCPTEST${stamp}` }]);

    const fixed = await create("shopify_discount_amount_off_create", {
      method: "automatic", title: `[MCP test] fixed ${stamp}`, amountOff: "5000", collectionIds: [collectionId], minimumQuantity: 2,
    });
    expect(fixed.discount).toMatchObject({ __typename: "DiscountAutomaticBasic", status: "SCHEDULED" });

    const shipping = await create("shopify_discount_free_shipping_create", {
      method: "code", title: `[MCP test] ship ${stamp}`, code: `MCPSHIP${stamp}`, countryCodes: ["ID"], maximumShippingPrice: "20000",
    });
    expect(shipping.discount.__typename).toBe("DiscountCodeFreeShipping");

    const autoShipping = await create("shopify_discount_free_shipping_create", {
      method: "automatic", title: `[MCP test] auto ship ${stamp}`, minimumSubtotal: "100000",
    });
    expect(autoShipping.discount.__typename).toBe("DiscountAutomaticFreeShipping");

    const bogo = await create("shopify_discount_bxgy_create", {
      method: "code", title: `[MCP test] bogo ${stamp}`, code: `MCPBOGO${stamp}`,
      buys: { quantity: 2, productIds: [productId] }, gets: { quantity: 1, productIds: [productId] }, usesPerOrderLimit: 1,
    });
    expect(bogo.discount.__typename).toBe("DiscountCodeBxgy");

    const autoBogo = await create("shopify_discount_bxgy_create", {
      method: "automatic", title: `[MCP test] auto bogo ${stamp}`,
      buys: { amount: "100000", collectionIds: [collectionId] },
      gets: { quantity: 1, productIds: [productId], percentOff: 50 }, usesPerOrderLimit: 2,
    });
    expect(autoBogo.discount.__typename).toBe("DiscountAutomaticBxgy");
  });

  it("lists and gets the new discounts", async () => {
    const listed = await data(client, "shopify_discounts_list", { first: 20 });
    const ids = listed.discountNodes.nodes.map((n: Data) => n.id);
    for (const id of created) expect(ids).toContain(id);

    const got = await data(client, "shopify_discount_get", { id: created[0] });
    expect(got.discountNode.discount.summary).toBeTruthy();
  });

  it("adds codes to a code discount", async () => {
    const d = await data(client, "shopify_discount_codes_add", {
      discountId: created[0],
      codes: [`MCPTEST${stamp}A`, `MCPTEST${stamp}B`],
    });
    expect(d.discountRedeemCodeBulkAdd.bulkCreation.codesCount).toBe(2);

    const count = await eventually(async () => {
      const got = await data(client, "shopify_discount_get", { id: created[0] });
      const n = got.discountNode.discount.codesCount.count;
      return n === 3 ? n : undefined;
    }, 15, 2000);
    expect(count).toBe(3);
  });

  it("activates and deactivates a code discount", async () => {
    const activated = await data(client, "shopify_discount_activate", { id: created[0] });
    expect(activated.discountCodeActivate.codeDiscountNode.codeDiscount.status).toBe("ACTIVE");

    const deactivated = await data(client, "shopify_discount_deactivate", { id: created[0] });
    expect(deactivated.discountCodeDeactivate.codeDiscountNode.codeDiscount.status).toBe("EXPIRED");
  });

  it("deletes code and automatic discounts", async () => {
    while (created.length > 0) {
      const id = created.pop()!;
      const d = await data(client, "shopify_discount_delete", { id });
      const deletedId = d.discountCodeDelete?.deletedCodeDiscountId ?? d.discountAutomaticDelete?.deletedAutomaticDiscountId;
      expect(deletedId).toBe(id);
    }
  });
});
