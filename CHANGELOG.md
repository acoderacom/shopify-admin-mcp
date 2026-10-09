# @acodera/shopify-admin-mcp

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
