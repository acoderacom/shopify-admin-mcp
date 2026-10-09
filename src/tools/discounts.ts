import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  pageSize,
  toolResult,
  type ToolRegistrar,
} from "./shared.js";

const COMMON_FIELDS =
  "title status startsAt endsAt discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts }";
const CODE_EXTRA =
  "usageLimit asyncUsageCount appliesOncePerCustomer codesCount { count } codes(first: 5) { nodes { code } }";

const CODE_FRAGMENTS = `
  ... on DiscountCodeBasic { ${COMMON_FIELDS} summary ${CODE_EXTRA} }
  ... on DiscountCodeBxgy { ${COMMON_FIELDS} summary ${CODE_EXTRA} }
  ... on DiscountCodeFreeShipping { ${COMMON_FIELDS} summary ${CODE_EXTRA} }
  ... on DiscountCodeApp { ${COMMON_FIELDS} ${CODE_EXTRA} }
`;
const AUTOMATIC_FRAGMENTS = `
  ... on DiscountAutomaticBasic { ${COMMON_FIELDS} summary }
  ... on DiscountAutomaticBxgy { ${COMMON_FIELDS} summary }
  ... on DiscountAutomaticFreeShipping { ${COMMON_FIELDS} summary }
  ... on DiscountAutomaticApp { ${COMMON_FIELDS} }
`;

const CODE_PAYLOAD = `codeDiscountNode { id codeDiscount { __typename ${CODE_FRAGMENTS} } } userErrors { field code message }`;
const AUTOMATIC_PAYLOAD = `automaticDiscountNode { id automaticDiscount { __typename ${AUTOMATIC_FRAGMENTS} } } userErrors { field code message }`;

const ids = (what: string) => z.array(z.string()).min(1).optional().describe(`${what} GIDs`);
const decimal = (example: string) =>
  z.string().regex(/^\d+(\.\d+)?$/, "Use a decimal string").describe(`Decimal amount as a string, e.g. "${example}"`);
const percent = z.number().gt(0).max(100);

const shared = {
  method: z
    .enum(["code", "automatic"])
    .describe('"code": customers enter a code at checkout. "automatic": applies without a code.'),
  title: z.string().describe("Discount name shown to merchants and customers"),
  code: z.string().optional().describe("The code customers enter (required for method code)"),
  startsAt: z.string().optional().describe("ISO 8601 start time (default: now)"),
  endsAt: z.string().optional().describe("ISO 8601 end time (default: no end date)"),
  usageLimit: z.number().int().positive().optional().describe("Total number of uses allowed (code discounts only)"),
  appliesOncePerCustomer: z.boolean().optional().describe("Each customer can use it once (code discounts only)"),
  combinesWith: z
    .object({
      productDiscounts: z.boolean().optional(),
      orderDiscounts: z.boolean().optional(),
      shippingDiscounts: z.boolean().optional(),
    })
    .optional()
    .describe("Other discount classes this discount can combine with (default: none)"),
  customerIds: ids("Only these customers can use it: customer"),
  customerSegmentIds: ids("Only customers in these segments can use it: segment"),
  marketIds: ids("Only buyers in these markets can use it: market"),
};

const minimums = {
  minimumSubtotal: decimal("50000").optional().describe('Minimum order subtotal, e.g. "50000"'),
  minimumQuantity: z.number().int().positive().optional().describe("Minimum number of items"),
};

type Shared = {
  method: "code" | "automatic";
  title: string;
  code?: string;
  startsAt?: string;
  endsAt?: string;
  usageLimit?: number;
  appliesOncePerCustomer?: boolean;
  combinesWith?: Record<string, boolean | undefined>;
  customerIds?: string[];
  customerSegmentIds?: string[];
  marketIds?: string[];
};

type ItemSelection = { productIds?: string[]; variantIds?: string[]; collectionIds?: string[] };

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// Returns a message when the method-specific fields don't fit together
function checkMethod(input: Shared): string | null {
  if (input.method === "code" && !input.code) return "code is required when method is code";
  if (input.method === "automatic" && (input.code || input.usageLimit || input.appliesOncePerCustomer)) {
    return "automatic discounts don't take code, usageLimit, or appliesOncePerCustomer";
  }
  return null;
}

