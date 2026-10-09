# shopify-admin-mcp

MCP server providing full access to Shopify's Admin GraphQL API. Targets API version **2026-10** by default and introspects the live schema on startup, so your AI assistant always sees the exact API your store is serving.

## Features

- **Raw GraphQL execution** — run any query or mutation against the Admin API
- **Live schema introspection** — search and explore the full GraphQL schema directly from your AI assistant
- **26 convenience tools** — typed, no-GraphQL-needed CRUD for products, collections, metaobjects, metafields, customers, orders, and inventory
- **Read-only mode** — one flag hides every write tool and blocks mutations in raw GraphQL
- **Tool annotations** — every tool is marked read-only, write, or destructive so MCP clients can ask before risky calls
- **Dual auth** — OAuth client credentials (Dev Dashboard apps) and legacy access tokens (`shpat_`)
- **Auto token refresh** — client-credentials tokens are refreshed automatically before they expire
- **Rate-limit aware** — throttled requests are retried after the cost bucket refills

## Quick Start

Credentials are read from environment variables, which keeps them out of process listings and shell history:

```bash
# With a legacy access token
SHOPIFY_STORE=mystore.myshopify.com \
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx \
npx -y @acoderacom/shopify-admin-mcp

# With OAuth client credentials (Dev Dashboard app)
SHOPIFY_STORE=mystore.myshopify.com \
SHOPIFY_CLIENT_ID=your_client_id \
SHOPIFY_CLIENT_SECRET=your_client_secret \
npx -y @acoderacom/shopify-admin-mcp
```

Add `--read-only` (or `SHOPIFY_READ_ONLY=true`) when the assistant only needs to look at store data.

## Tools

### Core

| Tool | Description |
|------|-------------|
| `shopify_graphql` | Execute any raw GraphQL query or mutation (queries only in read-only mode) |
| `shopify_schema_search` | Search the live schema by keyword (types, queries, mutations) |
| `shopify_schema_details` | Get full details for a specific type, query, or mutation |

### Products

| Tool | Description |
|------|-------------|
| `shopify_products_list` | List/search products with pagination |
| `shopify_product_get` | Get product by ID with variants and metafields |
| `shopify_product_create` | Create a new product (created unpublished) |
| `shopify_product_update` | Update an existing product |
| `shopify_product_delete` | Delete a product |

### Collections

| Tool | Description |
|------|-------------|
| `shopify_collections_list` | List/search collections with pagination |
| `shopify_collection_get` | Get collection by ID with its sources and products |
| `shopify_collection_create` | Create a collection, optionally with product sources |
| `shopify_collection_update` | Update a collection's title or description |
| `shopify_collection_delete` | Delete a collection |

### Metaobjects

| Tool | Description |
|------|-------------|
| `shopify_metaobject_definitions_list` | List metaobject type definitions with pagination |
| `shopify_metaobjects_list` | List entries of a specific metaobject type |
| `shopify_metaobject_get` | Get a single metaobject entry |
| `shopify_metaobject_create` | Create a new metaobject entry |
| `shopify_metaobject_update` | Update an existing metaobject entry |
| `shopify_metaobject_delete` | Delete a metaobject entry |

### Metafields

| Tool | Description |
|------|-------------|
| `shopify_metafields_list` | List metafields on any resource with pagination |
| `shopify_metafields_set` | Set (upsert) up to 25 metafields on any resources |
| `shopify_metafield_delete` | Delete a metafield by owner ID, namespace, and key |

### Customers

| Tool | Description |
|------|-------------|
| `shopify_customers_list` | List/search customers with pagination |
| `shopify_customer_get` | Get customer by ID with addresses and orders |
| `shopify_customer_update` | Update customer details |

### Orders

| Tool | Description |
|------|-------------|
| `shopify_orders_list` | List/search orders with pagination |
| `shopify_order_get` | Get order by ID with line items and fulfillments |

### Inventory

| Tool | Description |
|------|-------------|
| `shopify_inventory_get_levels` | Get inventory levels across locations |
| `shopify_inventory_adjust` | Adjust available quantity at a location, with a compare-and-swap check |

## API Version 2026-10

The server defaults to `2026-10`. The convenience tools follow the current API, which changes a few tool inputs compared to older releases:

| Tool | What changed |
|------|--------------|
| `shopify_collection_create` | Product membership is defined with `sources` (typed conditions and manual selections) instead of the deprecated `ruleSet`. Use `shopify_schema_details` on `CollectionCreateSourceTargetInput` to see the shape. |
| `shopify_collections_list` / `shopify_collection_get` | Return `sources` instead of `ruleSet`. |
| `shopify_metafield_delete` | Takes `ownerId`, `namespace`, and `key` (the old `metafieldDelete` mutation by ID no longer exists). |
| `shopify_inventory_adjust` | Requires `changeFromQuantity`: the quantity you expect before the change, or `null` to skip the check. An idempotency key is added automatically. |
| Customer and order tools | Return `defaultEmailAddress` / `defaultPhoneNumber` instead of the deprecated `email` / `phone` fields. |

If you pin an older version with `--api-version`, raw GraphQL still works against that version, but some convenience tools may not. When Shopify serves a different version than the one requested (for example because the requested version has been retired), the server logs a warning to stderr.

## Read-Only Mode

Start with `--read-only` or `SHOPIFY_READ_ONLY=true` to:

- register only the read-only tools (list/get, schema search, inventory levels)
- reject `mutation` and `subscription` operations in `shopify_graphql`; the document is parsed, so comments and multiple operations can't slip one through

