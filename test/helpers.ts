import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GraphQLClient, GraphQLResponse } from "../src/graphql/client.js";
import { SchemaIndex } from "../src/graphql/schema-index.js";
import { createServer } from "../src/server.js";

export interface RecordedCall {
  query: string;
  variables?: Record<string, unknown>;
}

/** Stands in for GraphQLClient: records every request and replays queued responses. */
export class FakeGraphQLClient {
  calls: RecordedCall[] = [];
  responses: Array<GraphQLResponse | Error> = [];

  async execute(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GraphQLResponse> {
    this.calls.push({ query, variables });
    const next = this.responses.shift() ?? { data: {} };
    if (next instanceof Error) throw next;
    return next;
  }

  get lastCall(): RecordedCall {
    const call = this.calls.at(-1);
    if (!call) throw new Error("No GraphQL call was made");
    return call;
  }
}

const schemaIndex = new SchemaIndex({
  queryTypeName: "QueryRoot",
  mutationTypeName: "Mutation",
  types: [
    {
      kind: "OBJECT",
      name: "QueryRoot",
      description: null,
      fields: [
        {
          name: "shop",
          description: "The shop",
          args: [],
          type: { kind: "NON_NULL", name: null, ofType: { kind: "OBJECT", name: "Shop" } },
        },
      ],
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: null,
    },
    {
      kind: "OBJECT",
      name: "Mutation",
      description: null,
      fields: [],
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: null,
    },
    {
      kind: "OBJECT",
      name: "Shop",
      description: "A store",
      fields: [
        {
          name: "name",
          description: null,
          args: [],
          type: { kind: "SCALAR", name: "String" },
        },
      ],
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: null,
    },
  ],
});

/** Connects a real MCP client to the server over an in-memory transport. */
export async function connect(options: { readOnly?: boolean } = {}) {
  const fake = new FakeGraphQLClient();
  const server = createServer(fake as unknown as GraphQLClient, schemaIndex, {
    readOnly: options.readOnly ?? false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, fake };
}

export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

export const resultText = (result: ToolResult) => result.content[0]?.text ?? "";