function context({ customerIds, customerSegmentIds, marketIds }: Shared) {
  if (!customerIds && !customerSegmentIds && !marketIds) return { all: "ALL" };
  return {
    customers: customerIds ? { add: customerIds } : undefined,
    customerSegments: customerSegmentIds ? { add: customerSegmentIds } : undefined,
    markets: marketIds ? { add: marketIds } : undefined,
  };
}

function items({ productIds, variantIds, collectionIds }: ItemSelection) {
  if (collectionIds) return { collections: { add: collectionIds } };
  if (productIds || variantIds) {
    return { products: { productsToAdd: productIds, productVariantsToAdd: variantIds } };
  }
  return null;
}

function minimumRequirement(min: { minimumSubtotal?: string; minimumQuantity?: number }) {
  if (min.minimumSubtotal) return { subtotal: { greaterThanOrEqualToSubtotal: min.minimumSubtotal } };
  if (min.minimumQuantity) return { quantity: { greaterThanOrEqualToQuantity: String(min.minimumQuantity) } };
  return undefined;
}

// Fields every discount input shares; code-only fields are dropped for automatic discounts
function baseInput(input: Shared) {
  const base = {
    title: input.title,
    startsAt: input.startsAt ?? new Date().toISOString(),
    endsAt: input.endsAt,
    combinesWith: input.combinesWith,
    context: context(input),
  };
  if (input.method === "automatic") return base;
  return {
    ...base,
    code: input.code,
    usageLimit: input.usageLimit,
    appliesOncePerCustomer: input.appliesOncePerCustomer,
  };
}

function discountKind(id: string): "code" | "automatic" | null {
  if (id.startsWith("gid://shopify/DiscountCodeNode/")) return "code";
  if (id.startsWith("gid://shopify/DiscountAutomaticNode/")) return "automatic";
  return null;
}

const discountId = z
  .string()
  .describe("Discount GID from shopify_discounts_list (DiscountCodeNode or DiscountAutomaticNode)");