Use it whenever the assistant doesn't need to change the store. Product descriptions, customer notes, and order notes are written by merchants and customers, and an assistant reading them can be prompted to take actions you didn't ask for.

## Required API Scopes

Configure these scopes on your app to enable all tools:

| Scope | Tools |
|-------|-------|
| `read_products`, `write_products` | Products, collections |
| `read_metaobjects`, `write_metaobjects` | Metaobject entries |
| `read_metaobject_definitions` | `shopify_metaobject_definitions_list` |
| Scope of the owning resource | Metafields (e.g. `read_products` for product metafields, `read_customers` for customer metafields) |
| `read_customers`, `write_customers` | Customers |
| `read_orders` | Orders (last 60 days; add `read_all_orders` for older orders) |
| `read_inventory`, `write_inventory`, `read_locations` | Inventory |

You only need scopes for the tools you plan to use. Customer names, emails, phone numbers, and addresses are [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data), so your app must also be granted access to those fields.

## Authentication

### OAuth Client Credentials (recommended)

For apps created in the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard):

1. Create an app in the Dev Dashboard
2. Configure the Admin API scopes listed above
3. Release a version and install the app on your store
4. Set the Client ID and Client secret:

```bash
SHOPIFY_STORE=mystore.myshopify.com \
SHOPIFY_CLIENT_ID=your_client_id \
SHOPIFY_CLIENT_SECRET=your_client_secret \
npx -y @acoderacom/shopify-admin-mcp
```

The client credentials grant only works when the app and the store belong to the same Shopify organization. Tokens last 24 hours and are refreshed automatically.

### Legacy Access Token

For existing custom apps with a `shpat_` token:

```bash
SHOPIFY_STORE=mystore.myshopify.com \
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx \
npx -y @acoderacom/shopify-admin-mcp
```

## Configuration

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--store` | `SHOPIFY_STORE` | Store domain (required). Accepts `mystore` or `mystore.myshopify.com` |
| `--access-token` | `SHOPIFY_ACCESS_TOKEN` | Legacy access token (`shpat_...`) |
| `--client-id` | `SHOPIFY_CLIENT_ID` | OAuth client ID |
| `--client-secret` | `SHOPIFY_CLIENT_SECRET` | OAuth client secret |
| `--api-version` | `SHOPIFY_API_VERSION` | API version (default: `2026-10`) |
| `--read-only` | `SHOPIFY_READ_ONLY` | Expose only read tools and block mutations (`true` / `1`) |

The store must be a `*.myshopify.com` domain, so credentials are only ever sent to Shopify. Secrets can still be passed as flags, but the server prints a warning because flags are visible to other processes on the machine.

## Usage with Claude Code

```bash
claude mcp add shopify \
  -e SHOPIFY_STORE=mystore.myshopify.com \
  -e SHOPIFY_ACCESS_TOKEN=shpat_xxxxx \
  -- npx -y @acoderacom/shopify-admin-mcp
```

Or add it to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "@acoderacom/shopify-admin-mcp"],
      "env": {
        "SHOPIFY_STORE": "mystore.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxx"
      }
    }
  }
}
```

Don't commit real tokens. Claude Code expands `${VAR}` in `.mcp.json`, so you can reference variables from your shell instead.

## Usage with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "@acoderacom/shopify-admin-mcp"],
      "env": {
        "SHOPIFY_STORE": "mystore.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxx"
      }
    }
  }
}
```

If you install the package globally (`npm install -g @acoderacom/shopify-admin-mcp`), you can use `"command": "shopify-admin-mcp"` with no `args`.

## Schema Exploration

The server introspects Shopify's live GraphQL schema on startup, so your AI assistant can discover API capabilities in real time.

```
You: "What mutations are available for metaobjects?"
→ AI uses shopify_schema_search with query "metaobject" filter "mutations"
→ Returns: metaobjectCreate, metaobjectUpdate, metaobjectDelete, metaobjectUpsert, ...

You: "What fields does MetaobjectCreateInput take?"
→ AI uses shopify_schema_details with name "MetaobjectCreateInput"
→ Returns: full type definition with all fields, types, and descriptions
```

Deprecated fields are left out of the index, so the assistant is steered toward the current API.

## Development

```bash
git clone https://github.com/acoderacom/shopify-admin-mcp.git
cd shopify-admin-mcp
npm install
npm run build
npm run dev  # watch mode
```

The server runs on Node.js 18 or later. Developing and testing it needs Node.js 22.12 or later (TypeScript 7, Vitest 5).

## Testing

```bash
npm test       # unit tests; live tests are skipped without credentials
npm run lint   # type-check src and tests
```

The unit tests need no network. They cover CLI validation, the HTTP client (throttle retry, token refresh), every tool's request over a real MCP connection, and read-only mode.

Live integration tests run against a real store when credentials are set:

```bash
SHOPIFY_STORE=your-dev-store.myshopify.com \
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx \
npm test
```

Add `SHOPIFY_TEST_WRITES=1` to also run the write tests. They create `[MCP test]` products, collections, metaobjects, and customers, run every write tool against them, and delete them afterwards. Only run write tests against a development store.

## License

MIT. See [LICENSE](LICENSE).

Originally created by [Colby McHenry](https://github.com/colbymchenry) as [shopify-graphql-admin-mcp](https://github.com/colbymchenry/shopify-graphql-admin-mcp), and maintained by [acoderacom](https://github.com/acoderacom).
