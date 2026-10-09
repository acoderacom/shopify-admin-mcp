# @acodera/shopify-admin-mcp

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