export function registerDiscountTools(server: ToolRegistrar, client: GraphQLClient) {
  server.registerTool(
    "shopify_discounts_list",
    {
      description:
        "List code and automatic discounts with their status, dates, and a summary of what they do",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Search filter, e.g. "status:active", "method:code", "type:free_shipping", "title:summer*"'),
        first: pageSize.optional().describe("Number of discounts to return (default 20)"),
        after: z.string().optional().describe("Cursor for pagination"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, first, after }) => {
      const result = await client.execute(
        `query ($first: Int!, $query: String, $after: String) {
          discountNodes(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
            nodes { id discount { __typename ${CODE_FRAGMENTS} ${AUTOMATIC_FRAGMENTS} } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: first ?? 20, query, after }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_discount_get",
    {
      description: "Get a discount by ID, including its codes and usage",
      inputSchema: { id: discountId },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const result = await client.execute(
        `query ($id: ID!) {
          discountNode(id: $id) { id discount { __typename ${CODE_FRAGMENTS} ${AUTOMATIC_FRAGMENTS} } }
        }`,
        { id }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_discount_amount_off_create",
    {
      description:
        "Create a percentage or fixed-amount discount on the whole order, or on specific products, variants, or collections, as a code or an automatic discount",
      inputSchema: {
        ...shared,
        percentOff: percent.optional().describe("Percentage off, e.g. 20 for 20% off"),
        amountOff: decimal("10000").optional().describe('Fixed amount off, e.g. "10000"'),
        amountOffEachItem: z
          .boolean()
          .optional()
          .describe("Apply amountOff to each eligible item instead of once across them"),
        productIds: ids("Discount only these products: product"),
        variantIds: ids("Discount only these variants: variant"),
        collectionIds: ids("Discount only products in these collections: collection"),
        ...minimums,
      },
      annotations: WRITE,
    },
    async (input) => {
      const invalid =
        checkMethod(input) ??
        ((input.percentOff === undefined) === (input.amountOff === undefined)
          ? "provide exactly one of percentOff or amountOff"
          : null) ??
        (input.minimumSubtotal && input.minimumQuantity
          ? "provide at most one of minimumSubtotal or minimumQuantity"
          : null);
      if (invalid) return errorResult(invalid);

      const value =
        input.percentOff !== undefined
          ? { percentage: input.percentOff / 100 }
          : { discountAmount: { amount: input.amountOff, appliesOnEachItem: input.amountOffEachItem ?? false } };
      const discount = {
        ...baseInput(input),
        minimumRequirement: minimumRequirement(input),
        // No product selection means the discount applies to the whole order
        customerGets: { value, items: items(input) ?? { all: true } },
      };

      const result =
        input.method === "code"
          ? await client.execute(
              `mutation ($discount: DiscountCodeBasicInput!) {
                discountCodeBasicCreate(basicCodeDiscount: $discount) { ${CODE_PAYLOAD} }
              }`,
              { discount }
            )
          : await client.execute(
              `mutation ($discount: DiscountAutomaticBasicInput!) {
                discountAutomaticBasicCreate(automaticBasicDiscount: $discount) { ${AUTOMATIC_PAYLOAD} }
              }`,
              { discount }
            );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_discount_free_shipping_create",
    {
      description: "Create a free shipping discount, as a code or an automatic discount",
      inputSchema: {
        ...shared,
        countryCodes: z
          .array(z.string().regex(/^[A-Z]{2}$/, "Use ISO 3166-1 alpha-2 codes, e.g. ID"))
          .min(1)
          .optional()
          .describe("Destination countries that qualify (default: all countries)"),
        maximumShippingPrice: decimal("20000")
          .optional()
          .describe("Only shipping rates up to this price become free"),
        ...minimums,
      },
      annotations: WRITE,
    },
    async (input) => {
      const invalid =
        checkMethod(input) ??
        (input.minimumSubtotal && input.minimumQuantity
          ? "provide at most one of minimumSubtotal or minimumQuantity"
          : null);
      if (invalid) return errorResult(invalid);

      const discount = {
        ...baseInput(input),
        minimumRequirement: minimumRequirement(input),
        destination: input.countryCodes ? { countries: { add: input.countryCodes } } : { all: true },
        maximumShippingPrice: input.maximumShippingPrice,
      };

      const result =
        input.method === "code"
          ? await client.execute(
              `mutation ($discount: DiscountCodeFreeShippingInput!) {
                discountCodeFreeShippingCreate(freeShippingCodeDiscount: $discount) { ${CODE_PAYLOAD} }
              }`,
              { discount }
            )
          : await client.execute(
              `mutation ($discount: DiscountAutomaticFreeShippingInput!) {
                discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: $discount) { ${AUTOMATIC_PAYLOAD} }
              }`,
              { discount }
            );
      return toolResult(result);
    }
  );

  const selection = (role: string) =>
    z
      .object({
        productIds: ids(`${role} products: product`),
        variantIds: ids(`${role} variants: variant`),
        collectionIds: ids(`${role} products in collections: collection`),
      })
      .describe(`Which items ${role.toLowerCase()} (give products, variants, or collections)`);

  server.registerTool(
    "shopify_discount_bxgy_create",
    {
      description:
        "Create a buy X get Y discount (e.g. buy 2 shirts, get 1 hat free), as a code or an automatic discount",
      inputSchema: {
        ...shared,
        buys: selection("The customer buys").extend({
          quantity: z.number().int().positive().optional().describe("Number of items the customer must buy"),
          amount: decimal("100000").optional().describe("Or: amount the customer must spend on them"),
        }),
        gets: selection("The customer gets").extend({
          quantity: z.number().int().positive().describe("Number of items the customer gets discounted"),
          percentOff: percent.optional().describe("Percentage off the items they get (default 100: free)"),
          amountOff: decimal("10000").optional().describe("Or: fixed amount off the items they get"),
        }),
        usesPerOrderLimit: z.number().int().positive().optional().describe("Times the offer can apply in one order"),
      },
      annotations: WRITE,
    },
    async (input) => {
      const buysItems = items(input.buys);
      const getsItems = items(input.gets);
      const invalid =
        checkMethod(input) ??
        ((input.buys.quantity === undefined) === (input.buys.amount === undefined)
          ? "buys needs exactly one of quantity or amount"
          : null) ??
        (input.gets.percentOff !== undefined && input.gets.amountOff !== undefined
          ? "gets takes at most one of percentOff or amountOff"
          : null) ??
        (!buysItems || !getsItems
          ? "buys and gets each need productIds, variantIds, or collectionIds"
          : null);
      if (invalid) return errorResult(invalid);

      const effect =
        input.gets.amountOff !== undefined
          ? { amount: input.gets.amountOff }
          : { percentage: (input.gets.percentOff ?? 100) / 100 };
      const discount = {
        ...baseInput(input),
        customerBuys: {
          value:
            input.buys.quantity !== undefined
              ? { quantity: String(input.buys.quantity) }
              : { amount: input.buys.amount },
          items: buysItems,
        },
        customerGets: {
          value: { discountOnQuantity: { quantity: String(input.gets.quantity), effect } },
          items: getsItems,
        },
      };

      const result =
        input.method === "code"
          ? await client.execute(
              `mutation ($discount: DiscountCodeBxgyInput!) {
                discountCodeBxgyCreate(bxgyCodeDiscount: $discount) { ${CODE_PAYLOAD} }
              }`,
              { discount: { ...discount, usesPerOrderLimit: input.usesPerOrderLimit } }
            )
          : // The automatic input types usesPerOrderLimit as UnsignedInt64, which is sent as a string
            await client.execute(
              `mutation ($discount: DiscountAutomaticBxgyInput!) {
                discountAutomaticBxgyCreate(automaticBxgyDiscount: $discount) { ${AUTOMATIC_PAYLOAD} }
              }`,
              {
                discount: {
                  ...discount,
                  usesPerOrderLimit:
                    input.usesPerOrderLimit === undefined ? undefined : String(input.usesPerOrderLimit),
                },
              }
            );
      return toolResult(result);
    }
  );

  const statusTool = (action: "activate" | "deactivate") =>
    server.registerTool(
      `shopify_discount_${action}`,
      {
        description:
          action === "activate"
            ? "Activate a discount now (sets its start time to now)"
            : "Deactivate a discount now (sets its end time to now)",
        inputSchema: { id: discountId },
        annotations: { ...WRITE, idempotentHint: true },
      },
      async ({ id }) => {
        const kind = discountKind(id);
        if (!kind) return errorResult("Expected a DiscountCodeNode or DiscountAutomaticNode ID");
        const verb = action === "activate" ? "Activate" : "Deactivate";
        const result =
          kind === "code"
            ? await client.execute(
                `mutation ($id: ID!) { discountCode${verb}(id: $id) { ${CODE_PAYLOAD} } }`,
                { id }
              )
            : await client.execute(
                `mutation ($id: ID!) { discountAutomatic${verb}(id: $id) { ${AUTOMATIC_PAYLOAD} } }`,
                { id }
              );
        return toolResult(result);
      }
    );
  statusTool("activate");
  statusTool("deactivate");

  server.registerTool(
    "shopify_discount_delete",
    {
      description: "Permanently delete a discount and its codes",
      inputSchema: { id: discountId },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const kind = discountKind(id);
      if (!kind) return errorResult("Expected a DiscountCodeNode or DiscountAutomaticNode ID");
      const result =
        kind === "code"
          ? await client.execute(
              `mutation ($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field code message } } }`,
              { id }
            )
          : await client.execute(
              `mutation ($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field code message } } }`,
              { id }
            );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_discount_codes_add",
    {
      description:
        "Add up to 250 extra codes to an existing code discount (e.g. unique codes for a campaign). Codes are created in the background; check progress with shopify_discount_get.",
      inputSchema: {
        discountId: z.string().describe("DiscountCodeNode GID"),
        codes: z.array(z.string().min(1)).min(1).max(250).describe("Codes to add"),
      },
      annotations: WRITE,
    },
    async ({ discountId, codes }) => {
      if (discountKind(discountId) !== "code") {
        return errorResult("Codes can only be added to code discounts (DiscountCodeNode IDs)");
      }
      const result = await client.execute(
        `mutation ($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
          discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
            bulkCreation { id done codesCount importedCount failedCount }
            userErrors { field code message }
          }
        }`,
        { discountId, codes: codes.map((code) => ({ code })) }
      );
      return toolResult(result);
    }
  );
}
