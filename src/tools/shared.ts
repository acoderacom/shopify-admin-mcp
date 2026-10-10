import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GraphQLResponse } from "../graphql/client.js";

export type ToolRegistrar = Pick<McpServer, "registerTool">;

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

/** Shopify connections return at most 250 items per page. */
export const pageSize = z.number().int().min(1).max(250);

/** Formats a GraphQL response as a tool result, flagging top-level errors and mutation userErrors. */
export function toolResult(result: GraphQLResponse): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: hasErrors(result),
  };
}

function hasErrors(result: GraphQLResponse): boolean {
  // Partial data (e.g. one nested field the app lacks a scope for) is still a usable result;
  // the errors stay in the payload for the caller to see
  if (result.errors?.length) {
    const fields = Object.values(result.data ?? {});
    if (fields.length === 0 || fields.every((value) => value === null)) return true;
  }
  // Mutation payloads report validation failures as userErrors rather than top-level errors
  return Object.values(result.data ?? {}).some((payload) => {
    const userErrors = (payload as { userErrors?: unknown } | null)?.userErrors;
    return Array.isArray(userErrors) && userErrors.length > 0;
  });
}

/**
 * Wraps the server so only tools annotated as read-only stay registered.
 * registerTool must return a handle, so write tools are registered and removed
 * before the transport connects.
 */
export function readOnlyRegistrar(server: ToolRegistrar): ToolRegistrar {
  return {
    registerTool(name, config, cb) {
      const tool = server.registerTool(name, config, cb);
      if (!config.annotations?.readOnlyHint) tool.remove();
      return tool;
    },
  };
}
