import { readFileSync } from "node:fs";
import { Kind, parse, visit } from "graphql";
import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SchemaIndex, lazySchemaIndex } from "../src/graphql/schema-index.js";
import { callTool, connect, resultText, schemaIndex, type FakeGraphQLClient } from "./helpers.js";

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
  {
    tool: "shopify_product_variants_create",
    args: { productId: PRODUCT, variants: [{ optionValues: [{ optionName: "Size", name: "M" }], price: "9.99", sku: "HAT-M" }] },
    field: "productVariantsBulkCreate(",
    variables: {
      productId: PRODUCT,
      variants: [{ optionValues: [{ optionName: "Size", name: "M" }], price: "9.99", inventoryItem: { sku: "HAT-M" } }],
    },
  },
  {
    tool: "shopify_product_variants_update",
    args: { productId: PRODUCT, variants: [{ id: "gid://shopify/ProductVariant/1", compareAtPrice: null }] },
    field: "productVariantsBulkUpdate(",
    variables: { productId: PRODUCT, variants: [{ id: "gid://shopify/ProductVariant/1", compareAtPrice: null }] },
  },
  { tool: "shopify_publications_list", args: {}, field: "publications(" },
  {
    tool: "shopify_publish",
    args: { id: PRODUCT, publicationIds: ["gid://shopify/Publication/1"], publishDate: "2030-01-01T00:00:00Z" },
    field: "publishablePublish(",
    variables: { id: PRODUCT, input: [{ publicationId: "gid://shopify/Publication/1", publishDate: "2030-01-01T00:00:00Z" }] },
  },
  {
    tool: "shopify_unpublish",
    args: { id: PRODUCT, publicationIds: ["gid://shopify/Publication/1"] },
    field: "publishableUnpublish(",
    variables: { id: PRODUCT, input: [{ publicationId: "gid://shopify/Publication/1" }] },
  },
  {
    tool: "shopify_metafield_definitions_list",
    args: { ownerType: "PRODUCT", namespace: "custom" },
    field: "metafieldDefinitions(",
    variables: { ownerType: "PRODUCT", namespace: "custom", first: 50 },
  },
  {
    tool: "shopify_metafield_definition_create",
    args: { ownerType: "PRODUCT", namespace: "custom", key: "fabric", name: "Fabric", type: "single_line_text_field" },
    field: "metafieldDefinitionCreate(",
    variables: { definition: { ownerType: "PRODUCT", namespace: "custom", key: "fabric", name: "Fabric", type: "single_line_text_field" } },
  },
  {
    tool: "shopify_metaobject_definition_create",
    args: { type: "designer", fieldDefinitions: [{ key: "name", type: "single_line_text_field" }] },
    field: "metaobjectDefinitionCreate(",
    variables: { definition: { type: "designer", fieldDefinitions: [{ key: "name", type: "single_line_text_field" }] } },
  },
  {
    tool: "shopify_metaobject_upsert",
    args: { type: "designer", handle: "ana", fields: [{ key: "name", value: "Ana" }] },
    field: "metaobjectUpsert(",
    variables: { handle: { type: "designer", handle: "ana" }, metaobject: { fields: [{ key: "name", value: "Ana" }] } },
  },
  { tool: "shopify_files_list", args: { query: "media_type:IMAGE" }, field: "files(", variables: { first: 20, query: "media_type:IMAGE" } },
  { tool: "shopify_file_delete", args: { fileIds: ["gid://shopify/MediaImage/1"] }, field: "fileDelete(", variables: { fileIds: ["gid://shopify/MediaImage/1"] } },
  { tool: "shopify_themes_list", args: { roles: ["MAIN"] }, field: "themes(", variables: { roles: ["MAIN"] } },
  {
    tool: "shopify_theme_files_list",
    args: { themeId: "gid://shopify/OnlineStoreTheme/1", filenames: ["sections/*"] },
    field: "files(filenames: $filenames",
    variables: { id: "gid://shopify/OnlineStoreTheme/1", filenames: ["sections/*"], first: 100 },
  },
  {
    tool: "shopify_theme_files_get",
    args: { themeId: "gid://shopify/OnlineStoreTheme/1", filenames: ["layout/theme.liquid"] },
    field: "OnlineStoreThemeFileBodyText",
    variables: { id: "gid://shopify/OnlineStoreTheme/1", filenames: ["layout/theme.liquid"] },
  },
  {
    tool: "shopify_theme_duplicate",
    args: { themeId: "gid://shopify/OnlineStoreTheme/1", name: "Copy" },
    field: "themeDuplicate(",
    variables: { id: "gid://shopify/OnlineStoreTheme/1", name: "Copy" },
  },
  { tool: "shopify_theme_delete", args: { themeId: "gid://shopify/OnlineStoreTheme/2" }, field: "themeDelete(", variables: { id: "gid://shopify/OnlineStoreTheme/2" } },
  { tool: "shopify_markets_list", args: {}, field: "markets(", variables: { first: 20 } },
  { tool: "shopify_market_get", args: { id: "gid://shopify/Market/1" }, field: "catalogs(", variables: { id: "gid://shopify/Market/1" } },
  {
    tool: "shopify_market_create",
    args: { name: "Singapore", status: "DRAFT", countryCodes: ["SG"], currencySettings: { baseCurrency: "SGD", localCurrencies: false } },
    field: "marketCreate(",
    variables: {
      input: {
        name: "Singapore",
        status: "DRAFT",
        conditions: { regionsCondition: { regions: [{ countryCode: "SG" }] } },
        currencySettings: { baseCurrency: "SGD", localCurrencies: false },
      },
    },
  },
  {
    tool: "shopify_market_update",
    args: { id: "gid://shopify/Market/1", name: "SEA", addCountryCodes: ["MY"], removeCountryCodes: ["SG"] },
    field: "marketUpdate(",
    variables: {
      id: "gid://shopify/Market/1",
      input: {
        name: "SEA",
        conditions: {
          conditionsToAdd: { regionsCondition: { regions: [{ countryCode: "MY" }] } },
          conditionsToDelete: { regionsCondition: { regions: [{ countryCode: "SG" }] } },
        },
      },
    },
  },
  { tool: "shopify_market_delete", args: { id: "gid://shopify/Market/1" }, field: "marketDelete(", variables: { id: "gid://shopify/Market/1" } },
  { tool: "shopify_discounts_list", args: { query: "status:active" }, field: "discountNodes(", variables: { first: 20, query: "status:active" } },
  { tool: "shopify_discount_get", args: { id: "gid://shopify/DiscountCodeNode/1" }, field: "discountNode(", variables: { id: "gid://shopify/DiscountCodeNode/1" } },
  {
    tool: "shopify_discount_amount_off_create",
    args: { method: "code", title: "Spring", code: "SPRING20", percentOff: 20, startsAt: "2030-01-01T00:00:00Z" },
    field: "discountCodeBasicCreate(basicCodeDiscount: $discount)",
    variables: {
      discount: {
        title: "Spring",
        code: "SPRING20",
        startsAt: "2030-01-01T00:00:00Z",
        context: { all: "ALL" },
        customerGets: { value: { percentage: 0.2 }, items: { all: true } },
      },
    },
  },
  {
    tool: "shopify_discount_free_shipping_create",
    args: { method: "automatic", title: "Free shipping ID", countryCodes: ["ID"], startsAt: "2030-01-01T00:00:00Z" },
    field: "discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: $discount)",
    variables: {
      discount: {
        title: "Free shipping ID",
        startsAt: "2030-01-01T00:00:00Z",
        context: { all: "ALL" },
        destination: { countries: { add: ["ID"] } },
      },
    },
  },
  {
    tool: "shopify_discount_bxgy_create",
    args: {
      method: "code",
      title: "BOGO",
      code: "BOGO",
      startsAt: "2030-01-01T00:00:00Z",
      buys: { quantity: 2, productIds: [PRODUCT] },
      gets: { quantity: 1, collectionIds: ["gid://shopify/Collection/1"] },
    },
    field: "discountCodeBxgyCreate(bxgyCodeDiscount: $discount)",
    variables: {
      discount: {
        title: "BOGO",
        code: "BOGO",
        startsAt: "2030-01-01T00:00:00Z",
        context: { all: "ALL" },
        customerBuys: { value: { quantity: "2" }, items: { products: { productsToAdd: [PRODUCT] } } },
        customerGets: {
          value: { discountOnQuantity: { quantity: "1", effect: { percentage: 1 } } },
          items: { collections: { add: ["gid://shopify/Collection/1"] } },
        },
      },
    },
  },
  { tool: "shopify_discount_activate", args: { id: "gid://shopify/DiscountCodeNode/1" }, field: "discountCodeActivate(", variables: { id: "gid://shopify/DiscountCodeNode/1" } },
  { tool: "shopify_discount_deactivate", args: { id: "gid://shopify/DiscountAutomaticNode/1" }, field: "discountAutomaticDeactivate(", variables: { id: "gid://shopify/DiscountAutomaticNode/1" } },
  { tool: "shopify_discount_delete", args: { id: "gid://shopify/DiscountCodeNode/1" }, field: "discountCodeDelete(", variables: { id: "gid://shopify/DiscountCodeNode/1" } },
  {
    tool: "shopify_discount_codes_add",
    args: { discountId: "gid://shopify/DiscountCodeNode/1", codes: ["VIP1", "VIP2"] },
    field: "discountRedeemCodeBulkAdd(",
    variables: { discountId: "gid://shopify/DiscountCodeNode/1", codes: [{ code: "VIP1" }, { code: "VIP2" }] },
  },
];

