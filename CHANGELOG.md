# @acodera/shopify-admin-mcp

## 1.2.0

### Minor Changes

- [#9](https://github.com/acoderacom/shopify-admin-mcp/pull/9) [`4ffbe0b`](https://github.com/acoderacom/shopify-admin-mcp/commit/4ffbe0be98eb30b25a24ae6a05486346db66508d) Thanks [@acoderacom](https://github.com/acoderacom)! - Apply the live-theme guard to `shopify_graphql`: `themeFilesUpsert`, `themeFilesDelete`, and `themeFilesCopy` are refused when they target the live theme, and `themePublish` is refused, unless the server runs with `--allow-live-theme-writes`. Previously raw GraphQL could skip the guard the theme tools enforce. Add `--disable-raw-graphql` (`SHOPIFY_DISABLE_RAW_GRAPHQL`) to leave out `shopify_graphql`, so `--toolsets` limits what the assistant can reach.

### Patch Changes

- [#9](https://github.com/acoderacom/shopify-admin-mcp/pull/9) [`4ffbe0b`](https://github.com/acoderacom/shopify-admin-mcp/commit/4ffbe0be98eb30b25a24ae6a05486346db66508d) Thanks [@acoderacom](https://github.com/acoderacom)! - Discount create tools reject inputs Shopify can't apply as asked. Combining `customerIds`, `customerSegmentIds`, and `marketIds` used to fail at Shopify, because a discount takes one kind of eligibility. Passing `collectionIds` together with `productIds` or `variantIds` used to drop the products and variants without a word.

- [#9](https://github.com/acoderacom/shopify-admin-mcp/pull/9) [`4ffbe0b`](https://github.com/acoderacom/shopify-admin-mcp/commit/4ffbe0be98eb30b25a24ae6a05486346db66508d) Thanks [@acoderacom](https://github.com/acoderacom)! - Nested lists with a fixed size (product variants and metafields, order line items, inventory levels, customer addresses and orders, theme files, publications, market regions, and more) now include `pageInfo.hasNextPage`, and `shopify_product_get` returns `variantsCount`, so the assistant can tell when results were cut short. Product tools accept the `UNLISTED` status. `shopify_theme_files_get` flags files it couldn't read as an error, and `shopify_file_upload` reports Shopify's reason when a staged upload is rejected instead of a JavaScript error.

- [#9](https://github.com/acoderacom/shopify-admin-mcp/pull/9) [`4ffbe0b`](https://github.com/acoderacom/shopify-admin-mcp/commit/4ffbe0be98eb30b25a24ae6a05486346db66508d) Thanks [@acoderacom](https://github.com/acoderacom)! - The server checks credentials with a small `shop` query and connects before introspecting the schema, so a slow introspection no longer delays the client's handshake; schema tools wait for it and retry it if it failed. HTTP 429 responses honor `Retry-After` (up to a minute), and discarded responses are released before retrying. `shopify_schema_details` lists root types by name and shortens descriptions on very large types, `shopify_schema_search` rejects an empty query, and the server sends usage instructions to MCP clients.

## 1.1.1

### Patch Changes

- [#7](https://github.com/acoderacom/shopify-admin-mcp/pull/7) [`04f9a39`](https://github.com/acoderacom/shopify-admin-mcp/commit/04f9a39f77ffc3e207e355f758a5141dfe1f127b) Thanks [@acoderacom](https://github.com/acoderacom)! - Treat blank values and unfilled `${VAR}` / `$VAR` references as not set for every option, so a config can list both an access token and client credentials and use whichever is filled in (previously a literal `${SHOPIFY_ACCESS_TOKEN}` was sent as the token). The startup log now names the authentication method, and incomplete client credentials report which value is missing.

- [#7](https://github.com/acoderacom/shopify-admin-mcp/pull/7) [`c062f3a`](https://github.com/acoderacom/shopify-admin-mcp/commit/c062f3a022a7da493b46dee9b9eca8c1835bd980) Thanks [@acoderacom](https://github.com/acoderacom)! - Upgrade `graphql` (used to parse raw GraphQL in read-only mode) from 16 to 17. No behavior change: mutations and subscriptions are still detected and blocked the same way.

## 1.1.0

### Minor Changes

- [#5](https://github.com/acoderacom/shopify-admin-mcp/pull/5) [`82e29cd`](https://github.com/acoderacom/shopify-admin-mcp/commit/82e29cd0bdd28a01f7f56e84da51b918f01a022f) Thanks [@acoderacom](https://github.com/acoderacom)! - Add a `discounts` toolset: list and get discounts; create amount-off (percentage or fixed, on the order or specific products/collections), free shipping, and buy X get Y discounts as codes or automatic discounts, with dates, minimums, usage limits, combinations, and customer/segment/market eligibility; activate, deactivate, and delete them; and add extra codes in bulk.

### Patch Changes

- [#5](https://github.com/acoderacom/shopify-admin-mcp/pull/5) [`921d690`](https://github.com/acoderacom/shopify-admin-mcp/commit/921d690e3f2cf3226e2c45c0ac69077699bdf61d) Thanks [@acoderacom](https://github.com/acoderacom)! - Document every option in the README: a flag-to-environment-variable table with defaults, complete examples using all flags and all environment variables, and which one wins when both are set.

## 1.0.1

### Patch Changes

- [#3](https://github.com/acoderacom/shopify-admin-mcp/pull/3) [`8aef080`](https://github.com/acoderacom/shopify-admin-mcp/commit/8aef080c6558da9bf5e672668f738f0386eb5c43) Thanks [@acoderacom](https://github.com/acoderacom)! - Document OAuth client credentials setup for Claude Code (`claude mcp add` and `.mcp.json`) and Claude Desktop, alongside the legacy access token, and show how to pass options such as `--read-only`, `--toolsets`, and `--upload-dir` as flags or environment variables.

## 1.0.0

### Major Changes

- First release as `@acodera/shopify-admin-mcp`, forked from [shopify-graphql-admin-mcp](https://github.com/colbymchenry/shopify-graphql-admin-mcp) by Colby McHenry.

  - Targets Shopify Admin API 2026-10 and migrates every tool off removed and deprecated fields (`metafieldsDelete`, `productCreate`/`productUpdate` with `product`, collection `sources`, `defaultEmailAddress`, `featuredMedia`). Inventory adjustments send `changeFromQuantity` and an idempotency key.
  - Adds tools for themes, file uploads, markets, publishing, product variants, and metafield and metaobject definitions, grouped into selectable toolsets (`--toolsets`).
  - Security: credentials are only sent to `*.myshopify.com`, a read-only mode blocks mutations, local uploads are confined to `--upload-dir`, live-theme writes need `--allow-live-theme-writes`, and every tool carries read-only / destructive annotations.
  - Retries throttled requests, adds request timeouts, and reports `userErrors` as tool errors.
  - Requires Node.js 22.12 or later. Bin renamed to `shopify-admin-mcp`.
