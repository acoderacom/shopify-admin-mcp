import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connect, resultText, type FakeGraphQLClient } from "./helpers.js";

let client: Client;
let fake: FakeGraphQLClient;

beforeEach(async () => {
  ({ client, fake } = await connect());
});

const PRODUCT = "gid://shopify/Product/1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One representative call per tool, with the root field it must hit and the variables it must send
const toolCalls: Array<{
  tool: string;
  args: Record<string, unknown>;
  field: string;
  variables?: Record<string, unknown>;
}> = [
  { tool: "shopify_products_list", args: {}, field: "products(", variables: { first: 10 } },
  { tool: "shopify_product_get", args: { id: PRODUCT }, field: "product(", variables: { id: PRODUCT } },
  {
    tool: "shopify_product_create",
    args: { title: "Hat", status: "DRAFT", tags: ["a"] },
    field: "productCreate(product: $product)",
    variables: { product: { title: "Hat", status: "DRAFT", tags: ["a"] } },
  },
  {
    tool: "shopify_product_update",
    args: { id: PRODUCT, descriptionHtml: "" },
    field: "productUpdate(product: $product)",
    variables: { product: { id: PRODUCT, descriptionHtml: "" } },
  },
  { tool: "shopify_product_delete", args: { id: PRODUCT }, field: "productDelete(", variables: { input: { id: PRODUCT } } },
  { tool: "shopify_collections_list", args: { first: 250, after: "c1" }, field: "collections(", variables: { first: 250, after: "c1" } },
  {
    tool: "shopify_collection_get",
    args: { id: "gid://shopify/Collection/1" },
    field: "collection(",
    variables: { id: "gid://shopify/Collection/1", productsFirst: 10 },
  },
  {
    tool: "shopify_collection_create",
    args: { title: "Summer", sources: [{ source: { title: "Picks", inclusion: { selections: [{ productId: PRODUCT }] } } }] },
    field: "collectionCreate(collection: $collection)",
    variables: {
      collection: { title: "Summer", sources: [{ source: { title: "Picks", inclusion: { selections: [{ productId: PRODUCT }] } } }] },
    },
  },
  {
    tool: "shopify_collection_update",
    args: { id: "gid://shopify/Collection/1", title: "Winter" },
    field: "collectionUpdate(collection: $collection)",
    variables: { collection: { id: "gid://shopify/Collection/1", title: "Winter" } },
  },
  {
    tool: "shopify_collection_delete",
    args: { id: "gid://shopify/Collection/1" },
    field: "collectionDelete(",
    variables: { input: { id: "gid://shopify/Collection/1" } },
  },
  { tool: "shopify_customers_list", args: { query: "tag:vip" }, field: "customers(", variables: { first: 10, query: "tag:vip" } },
  { tool: "shopify_customer_get", args: { id: "gid://shopify/Customer/1" }, field: "customer(" },
  {
    tool: "shopify_customer_update",
    args: { id: "gid://shopify/Customer/1", note: "" },
    field: "customerUpdate(",
    variables: { input: { id: "gid://shopify/Customer/1", note: "" } },
  },
  { tool: "shopify_orders_list", args: {}, field: "orders(" },
  { tool: "shopify_order_get", args: { id: "gid://shopify/Order/1" }, field: "order(" },
  {
    tool: "shopify_inventory_get_levels",
    args: { inventoryItemId: "gid://shopify/InventoryItem/1" },
    field: "inventoryItem(",
    variables: { id: "gid://shopify/InventoryItem/1" },
  },
  {
    tool: "shopify_inventory_adjust",
    args: {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      locationId: "gid://shopify/Location/1",
      delta: 2,
      changeFromQuantity: 5,
    },
    field: "inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey)",
  },
  {
    tool: "shopify_metafields_list",
    args: { ownerId: PRODUCT, namespace: "custom" },
    field: "metafields(",
    variables: { ownerId: PRODUCT, first: 20, namespace: "custom" },
  },
  {
    tool: "shopify_metafields_set",
    args: { metafields: [{ ownerId: PRODUCT, namespace: "custom", key: "k", value: "v", type: "single_line_text_field" }] },
    field: "metafieldsSet(",
  },
  {
    tool: "shopify_metafield_delete",
    args: { ownerId: PRODUCT, namespace: "custom", key: "k" },
    field: "metafieldsDelete(metafields: $metafields)",
    variables: { metafields: [{ ownerId: PRODUCT, namespace: "custom", key: "k" }] },
  },
  { tool: "shopify_metaobject_definitions_list", args: {}, field: "metaobjectDefinitions(", variables: { first: 50 } },
  { tool: "shopify_metaobjects_list", args: { type: "school" }, field: "metaobjects(", variables: { type: "school", first: 20 } },
  { tool: "shopify_metaobject_get", args: { id: "gid://shopify/Metaobject/1" }, field: "metaobject(" },
  {
    tool: "shopify_metaobject_create",
    args: { type: "school", fields: [{ key: "name", value: "A" }] },
    field: "metaobjectCreate(",
    variables: { metaobject: { type: "school", fields: [{ key: "name", value: "A" }] } },
  },
  {
    tool: "shopify_metaobject_update",
    args: { id: "gid://shopify/Metaobject/1", fields: [{ key: "name", value: "B" }] },
    field: "metaobjectUpdate(",
    variables: { id: "gid://shopify/Metaobject/1", metaobject: { fields: [{ key: "name", value: "B" }] } },
  },
  {
    tool: "shopify_metaobject_delete",
    args: { id: "gid://shopify/Metaobject/1" },
    field: "metaobjectDelete(",
    variables: { id: "gid://shopify/Metaobject/1" },
  },
];