// Fields fetched with a fixed page size that report neither pageInfo nor a sibling count,
// so a caller couldn't tell that items were left out
function unreportedTruncation(query: string): string[] {
  const fields: string[] = [];
  visit(parse(query), {
    SelectionSet(node) {
      const siblings = new Set(node.selections.flatMap((s) => (s.kind === Kind.FIELD ? [s.name.value] : [])));
      for (const selection of node.selections) {
        if (selection.kind !== Kind.FIELD || !selection.arguments?.some((a) => a.name.value === "first")) continue;
        const hasPageInfo = selection.selectionSet?.selections.some(
          (s) => s.kind === Kind.FIELD && s.name.value === "pageInfo"
        );
        if (!hasPageInfo && !siblings.has(`${selection.name.value}Count`)) fields.push(selection.name.value);
      }
    },
  });
  return fields;
}

// A new product has exactly one variant, so its create response can't be cut short
const singleItemConnections: Record<string, string[]> = { shopify_product_create: ["variants"] };

// Multi-step tools with their own suites (themes.test.ts, files.test.ts)
const testedSeparately = ["shopify_theme_files_upsert", "shopify_theme_files_delete", "shopify_file_upload"];

describe("tool registry", () => {
  it("identifies itself with the package version", async () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(client.getServerVersion()).toEqual({ name: "shopify-admin-mcp", version });
  });

  it("gives the client instructions that match the server's options", async () => {
    expect(client.getInstructions()).toContain("gid://shopify/Product/123");
    expect(client.getInstructions()).toContain("shopify_graphql");

    const { client: readOnly } = await connect({ readOnly: true, disableRawGraphql: true });
    expect(readOnly.getInstructions()).toContain("read-only");
    expect(readOnly.getInstructions()).not.toContain("shopify_graphql");
  });

  it("registers 62 tools, each with behaviour annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(62);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
    }
  });

  it("marks deleting tools and raw GraphQL as destructive", async () => {
    const { tools } = await client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual([
      "shopify_collection_delete",
      "shopify_discount_delete",
      "shopify_file_delete",
      "shopify_graphql",
      "shopify_market_delete",
      "shopify_metafield_delete",
      "shopify_metaobject_delete",
      "shopify_product_delete",
      "shopify_theme_delete",
      "shopify_theme_files_delete",
    ]);
  });

  it("covers every convenience tool in these tests", async () => {
    const { tools } = await client.listTools();
    const convenience = tools
      .map((t) => t.name)
      .filter((name) => !["shopify_graphql", "shopify_schema_search", "shopify_schema_details"].includes(name));
    expect([...toolCalls.map((c) => c.tool), ...testedSeparately].sort()).toEqual(convenience.sort());
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

  it("reports when a list holds more items than it returned", async () => {
    await callTool(client, tool, args);
    expect(unreportedTruncation(fake.lastCall.query)).toEqual(singleItemConnections[tool] ?? []);
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

describe("product options and collection sources", () => {
  it("expands product option values into the API's option input", async () => {
    await callTool(client, "shopify_product_create", {
      title: "Hat",
      productOptions: [{ name: "Size", values: ["S", "M"] }],
    });
    expect(fake.lastCall.variables).toEqual({
      product: { title: "Hat", productOptions: [{ name: "Size", values: [{ name: "S" }, { name: "M" }] }] },
    });
  });

  it("passes collection source changes through on update", async () => {
    const sourcesToCreate = [{ source: { title: "Picks", inclusion: { selections: [{ productId: PRODUCT }] } } }];
    await callTool(client, "shopify_collection_update", {
      id: "gid://shopify/Collection/1",
      sourcesToCreate,
      sourcesToDelete: ["gid://shopify/CollectionSource/9"],
    });
    expect(fake.lastCall.variables).toEqual({
      collection: { id: "gid://shopify/Collection/1", sourcesToCreate, sourcesToDelete: ["gid://shopify/CollectionSource/9"] },
    });
  });

  it("rejects malformed market country codes", async () => {
    const result = await callTool(client, "shopify_market_create", { name: "X", countryCodes: ["sg"] });
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("discounts", () => {
  const base = { title: "Sale", startsAt: "2030-01-01T00:00:00Z" };

  it("restricts eligibility to customer segments", async () => {
    await callTool(client, "shopify_discount_amount_off_create", {
      ...base,
      method: "code",
      code: "VIP",
      percentOff: 10,
      customerSegmentIds: ["gid://shopify/Segment/1"],
      productIds: [PRODUCT],
      variantIds: ["gid://shopify/ProductVariant/1"],
    });

    const discount = fake.lastCall.variables!.discount as Record<string, unknown>;
    expect(discount.context).toEqual({ customerSegments: { add: ["gid://shopify/Segment/1"] } });
    expect(discount.customerGets).toEqual({
      value: { percentage: 0.1 },
      items: { products: { productsToAdd: [PRODUCT], productVariantsToAdd: ["gid://shopify/ProductVariant/1"] } },
    });
  });

  it("creates automatic amount-off discounts on collections with minimums and eligibility", async () => {
    await callTool(client, "shopify_discount_amount_off_create", {
      ...base,
      method: "automatic",
      amountOff: "10000",
      amountOffEachItem: true,
      collectionIds: ["gid://shopify/Collection/1"],
      minimumQuantity: 2,
      marketIds: ["gid://shopify/Market/1"],
      combinesWith: { shippingDiscounts: true },
    });

    expect(fake.lastCall.query).toContain("discountAutomaticBasicCreate(");
    expect(fake.lastCall.variables).toEqual({
      discount: {
        ...base,
        combinesWith: { shippingDiscounts: true },
        context: { markets: { add: ["gid://shopify/Market/1"] } },
        minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: "2" } },
        customerGets: {
          value: { discountAmount: { amount: "10000", appliesOnEachItem: true } },
          items: { collections: { add: ["gid://shopify/Collection/1"] } },
        },
      },
    });
  });

  it("defaults the start time to now", async () => {
    const before = Date.now();
    await callTool(client, "shopify_discount_amount_off_create", { method: "code", title: "Now", code: "NOW", percentOff: 5 });
    const startsAt = Date.parse((fake.lastCall.variables!.discount as { startsAt: string }).startsAt);
    expect(startsAt).toBeGreaterThanOrEqual(before - 1000);
    expect(startsAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("sends usesPerOrderLimit as a string for automatic buy X get Y discounts", async () => {
    await callTool(client, "shopify_discount_bxgy_create", {
      ...base,
      method: "automatic",
      buys: { amount: "100000", productIds: [PRODUCT] },
      gets: { quantity: 1, variantIds: ["gid://shopify/ProductVariant/1"], percentOff: 50 },
      usesPerOrderLimit: 2,
    });

    const discount = fake.lastCall.variables!.discount as Record<string, unknown>;
    expect(fake.lastCall.query).toContain("discountAutomaticBxgyCreate(");
    expect(discount.usesPerOrderLimit).toBe("2");
    expect(discount.customerBuys).toEqual({ value: { amount: "100000" }, items: { products: { productsToAdd: [PRODUCT] } } });
    expect(discount.customerGets).toEqual({
      value: { discountOnQuantity: { quantity: "1", effect: { percentage: 0.5 } } },
      items: { products: { productVariantsToAdd: ["gid://shopify/ProductVariant/1"] } },
    });
  });

  it.each([
    ["a code discount without a code", "shopify_discount_amount_off_create", { method: "code", percentOff: 10 }, "code is required"],
    ["an automatic discount with a code", "shopify_discount_amount_off_create", { method: "automatic", code: "X", percentOff: 10 }, "automatic discounts"],
    ["both percentOff and amountOff", "shopify_discount_amount_off_create", { method: "code", code: "X", percentOff: 10, amountOff: "5" }, "exactly one of percentOff or amountOff"],
    ["neither percentOff nor amountOff", "shopify_discount_amount_off_create", { method: "code", code: "X" }, "exactly one of percentOff or amountOff"],
    ["two minimums", "shopify_discount_free_shipping_create", { method: "code", code: "X", minimumSubtotal: "1", minimumQuantity: 1 }, "at most one of minimumSubtotal"],
    ["buy X get Y without items", "shopify_discount_bxgy_create", { method: "code", code: "X", buys: { quantity: 1 }, gets: { quantity: 1, productIds: [PRODUCT] } }, "need productIds"],
    ["buy X get Y with quantity and amount", "shopify_discount_bxgy_create", { method: "code", code: "X", buys: { quantity: 1, amount: "5", productIds: [PRODUCT] }, gets: { quantity: 1, productIds: [PRODUCT] } }, "exactly one of quantity or amount"],
    // Shopify's DiscountContextInput is a oneOf, so two kinds of eligibility fail the whole request
    ["customers and markets together", "shopify_discount_amount_off_create", { method: "code", code: "X", percentOff: 10, customerIds: ["gid://shopify/Customer/1"], marketIds: ["gid://shopify/Market/1"] }, "at most one of customerIds, customerSegmentIds, or marketIds"],
    ["segments and markets together", "shopify_discount_free_shipping_create", { method: "automatic", customerSegmentIds: ["gid://shopify/Segment/1"], marketIds: ["gid://shopify/Market/1"] }, "at most one of customerIds"],
    ["collections with products", "shopify_discount_amount_off_create", { method: "code", code: "X", percentOff: 10, productIds: [PRODUCT], collectionIds: ["gid://shopify/Collection/1"] }, "provide either collectionIds or productIds/variantIds"],
    ["buys mixing collections and variants", "shopify_discount_bxgy_create", { method: "code", code: "X", buys: { quantity: 1, collectionIds: ["gid://shopify/Collection/1"], variantIds: ["gid://shopify/ProductVariant/1"] }, gets: { quantity: 1, productIds: [PRODUCT] } }, "buys takes either collectionIds"],
    ["gets mixing collections and products", "shopify_discount_bxgy_create", { method: "code", code: "X", buys: { quantity: 1, productIds: [PRODUCT] }, gets: { quantity: 1, productIds: [PRODUCT], collectionIds: ["gid://shopify/Collection/1"] } }, "gets takes either collectionIds"],
  ])("rejects %s", async (_label, tool, args, message) => {
    const result = await callTool(client, tool, { ...base, ...args });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(message);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([0, 101])("rejects percentOff %d", async (percentOff) => {
    const result = await callTool(client, "shopify_discount_amount_off_create", { ...base, method: "code", code: "X", percentOff });
    expect(result.isError).toBe(true);
  });

  it.each([
    ["shopify_discount_activate", "gid://shopify/DiscountAutomaticNode/1", "discountAutomaticActivate("],
    ["shopify_discount_deactivate", "gid://shopify/DiscountCodeNode/1", "discountCodeDeactivate("],
    ["shopify_discount_delete", "gid://shopify/DiscountAutomaticNode/1", "discountAutomaticDelete("],
  ])("%s routes %s to %s", async (tool, id, field) => {
    await callTool(client, tool, { id });
    expect(fake.lastCall.query).toContain(field);
  });

  it("rejects IDs that aren't discount nodes", async () => {
    const result = await callTool(client, "shopify_discount_delete", { id: "gid://shopify/DiscountCodeBasic/1" });
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("only adds codes to code discounts", async () => {
    const result = await callTool(client, "shopify_discount_codes_add", { discountId: "gid://shopify/DiscountAutomaticNode/1", codes: ["A"] });
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("partial results", () => {
  it("returns data with nested access errors instead of failing the call", async () => {
    fake.responses.push({
      data: { orders: { edges: [{ node: { id: "gid://shopify/Order/1", customer: null } }] } },
      errors: [{ message: "Access denied for customer field. Required access: `read_customers` access scope." }],
    });
    const result = await callTool(client, "shopify_orders_list");

    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("read_customers");
  });

  it("fails when every top-level field is null", async () => {
    fake.responses.push({ data: { customers: null }, errors: [{ message: "Access denied for customers field." }] });
    const result = await callTool(client, "shopify_customers_list");
    expect(result.isError).toBe(true);
  });
});

describe("raw GraphQL", () => {
  it("can be left out so only the selected toolsets reach the store", async () => {
    const { client: limited } = await connect({ toolsets: ["products"], disableRawGraphql: true });
    const names = (await limited.listTools()).tools.map((t) => t.name);

    expect(names).not.toContain("shopify_graphql");
    expect(names).toContain("shopify_schema_search");
    expect(names).toContain("shopify_products_list");
  });

  it("reports syntax errors without calling Shopify", async () => {
    const result = await callTool(client, "shopify_graphql", { query: "mutation {" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Syntax Error");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("toolsets", () => {
  it("registers only the selected toolsets plus the core tools", async () => {
    const { client: limited } = await connect({ toolsets: ["themes", "markets"] });
    const names = (await limited.listTools()).tools.map((t) => t.name);

    expect(names).toContain("shopify_graphql");
    expect(names).toContain("shopify_schema_search");
    expect(names).toContain("shopify_theme_files_upsert");
    expect(names).toContain("shopify_market_create");
    expect(names).not.toContain("shopify_products_list");
    expect(names).toHaveLength(3 + 7 + 5);
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

  it("accepts the UNLISTED product status", async () => {
    const result = await callTool(client, "shopify_product_update", { id: PRODUCT, status: "UNLISTED" });
    expect(result.isError).toBeFalsy();
    expect(fake.lastCall.variables).toEqual({ product: { id: PRODUCT, status: "UNLISTED" } });
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

  it("rejects an empty search", async () => {
    const result = await callTool(client, "shopify_schema_search", { query: "  " });
    expect(result.isError).toBe(true);
  });

  it("lists the root query type's fields by name instead of describing each one", async () => {
    const result = await callTool(client, "shopify_schema_details", { name: "QueryRoot" });
    expect(resultText(result)).toContain("# QueryRoot (1 queries)");
    expect(resultText(result)).toContain("shop");
    expect(resultText(result)).not.toContain("The shop");
  });

  it("shortens descriptions on types too large to describe in full", () => {
    const sentence = "Describes this field in detail.";
    const index = new SchemaIndex({
      queryTypeName: "QueryRoot",
      mutationTypeName: "Mutation",
      types: [
        {
          kind: "OBJECT",
          name: "Huge",
          description: null,
          fields: Array.from({ length: 300 }, (_, i) => ({
            name: `field${i}`,
            description: `${sentence} ${"More context. ".repeat(10)}`,
            args: [],
            type: { kind: "SCALAR", name: "String" },
          })),
          inputFields: null,
          interfaces: [],
          enumValues: null,
          possibleTypes: null,
        },
      ],
    });

    const details = index.getDetails("Huge")!;
    expect(details.length).toBeLessThanOrEqual(20_000);
    expect(details).toContain(`- field299: String — ${sentence}`);
    expect(details).not.toContain("More context");
  });

  it("loads the schema on first use and retries after a failed load", async () => {
    let loads = 0;
    const load = lazySchemaIndex(async () => {
      loads++;
      if (loads === 1) throw new Error("Introspection failed: timeout");
      return { queryTypeName: "QueryRoot", mutationTypeName: "Mutation", types: [] };
    });
    const { client: lazy } = await connect({}, load);

    const failed = await callTool(lazy, "shopify_schema_search", { query: "shop" });
    expect(failed.isError).toBe(true);
    expect(resultText(failed)).toContain("Introspection failed");

    const [first, second] = await Promise.all([
      callTool(lazy, "shopify_schema_search", { query: "shop" }),
      callTool(lazy, "shopify_schema_details", { name: "Nope" }),
    ]);
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBe(true);
    expect(loads).toBe(2);
  });

  it("waits for the schema instead of failing while it loads", async () => {
    let finish!: () => void;
    const loading = new Promise<void>((resolve) => (finish = resolve));
    const { client: lazy } = await connect({}, async () => {
      await loading;
      return schemaIndex;
    });

    const pending = callTool(lazy, "shopify_schema_search", { query: "shop" });
    finish();
    expect(resultText(await pending)).toContain("shop: Shop!");
  });
});
