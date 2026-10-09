# shopify-admin-mcp

[![npm](https://img.shields.io/npm/v/@acodera/shopify-admin-mcp)](https://www.npmjs.com/package/@acodera/shopify-admin-mcp)
[![CI](https://github.com/acoderacom/shopify-admin-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/acoderacom/shopify-admin-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

MCP server providing full access to Shopify's Admin GraphQL API. Targets API version **2026-10** by default and introspects the live schema on startup, so your AI assistant always sees the exact API your store is serving.

## Features

- **Raw GraphQL execution** — run any query or mutation against the Admin API
- **Live schema introspection** — search and explore the full GraphQL schema directly from your AI assistant
- **59 convenience tools** — typed, no-GraphQL-needed tools for products and variants, collections, publishing, metafields and metaobjects (including definitions), customers, orders, inventory, discounts, file uploads, themes, and markets
- **Toolsets** — register only the areas you need to keep the assistant's tool list short
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
npx -y @acodera/shopify-admin-mcp

# With OAuth client credentials (Dev Dashboard app)
SHOPIFY_STORE=mystore.myshopify.com \
SHOPIFY_CLIENT_ID=your_client_id \
SHOPIFY_CLIENT_SECRET=your_client_secret \
npx -y @acodera/shopify-admin-mcp
```

Add `--read-only` (or `SHOPIFY_READ_ONLY=true`) when the assistant only needs to look at store data.

## Tools

### Core

| Tool | Description |
|------|-------------|
| `shopify_graphql` | Execute any raw GraphQL query or mutation (queries only in read-only mode) |
| `shopify_schema_search` | Search the live schema by keyword (types, queries, mutations) |
| `shopify_schema_details` | Get full details for a specific type, query, or mutation |

Convenience tools are grouped into toolsets (shown in brackets), which you can select with `--toolsets`.

### Products `[products]`

| Tool | Description |
|------|-------------|
| `shopify_products_list` | List/search products with pagination |
| `shopify_product_get` | Get product by ID with variants and metafields |
| `shopify_product_create` | Create a product, optionally with options such as Size or Color (created unpublished) |
| `shopify_product_update` | Update an existing product |
| `shopify_product_delete` | Delete a product |
| `shopify_product_variants_create` | Add variants by option values, with price, compare-at price, and SKU |
| `shopify_product_variants_update` | Update variant prices, compare-at prices, SKUs, or inventory policy |

### Collections `[collections]`

| Tool | Description |
|------|-------------|
| `shopify_collections_list` | List/search collections with pagination |
| `shopify_collection_get` | Get collection by ID with its sources and products |
| `shopify_collection_create` | Create a collection, optionally with product sources |
| `shopify_collection_update` | Update title or description, and add or remove product sources |
| `shopify_collection_delete` | Delete a collection |

### Publishing `[publishing]`

| Tool | Description |
|------|-------------|
| `shopify_publications_list` | List sales channels and catalogs that can be published to |
| `shopify_publish` | Publish a product or collection, optionally on a schedule |
| `shopify_unpublish` | Unpublish a product or collection |

### Metafields `[metafields]`

| Tool | Description |
|------|-------------|
| `shopify_metafields_list` | List metafields on any resource with pagination |
| `shopify_metafields_set` | Set (upsert) up to 25 metafields on any resources |
| `shopify_metafield_delete` | Delete a metafield by owner ID, namespace, and key |
| `shopify_metafield_definitions_list` | List metafield definitions for a resource type |
| `shopify_metafield_definition_create` | Create a typed, validated metafield definition |

### Metaobjects `[metaobjects]`

| Tool | Description |
|------|-------------|
| `shopify_metaobject_definitions_list` | List metaobject type definitions with pagination |
| `shopify_metaobject_definition_create` | Create a metaobject definition with typed fields |
| `shopify_metaobjects_list` | List entries of a specific metaobject type |
| `shopify_metaobject_get` | Get a single metaobject entry |
| `shopify_metaobject_create` | Create a new metaobject entry |
| `shopify_metaobject_upsert` | Create or update an entry by type and handle |
| `shopify_metaobject_update` | Update an existing metaobject entry |
| `shopify_metaobject_delete` | Delete a metaobject entry |

### Customers `[customers]`

| Tool | Description |
|------|-------------|
| `shopify_customers_list` | List/search customers with pagination |
| `shopify_customer_get` | Get customer by ID with addresses and orders |
| `shopify_customer_update` | Update customer details |

### Orders `[orders]`

| Tool | Description |
|------|-------------|
| `shopify_orders_list` | List/search orders with pagination |
| `shopify_order_get` | Get order by ID with line items and fulfillments |

### Inventory `[inventory]`

| Tool | Description |
|------|-------------|
| `shopify_inventory_get_levels` | Get inventory levels across locations |
| `shopify_inventory_adjust` | Adjust available quantity at a location, with a compare-and-swap check |

### Discounts `[discounts]`

| Tool | Description |
|------|-------------|
| `shopify_discounts_list` | List/search code and automatic discounts with status and summary |
| `shopify_discount_get` | Get a discount with its codes and usage |
| `shopify_discount_amount_off_create` | Percentage or fixed amount off the order or specific products/collections, as a code or automatic |
| `shopify_discount_free_shipping_create` | Free shipping, optionally limited to countries or a maximum rate, as a code or automatic |
| `shopify_discount_bxgy_create` | Buy X get Y (e.g. buy 2, get 1 free), as a code or automatic |
| `shopify_discount_activate` | Start a discount now |
| `shopify_discount_deactivate` | End a discount now |
| `shopify_discount_delete` | Delete a discount |
| `shopify_discount_codes_add` | Add up to 250 extra codes to a code discount |

All create tools accept start and end dates, minimum subtotal or quantity, usage limits (codes only), which other discounts they combine with, and eligibility by customer, customer segment, or market. Percentages are given as whole numbers (`20` = 20% off).

### Files `[files]`

| Tool | Description |
|------|-------------|
| `shopify_files_list` | List/search the Files library |
| `shopify_file_upload` | Upload from a URL or a local file, wait until processed, optionally attach to a product |
| `shopify_file_delete` | Delete files |

### Themes `[themes]`

| Tool | Description |
|------|-------------|
| `shopify_themes_list` | List themes and their roles |
| `shopify_theme_files_list` | List a theme's files, filtered by patterns such as `sections/*` |
| `shopify_theme_files_get` | Read theme file contents |
| `shopify_theme_files_upsert` | Create or overwrite up to 50 theme files |
| `shopify_theme_files_delete` | Delete theme files |
| `shopify_theme_duplicate` | Copy a theme as a new unpublished theme |
| `shopify_theme_delete` | Delete an unpublished theme |

### Markets `[markets]`

| Tool | Description |
|------|-------------|
| `shopify_markets_list` | List markets with regions, currency settings, and web presences |
| `shopify_market_get` | Get a market with its catalogs and price lists |
| `shopify_market_create` | Create a market for a set of countries |
| `shopify_market_update` | Rename a market, change its status, add or remove countries, or change currency settings |
| `shopify_market_delete` | Delete a market |

## API Version 2026-10

The server defaults to `2026-10`. The convenience tools follow the current API, which changes a few tool inputs compared to older releases:

| Tool | What changed |
|------|--------------|
| `shopify_collection_create` | Product membership is defined with `sources` (typed conditions and manual selections) instead of the deprecated `ruleSet`. Use `shopify_schema_details` on `CollectionCreateSourceTargetInput` to see the shape. |
| `shopify_collection_update` | Adds and removes products by creating or deleting sources (`sourcesToCreate`, `sourcesToDelete`); `collectionAddProducts` no longer applies. |
| `shopify_collections_list` / `shopify_collection_get` | Return `sources` instead of `ruleSet`. |
| `shopify_metafield_delete` | Takes `ownerId`, `namespace`, and `key` (the old `metafieldDelete` mutation by ID no longer exists). |
| `shopify_inventory_adjust` | Requires `changeFromQuantity`: the quantity you expect before the change, or `null` to skip the check. An idempotency key is added automatically. |
| Customer and order tools | Return `defaultEmailAddress` / `defaultPhoneNumber` instead of the deprecated `email` / `phone` fields. |

If you pin an older version with `--api-version`, raw GraphQL still works against that version, but some convenience tools may not. When Shopify serves a different version than the one requested (for example because the requested version has been retired), the server logs a warning to stderr.

## Read-Only Mode

Start with `--read-only` or `SHOPIFY_READ_ONLY=true` to:

- register only the read-only tools (list/get tools, schema search, inventory levels, theme file reads)
- reject `mutation` and `subscription` operations in `shopify_graphql`; the document is parsed, so comments and multiple operations can't slip one through

Use it whenever the assistant doesn't need to change the store. Product descriptions, customer notes, and order notes are written by merchants and customers, and an assistant reading them can be prompted to take actions you didn't ask for.

## Toolsets

All toolsets are registered by default. To keep the assistant's tool list short, pass the ones you need:

```bash
--toolsets products,collections,publishing,files
```

Available toolsets: `products`, `collections`, `publishing`, `metafields`, `metaobjects`, `customers`, `orders`, `inventory`, `discounts`, `files`, `themes`, `markets`. Raw GraphQL and schema search are always available.

## File Uploads

`shopify_file_upload` accepts either a public `url`, which Shopify fetches itself, or a local `path`, which is sent through a staged upload. The tool waits for Shopify to finish processing and returns the file's CDN URL. Pass `productId` to attach an image, video, or 3D model to a product as media.

Local uploads are disabled until you choose a directory with `--upload-dir` (or `SHOPIFY_UPLOAD_DIR`). Only files inside that directory can be uploaded, with symlinks resolved, so a prompt can't make the server publish other files from your machine to the store's public CDN.

## Themes

Theme file tools read any theme, but by default they refuse to write to or delete from the live (`MAIN`) theme. The safe workflow is:

1. `shopify_theme_duplicate` the live theme
2. edit the copy with `shopify_theme_files_upsert`
3. preview and publish it from the Shopify admin

Start the server with `--allow-live-theme-writes` (or `SHOPIFY_ALLOW_LIVE_THEME_WRITES=true`) to edit the live theme directly. Writing theme files needs `write_themes` and Shopify's theme-code exemption on the app.

## Required API Scopes

Configure these scopes on your app to enable all tools:

| Scope | Tools |
|-------|-------|
| `read_products`, `write_products` | Products, variants, collections |
| `read_publications`, `write_publications` | Publishing |
| `read_metaobjects`, `write_metaobjects` | Metaobject entries |
| `read_metaobject_definitions`, `write_metaobject_definitions` | Metaobject definitions |
| Scope of the owning resource | Metafields (e.g. `read_products` for product metafields, `read_customers` for customer metafields) |
| `read_customers`, `write_customers` | Customers |
| `read_orders` | Orders (last 60 days; add `read_all_orders` for older orders) |
| `read_inventory`, `write_inventory`, `read_locations` | Inventory |
| `read_discounts`, `write_discounts` | Discounts |
| `read_files`, `write_files` | Files |
| `read_themes`, `write_themes` (+ theme-code exemption for writes) | Themes |
| `read_markets`, `write_markets` | Markets |

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
npx -y @acodera/shopify-admin-mcp
```

The client credentials grant only works when the app and the store belong to the same Shopify organization. Tokens last 24 hours and are refreshed automatically.

### Legacy Access Token

For existing custom apps with a `shpat_` token:

```bash
SHOPIFY_STORE=mystore.myshopify.com \
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx \
npx -y @acodera/shopify-admin-mcp
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
| `--toolsets` | `SHOPIFY_TOOLSETS` | Comma-separated toolsets to register (default: all) |
| `--upload-dir` | `SHOPIFY_UPLOAD_DIR` | Directory that local file uploads are confined to (default: local uploads disabled) |
| `--allow-live-theme-writes` | `SHOPIFY_ALLOW_LIVE_THEME_WRITES` | Allow theme file writes and deletes on the live theme (`true` / `1`) |

The store must be a `*.myshopify.com` domain, so credentials are only ever sent to Shopify. Secrets can still be passed as flags, but the server prints a warning because flags are visible to other processes on the machine.

## Usage with Claude Code

With OAuth client credentials (Dev Dashboard app):

```bash
claude mcp add shopify \
  -e SHOPIFY_STORE=mystore.myshopify.com \
  -e SHOPIFY_CLIENT_ID=your_client_id \
  -e SHOPIFY_CLIENT_SECRET=your_client_secret \
  -- npx -y @acodera/shopify-admin-mcp
```

With a legacy access token:

```bash
claude mcp add shopify \
  -e SHOPIFY_STORE=mystore.myshopify.com \
  -e SHOPIFY_ACCESS_TOKEN=shpat_xxxxx \
  -- npx -y @acodera/shopify-admin-mcp
```

Or add it to your project's `.mcp.json`. Claude Code expands `${VAR}` from your shell environment, so the file can be committed without secrets. With client credentials:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "@acodera/shopify-admin-mcp"],
      "env": {
        "SHOPIFY_STORE": "mystore.myshopify.com",
        "SHOPIFY_CLIENT_ID": "${SHOPIFY_CLIENT_ID}",
        "SHOPIFY_CLIENT_SECRET": "${SHOPIFY_CLIENT_SECRET}"
      }
    }
  }
}
```

With a legacy access token:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "@acodera/shopify-admin-mcp"],
      "env": {
        "SHOPIFY_STORE": "mystore.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "${SHOPIFY_ACCESS_TOKEN}"
      }
    }
  }
}
```

To add options such as `--read-only` or `--toolsets`, see [Adding Options](#adding-options).

## Usage with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`). With client credentials:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "@acodera/shopify-admin-mcp"],
      "env": {
        "SHOPIFY_STORE": "mystore.myshopify.com",
        "SHOPIFY_CLIENT_ID": "your_client_id",
        "SHOPIFY_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

With a legacy access token:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "@acodera/shopify-admin-mcp"],
      "env": {
        "SHOPIFY_STORE": "mystore.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxx"
      }
    }
  }
}
```

If you install the package globally (`npm install -g @acodera/shopify-admin-mcp`), you can use `"command": "shopify-admin-mcp"` with no `args`.

## Adding Options

Options from the [Configuration](#configuration) table go **after the package name**, either as flags or as environment variables.

### As flags

With `claude mcp add`, append them after the package name:

```bash
claude mcp add shopify \
  -e SHOPIFY_STORE=mystore.myshopify.com \
  -e SHOPIFY_CLIENT_ID=your_client_id \
  -e SHOPIFY_CLIENT_SECRET=your_client_secret \
  -- npx -y @acodera/shopify-admin-mcp --toolsets products,collections,publishing,files --upload-dir /Users/you/shopify-uploads
```

In `.mcp.json` or the Claude Desktop config, add them to `args`. Each flag and each value is its own string:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": [
        "-y", "@acodera/shopify-admin-mcp",
        "--toolsets", "products,collections,publishing,files",
        "--upload-dir", "/Users/you/shopify-uploads"
      ],
      "env": {
        "SHOPIFY_STORE": "mystore.myshopify.com",
        "SHOPIFY_CLIENT_ID": "${SHOPIFY_CLIENT_ID}",
        "SHOPIFY_CLIENT_SECRET": "${SHOPIFY_CLIENT_SECRET}"
      }
    }
  }
}
```

A read-only assistant for reporting:

```json
"args": ["-y", "@acodera/shopify-admin-mcp", "--read-only", "--toolsets", "products,orders,customers"]
```

A theme editor that may change the live theme:

```json
"args": ["-y", "@acodera/shopify-admin-mcp", "--toolsets", "themes,files", "--allow-live-theme-writes"]
```

Every flag at once, with client credentials:

```json
"args": [
  "-y", "@acodera/shopify-admin-mcp",
  "--store", "mystore.myshopify.com",
  "--client-id", "your_client_id",
  "--client-secret", "your_client_secret",
  "--api-version", "2026-10",
  "--toolsets", "products,collections,publishing,metafields,metaobjects,customers,orders,inventory,discounts,files,themes,markets",
  "--upload-dir", "/Users/you/shopify-uploads",
  "--allow-live-theme-writes",
  "--read-only"
]
```

`--read-only` hides every write tool, so in practice you wouldn't combine it with `--upload-dir` or `--allow-live-theme-writes`; they're shown together here only for the syntax.

For a legacy token, use `"--access-token", "shpat_xxxxx"` instead of `--client-id` and `--client-secret`. Prefer passing credentials through `env` instead: the server warns when secrets are passed as flags, because flags are visible to other processes on the machine.

### As environment variables

Every flag has an environment variable, which you can put in `env` instead of `args`:

| Flag | Environment variable | Value | Default |
|------|----------------------|-------|---------|
| `--store` | `SHOPIFY_STORE` | `mystore` or `mystore.myshopify.com` | required |
| `--client-id` | `SHOPIFY_CLIENT_ID` | OAuth client ID | none |
| `--client-secret` | `SHOPIFY_CLIENT_SECRET` | OAuth client secret | none |
| `--access-token` | `SHOPIFY_ACCESS_TOKEN` | Legacy `shpat_...` token | none |
| `--api-version` | `SHOPIFY_API_VERSION` | `YYYY-MM` or `unstable` | `2026-10` |
| `--toolsets` | `SHOPIFY_TOOLSETS` | Comma-separated toolsets | all toolsets |
| `--upload-dir` | `SHOPIFY_UPLOAD_DIR` | Absolute folder path | local uploads disabled |
| `--read-only` | `SHOPIFY_READ_ONLY` | `true` or `1` turns it on | off |
| `--allow-live-theme-writes` | `SHOPIFY_ALLOW_LIVE_THEME_WRITES` | `true` or `1` turns it on | off |

Every variable at once, with client credentials:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "@acodera/shopify-admin-mcp"],
      "env": {
        "SHOPIFY_STORE": "mystore.myshopify.com",
        "SHOPIFY_CLIENT_ID": "${SHOPIFY_CLIENT_ID}",
        "SHOPIFY_CLIENT_SECRET": "${SHOPIFY_CLIENT_SECRET}",
        "SHOPIFY_API_VERSION": "2026-10",
        "SHOPIFY_TOOLSETS": "products,collections,publishing,metafields,metaobjects,customers,orders,inventory,discounts,files,themes,markets",
        "SHOPIFY_UPLOAD_DIR": "/Users/you/shopify-uploads",
        "SHOPIFY_READ_ONLY": "false",
        "SHOPIFY_ALLOW_LIVE_THEME_WRITES": "false"
      }
    }
  }
}
```

For a legacy token, replace `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` with `"SHOPIFY_ACCESS_TOKEN": "${SHOPIFY_ACCESS_TOKEN}"`. The `${VAR}` references work in Claude Code's `.mcp.json`; in the Claude Desktop config, write the values directly.

If you set the same option both ways:

- For options that take a value (`--store`, credentials, `--api-version`, `--toolsets`, `--upload-dir`), the flag wins.
- For on/off options (`--read-only`, `--allow-live-theme-writes`), either one turns it on. Setting the variable to `"false"` doesn't turn off a flag that's present.
- If both an access token and client credentials are set, the access token is used.

Use an absolute path for `--upload-dir`, because MCP clients start the server from their own working directory, not your project's.

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
git checkout dev
npm install
npm run build
npm run dev  # watch mode
```

Requires Node.js 22.12 or later.

## Testing

```bash
npm test       # unit tests; live tests are skipped without credentials
npm run lint   # type-check src and tests
```

The unit tests need no network. They cover CLI validation, the HTTP client (throttle retry, token refresh), every tool's request over a real MCP connection, read-only mode, toolsets, the live-theme guard, and upload-directory confinement.

Live integration tests run against a real store when credentials are set:

```bash
SHOPIFY_STORE=your-dev-store.myshopify.com \
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx \
npm test
```

Add `SHOPIFY_TEST_WRITES=1` to also run the write tests. They create `[MCP test]` products, variants, collections, files, metafield and metaobject definitions, customers, a duplicate of the live theme, a draft market, and discounts scheduled a year ahead (so they never apply to real carts), run every write tool against them, and delete them afterwards. The live theme itself is only read. Only run write tests against a development store.

## Contributing and Releases

Work happens on the `dev` branch; `main` holds what's been released.

1. Branch from `dev`, make your change, and add a changeset describing it:

   ```bash
   npx changeset
   ```

   Pick `patch` for fixes, `minor` for new tools or options, and `major` for breaking changes to tool inputs or behaviour. Changes that don't affect the published package (tests, docs, CI) don't need one.

2. Open a pull request into `dev`. CI type-checks, tests, and builds on Node.js 22 and 24, and a bot comments on whether the pull request has a changeset.
3. To release, open a pull request from `dev` into `main` and merge it. The release workflow turns the pending changesets into a **Version Packages** pull request that bumps the version and updates [CHANGELOG.md](CHANGELOG.md).
4. Merge the Version Packages pull request. The workflow publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (no npm token is stored in GitHub), with provenance, and creates a GitHub release.

## License

MIT. See [LICENSE](LICENSE).

Originally created by [Colby McHenry](https://github.com/colbymchenry) as [shopify-graphql-admin-mcp](https://github.com/colbymchenry/shopify-graphql-admin-mcp), and maintained by [acoderacom](https://github.com/acoderacom).
