# shopify-admin-mcp

[![npm](https://img.shields.io/npm/v/@acodera/shopify-admin-mcp)](https://www.npmjs.com/package/@acodera/shopify-admin-mcp)
[![CI](https://github.com/acoderacom/shopify-admin-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/acoderacom/shopify-admin-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

MCP server for Shopify's Admin GraphQL API: typed tools for common store tasks, raw GraphQL for everything else, and live schema search so your AI assistant works against the exact API your store serves. Targets API version **2026-10**.

## Features

- **59 convenience tools** for products, collections, publishing, metafields, metaobjects, customers, orders, inventory, discounts, files, themes, and markets
- **Raw GraphQL and live schema search** for anything the tools don't cover
- **Setup wizard** that writes `.mcp.json` for you
- **Safety controls**: read-only mode, toolsets, a live-theme guard, confined local uploads, and read-only or destructive annotations on every tool
- **Both auth methods**: Dev Dashboard client credentials (refreshed automatically) and legacy `shpat_` tokens
- **Rate-limit aware**: throttled requests wait for the cost bucket to refill, then retry

## Quick Start

Run the setup wizard in your project folder:

```bash
npx -y @acodera/shopify-admin-mcp@latest setup
```

It checks your Node.js version, asks for your store and credentials and checks them, optionally adds the [Shopify Dev MCP](https://shopify.dev/docs/apps/build/devmcp) server and advanced settings, and creates or updates `.mcp.json`. It can also set up a Horizon theme project: any version of Shopify's [Horizon](https://github.com/Shopify/horizon) theme in `./theme` (the store's live version is preselected), plus `CLAUDE.md`, `THEME.md` and `customizations.md` from [acoderacom/claude-horizon](https://github.com/acoderacom/claude-horizon), with the store and live theme filled in to `CLAUDE.md`. Current values are prefilled and other servers are kept. The secret is saved in plain text, so the file is written readable only by you and added to `.gitignore` in a git repo. Restart Claude Code (or run `/mcp`) to connect.

### Manual setup

With Claude Code:

```bash
claude mcp add shopify \
  -e SHOPIFY_STORE=mystore.myshopify.com \
  -e SHOPIFY_CLIENT_ID=your_client_id \
  -e SHOPIFY_CLIENT_SECRET=your_client_secret \
  -- npx -y @acodera/shopify-admin-mcp
```

Or in `.mcp.json`, or the Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

For a legacy token, set `SHOPIFY_ACCESS_TOKEN` instead of the client ID and secret. Claude Code expands `${VAR}` from your shell, so `.mcp.json` can be committed without secrets; Claude Desktop doesn't, so write the values there directly.

## Authentication

- **Client credentials (recommended):** create an app in the [Dev Dashboard](https://dev.shopify.com/dashboard), configure the scopes below, release a version, install it on your store, and use its client ID and secret. The app and the store must belong to the same Shopify organization. Tokens last 24 hours and are refreshed automatically.
- **Legacy access token:** the `shpat_` token of an existing custom app.

Grant only the scopes for the tools you use:

| Scopes | Tools |
|--------|-------|
| `read_products`, `write_products` | Products, variants, collections |
| `read_publications`, `write_publications` | Publishing |
| `read_metaobjects`, `write_metaobjects` | Metaobject entries |
| `read_metaobject_definitions`, `write_metaobject_definitions` | Metaobject definitions |
| Scope of the owning resource | Metafields (e.g. `read_products` for product metafields) |
| `read_customers`, `write_customers` | Customers |
| `read_orders` (+ `read_all_orders` for orders older than 60 days) | Orders |
| `read_inventory`, `write_inventory`, `read_locations` | Inventory |
| `read_discounts`, `write_discounts` | Discounts |
| `read_files`, `write_files` | Files |
| `read_themes`, `write_themes` (+ theme-code exemption for writes) | Themes |
| `read_markets`, `write_markets` | Markets |

Customer names, emails, phone numbers, and addresses are [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data), which your app must also be approved for.

## Tools

Always available: `shopify_graphql` (any query or mutation; queries only in read-only mode), `shopify_schema_search`, and `shopify_schema_details`. The rest are grouped into toolsets, all registered by default:

| Toolset | Tools (each prefixed `shopify_`) |
|---------|----------------------------------|
| `products` | `products_list`, `product_get`, `product_create`, `product_update`, `product_delete`, `product_variants_create`, `product_variants_update` |
| `collections` | `collections_list`, `collection_get`, `collection_create`, `collection_update`, `collection_delete` |
| `publishing` | `publications_list`, `publish`, `unpublish` |
| `metafields` | `metafields_list`, `metafields_set`, `metafield_delete`, `metafield_definitions_list`, `metafield_definition_create` |
| `metaobjects` | `metaobject_definitions_list`, `metaobject_definition_create`, `metaobjects_list`, `metaobject_get`, `metaobject_create`, `metaobject_update`, `metaobject_upsert`, `metaobject_delete` |
| `customers` | `customers_list`, `customer_get`, `customer_update` |
| `orders` | `orders_list`, `order_get` |
| `inventory` | `inventory_get_levels`, `inventory_adjust` |
| `discounts` | `discounts_list`, `discount_get`, `discount_amount_off_create`, `discount_free_shipping_create`, `discount_bxgy_create`, `discount_activate`, `discount_deactivate`, `discount_delete`, `discount_codes_add` |
| `files` | `files_list`, `file_upload`, `file_delete` |
| `themes` | `themes_list`, `theme_files_list`, `theme_files_get`, `theme_files_upsert`, `theme_files_delete`, `theme_duplicate`, `theme_delete` |
| `markets` | `markets_list`, `market_get`, `market_create`, `market_update`, `market_delete` |

A few inputs follow API 2026-10: collections define their products with `sources` (see `CollectionCreateSourceTargetInput` in `shopify_schema_details`), `shopify_inventory_adjust` needs the quantity you expect before the change (`changeFromQuantity`), and a discount takes one kind of eligibility (`customerIds`, `customerSegmentIds`, or `marketIds`) and items by collection or by product, not both.

## Safety

- **Read-only mode** (`--read-only`) registers only tools that read data and rejects mutations in raw GraphQL. The document is parsed, so comments or extra operations can't slip one through. Use it whenever the assistant doesn't need to change the store: product descriptions and customer notes are written by other people and can carry instructions.
- **Toolsets** (`--toolsets products,orders`) shorten the tool list, but raw GraphQL can still reach anything your scopes allow. Add `--disable-raw-graphql` to keep the assistant to the selected toolsets. Either way, the app's scopes are the real limit.
- **The live theme** is protected: theme file writes and deletes on the published (`MAIN`) theme are refused, including through raw GraphQL, where `themePublish` is refused too. Duplicate the theme, edit the copy, and publish it from the Shopify admin, or start with `--allow-live-theme-writes`.
- **Local uploads** are off until you set `--upload-dir`. `shopify_file_upload` then accepts files inside that folder (symlinks resolved), as well as public URLs that Shopify fetches itself.
- **Credentials** are only ever sent to `*.myshopify.com`, and the server warns when secrets are passed as flags, since other processes can see them.

## Configuration

Every option works as a flag after the package name (in `args`) or as an environment variable (in `env`):

| Flag | Environment variable | Default | Description |
|------|----------------------|---------|-------------|
| `--store` | `SHOPIFY_STORE` | required | `mystore` or `mystore.myshopify.com` |
| `--access-token` | `SHOPIFY_ACCESS_TOKEN` | | Legacy `shpat_` token |
| `--client-id` | `SHOPIFY_CLIENT_ID` | | Client credentials ID |
| `--client-secret` | `SHOPIFY_CLIENT_SECRET` | | Client credentials secret |
| `--api-version` | `SHOPIFY_API_VERSION` | `2026-10` | `YYYY-MM` or `unstable` |
| `--toolsets` | `SHOPIFY_TOOLSETS` | all | Comma-separated toolsets to register |
| `--upload-dir` | `SHOPIFY_UPLOAD_DIR` | off | Absolute path that local uploads are confined to |
| `--read-only` | `SHOPIFY_READ_ONLY` | off | Read tools only, no mutations |
| `--allow-live-theme-writes` | `SHOPIFY_ALLOW_LIVE_THEME_WRITES` | off | Allow writing to and publishing the live theme |
| `--disable-raw-graphql` | `SHOPIFY_DISABLE_RAW_GRAPHQL` | off | Leave out `shopify_graphql` |

For example: `"args": ["-y", "@acodera/shopify-admin-mcp", "--read-only", "--toolsets", "products,orders,customers"]`.

- On/off variables accept `true` or `1`. When an option is set both ways, the flag wins; for on/off options, either one turns it on.
- Blank values and unfilled references (`${VAR}`, `$VAR`) count as not set, so one config can list both auth methods. If both are filled in, the access token is used.
- Use an absolute `--upload-dir`, since MCP clients start the server from their own working directory.
- With an older `--api-version`, raw GraphQL works but some tools may not. The server logs a warning if Shopify serves a different version than the one requested.

## Schema Exploration

The server introspects the live schema in the background once it connects. `shopify_schema_search` finds types, queries, and mutations by keyword, and `shopify_schema_details` shows a type's fields or an operation's arguments. Deprecated fields are left out, which steers the assistant toward the current API.

## Development

```bash
git clone https://github.com/acoderacom/shopify-admin-mcp.git
cd shopify-admin-mcp && git checkout dev && npm install
npm run build   # or `npm run dev` to rebuild on change
npm test        # unit tests; live tests skip themselves without credentials
npm run lint    # type-check src and tests
```

Requires Node.js 22.12 or later. Setting `SHOPIFY_STORE` and credentials also runs the live tests; adding `SHOPIFY_TEST_WRITES=1` runs write tests that create and then delete `[MCP test]` data, so only use it with a development store.

To contribute, branch from `dev`, add a changeset with `npx changeset` (not needed for docs, tests, or CI), and open a pull request into `dev`. Releases merge `dev` into `main`; the workflow then opens a **Version Packages** pull request, and merging it publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) with provenance.

## License

MIT. See [LICENSE](LICENSE).

Originally created by [Colby McHenry](https://github.com/colbymchenry) as [shopify-graphql-admin-mcp](https://github.com/colbymchenry/shopify-graphql-admin-mcp), and maintained by [acoderacom](https://github.com/acoderacom).
