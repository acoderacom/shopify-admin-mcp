import { describe, expect, it } from "vitest";
import { callTool, connect, resultText } from "./helpers.js";

describe("read-only mode", () => {
  it("only exposes tools annotated as read-only", async () => {
    const { client } = await connect({ readOnly: true });
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(24);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("shopify_product_delete");
  });

  it("rejects calls to write tools", async () => {
    const { client, fake } = await connect({ readOnly: true });
    const result = await callTool(client, "shopify_product_delete", { id: "gid://shopify/Product/1" });

    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ["a plain mutation", 'mutation { productDelete(input: {id: "x"}) { deletedProductId } }'],
    ["a mutation after a comment", "# query\nmutation M { a }"],
    ["a mutation after a query", 'query Q { shop { name } }\nmutation M { productDelete(input: {id: "x"}) { deletedProductId } }'],
    ["a mutation with leading whitespace", "  \n mutation{a}"],
    ["a subscription", "subscription { a }"],
  ])("blocks %s in raw GraphQL", async (_label, query) => {
    const { client, fake } = await connect({ readOnly: true });
    const result = await callTool(client, "shopify_graphql", { query });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("read-only mode");
    expect(fake.calls).toHaveLength(0);
  });

  it("allows queries that only mention mutations in comments or strings", async () => {
    const { client, fake } = await connect({ readOnly: true });
    const query = '# mutation { productDelete }\nquery { products(first: 1, query: "mutation") { nodes { id } } }';
    const result = await callTool(client, "shopify_graphql", { query });

    expect(result.isError).toBeFalsy();
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects documents that cannot be parsed instead of forwarding them", async () => {
    const { client, fake } = await connect({ readOnly: true });
    const result = await callTool(client, "shopify_graphql", { query: "mutation {" });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Syntax Error");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("full mode", () => {
  it("forwards raw mutations", async () => {
    const { client, fake } = await connect();
    const result = await callTool(client, "shopify_graphql", {
      query: 'mutation { productDelete(input: {id: "x"}) { deletedProductId } }',
      variables: { unused: true },
    });

    expect(result.isError).toBeFalsy();
    expect(fake.lastCall.variables).toEqual({ unused: true });
  });
});
