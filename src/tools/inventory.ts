import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GraphQLClient } from "../graphql/client.js";
import { READ_ONLY, WRITE, toolResult, type ToolRegistrar } from "./shared.js";

export function registerInventoryTools(
  server: ToolRegistrar,
  client: GraphQLClient
) {
  server.registerTool(
    "shopify_inventory_get_levels",
    {
      description: "Get inventory levels for an inventory item across all locations",
      inputSchema: {
        inventoryItemId: z.string().describe("Inventory item GID"),
      },
      annotations: READ_ONLY,
    },
    async ({ inventoryItemId }) => {
      const result = await client.execute(
        `query ($id: ID!) {
          inventoryItem(id: $id) {
            id sku
            inventoryLevels(first: 20) {
              nodes {
                id
                quantities(names: ["available", "committed", "incoming", "on_hand"]) {
                  name quantity
                }
                location { id name }
              }
            }
          }
        }`,
        { id: inventoryItemId }
      );
      return toolResult(result);
    }
  );

  server.registerTool(
    "shopify_inventory_adjust",
    {
      description:
        "Adjust the available inventory quantity at a specific location. Read the current quantity with shopify_inventory_get_levels first and pass it as changeFromQuantity so concurrent changes are detected.",
      inputSchema: {
        inventoryItemId: z.string().describe("Inventory item GID"),
        locationId: z.string().describe("Location GID"),
        delta: z.number().int().describe("Quantity change (positive to add, negative to remove)"),
        changeFromQuantity: z
          .number()
          .int()
          .nullable()
          .describe(
            "The current available quantity you expect before the change. The adjustment fails if it no longer matches. Pass null only to skip this check."
          ),
        reason: z
          .string()
          .optional()
          .describe('Adjustment reason, e.g. "correction", "received", "damaged" (default "correction")'),
      },
      annotations: WRITE,
    },
    async ({ inventoryItemId, locationId, delta, changeFromQuantity, reason }) => {
      // API 2026-04+ rejects inventory mutations without an idempotency key
      const result = await client.execute(
        `mutation ($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
          inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup {
              reason
              changes {
                name
                delta
                quantityAfterChange
              }
            }
            userErrors { field message code }
          }
        }`,
        {
          idempotencyKey: randomUUID(),
          input: {
            reason: reason ?? "correction",
            name: "available",
            changes: [
              {
                inventoryItemId,
                locationId,
                delta,
                changeFromQuantity,
              },
            ],
          },
        }
      );
      return toolResult(result);
    }
  );
}