describe("tool registry", () => {
  it("registers 29 tools, each with behaviour annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(29);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
    }
  });

  it("marks deleting tools and raw GraphQL as destructive", async () => {
    const { tools } = await client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual([
      "shopify_collection_delete",
      "shopify_graphql",
      "shopify_metafield_delete",
      "shopify_metaobject_delete",
      "shopify_product_delete",
    ]);
  });

  it("covers every convenience tool in these tests", async () => {
    const { tools } = await client.listTools();
    const convenience = tools
      .map((t) => t.name)
      .filter((name) => !["shopify_graphql", "shopify_schema_search", "shopify_schema_details"].includes(name));
    expect(toolCalls.map((c) => c.tool).sort()).toEqual(convenience.sort());
  });
});

describe.each(toolCalls)("$tool", ({ tool, args, field, variables }) => {
  it("sends the expected operation", async () => {
    const result = await callTool(client, tool, args);

    expect(result.isError, resultText(result)).toBeFalsy();
    expect(fake.calls).toHaveLength(1);
    expect(fake.lastCall.query).toContain(field);
    if (variables) expect(fake.lastCall.variables).toEqual(variables);
  });

  it("avoids operations removed or deprecated in API 2026-10", async () => {
    await callTool(client, tool, args);
    const query = fake.lastCall.query;
    expect(query).not.toMatch(/\bmetafieldDelete\b|featuredImage|ruleSet|addresses \{|\bemail\b|\bphone\b/);
    expect(query).not.toMatch(/(productCreate|productUpdate|collectionCreate|collectionUpdate)\(input:/);
  });
});

describe("shopify_inventory_adjust", () => {
  const base = {
    inventoryItemId: "gid://shopify/InventoryItem/1",
    locationId: "gid://shopify/Location/1",
    delta: -3,
  };

  it("sends compare-and-swap quantity, default reason, and a fresh idempotency key", async () => {
    await callTool(client, "shopify_inventory_adjust", { ...base, changeFromQuantity: 10 });
    await callTool(client, "shopify_inventory_adjust", { ...base, changeFromQuantity: 10 });
    const [first, second] = fake.calls.map((c) => c.variables!);

    expect(first!.input).toEqual({
      reason: "correction",
      name: "available",
      changes: [{ ...base, changeFromQuantity: 10 }],
    });
    expect(first!.idempotencyKey).toMatch(UUID);
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it("sends an explicit null to opt out of the quantity check", async () => {
    await callTool(client, "shopify_inventory_adjust", { ...base, changeFromQuantity: null, reason: "damaged" });
    const input = fake.lastCall.variables!.input as { reason: string; changes: Array<Record<string, unknown>> };

    expect(input.reason).toBe("damaged");
    expect(input.changes[0]).toHaveProperty("changeFromQuantity", null);
  });

  it("requires changeFromQuantity", async () => {
    const result = await callTool(client, "shopify_inventory_adjust", base);
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("input validation", () => {
  it.each([0, 251, 1.5])("rejects page size %j", async (first) => {
    const result = await callTool(client, "shopify_products_list", { first });
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([0, 26])("rejects %i metafields in one metafieldsSet call", async (count) => {
    const metafields = Array.from({ length: count }, (_, i) => ({
      ownerId: PRODUCT, namespace: "custom", key: `k${i}`, value: "v", type: "single_line_text_field",
    }));
    const result = await callTool(client, "shopify_metafields_set", { metafields });
    expect(result.isError).toBe(true);
  });

  it("rejects an unknown product status", async () => {
    const result = await callTool(client, "shopify_product_create", { title: "Hat", status: "LIVE" });
    expect(result.isError).toBe(true);
  });
});

describe("error reporting", () => {
  it("flags mutation userErrors as a tool error", async () => {
    fake.responses.push({
      data: { productCreate: { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } },
    });
    const result = await callTool(client, "shopify_product_create", { title: "" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Title can't be blank");
  });

  it("flags top-level GraphQL errors as a tool error", async () => {
    fake.responses.push({ errors: [{ message: "Access denied for orders field" }] });
    const result = await callTool(client, "shopify_orders_list");
    expect(result.isError).toBe(true);
  });

  it("does not flag an empty userErrors list", async () => {
    fake.responses.push({ data: { productCreate: { product: { id: PRODUCT }, userErrors: [] } } });
    const result = await callTool(client, "shopify_product_create", { title: "Hat" });
    expect(result.isError).toBeFalsy();
  });

  it("reports network failures as a tool error", async () => {
    fake.responses.push(new Error("Shopify API request failed (502): Bad Gateway"));
    const result = await callTool(client, "shopify_product_get", { id: PRODUCT });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("502");
  });
});

describe("schema tools", () => {
  it("searches the introspected schema without calling Shopify", async () => {
    const result = await callTool(client, "shopify_schema_search", { query: "shop" });
    expect(resultText(result)).toContain("shop: Shop!");
    expect(fake.calls).toHaveLength(0);
  });

  it("returns type details", async () => {
    const result = await callTool(client, "shopify_schema_details", { name: "Shop" });
    expect(resultText(result)).toContain("# Shop (OBJECT)");
  });

  it("reports unknown names as an error", async () => {
    const result = await callTool(client, "shopify_schema_details", { name: "Nope" });
    expect(result.isError).toBe(true);
  });
});
