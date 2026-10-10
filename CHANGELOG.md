# @acodera/shopify-admin-mcp

## 1.7.0

### Minor Changes

- [#28](https://github.com/acoderacom/shopify-admin-mcp/pull/28) [`a852a81`](https://github.com/acoderacom/shopify-admin-mcp/commit/a852a81bba5e78302bae15a7aa6d49f27f876e40) Thanks [@acoderacom](https://github.com/acoderacom)! - Full theme design now follows acoderacom/claude-horizon's `versions.json`. A live theme on any supported version matches, and the project gets that exact Horizon commit and its `versions/<version>/THEME.md`, with the version filled in to `CLAUDE.md` and `customizations.md`; there's no version menu anymore. When the live theme is older, newer or not Horizon, setup explains that the Shopify theme store only installs the newest Horizon and offers to save an upload-ready `horizon-<version>.zip` to upload in the Shopify admin, then stops. Setup reads the template and Horizon from GitHub without its API, so its rate limit no longer applies.

## 1.6.0

### Minor Changes

- [#25](https://github.com/acoderacom/shopify-admin-mcp/pull/25) [`eec97fc`](https://github.com/acoderacom/shopify-admin-mcp/commit/eec97fc2b6f39d6d2f00a150c64acf2871662a70) Thanks [@acoderacom](https://github.com/acoderacom)! - Setup no longer has an advanced settings step. Connecting to a store only asks for the store, the credentials and the Shopify Dev MCP; read-only mode, toolsets, local uploads and raw GraphQL can still be set in `.mcp.json` by hand, and connecting to a store only keeps them. The summary's "Advanced" line is now "Settings" and shows what the file ends up with.

## 1.5.0

### Minor Changes

- [#22](https://github.com/acoderacom/shopify-admin-mcp/pull/22) [`93efebc`](https://github.com/acoderacom/shopify-admin-mcp/commit/93efebc446107b2bcade9918a6e0e06689d1a7c0) Thanks [@acoderacom](https://github.com/acoderacom)! - New `--disable-theme-writes` option (`SHOPIFY_DISABLE_THEME_WRITES`) refuses every theme change: the theme write tools are left out, and raw GraphQL refuses all theme mutations, whichever theme they target. It overrides `--allow-live-theme-writes`.

- [#22](https://github.com/acoderacom/shopify-admin-mcp/pull/22) [`fd6d1c1`](https://github.com/acoderacom/shopify-admin-mcp/commit/fd6d1c16f290f25c43ecffe930c12800ed7c7995) Thanks [@acoderacom](https://github.com/acoderacom)! - Setup now asks right after the Node.js check whether to connect to a store only or set up full theme design. Connecting to a store only turns theme edits off. Full theme design checks the template and Horizon versions on GitHub before any store questions, then checks the store's live theme against the template: a match is confirmed and recommended in the version menu, and a live theme that's older, newer, not Horizon or unreadable gets an upgrade or downgrade notice and stops setup without writing anything.

### Patch Changes

- [#21](https://github.com/acoderacom/shopify-admin-mcp/pull/21) [`3fa6ece`](https://github.com/acoderacom/shopify-admin-mcp/commit/3fa6ecee2e128c4de6da9234abdcc6f918ab4bb5) Thanks [@acoderacom](https://github.com/acoderacom)! - Setup's authentication choices read "Access token (legacy custom app)" and "Client ID and secret (dev dashboard app)", without the token prefix.

## 1.4.0

### Minor Changes

- [#16](https://github.com/acoderacom/shopify-admin-mcp/pull/16) [`d9a835a`](https://github.com/acoderacom/shopify-admin-mcp/commit/d9a835a60427d1a61825ac2fcdf9d6690c0f12ed) Thanks [@acoderacom](https://github.com/acoderacom)! - Setup can now set up a Horizon theme project. It downloads any version of Shopify's Horizon theme into `./theme`, with the store's live version preselected, and writes `CLAUDE.md`, `THEME.md` and `customizations.md` from acoderacom/claude-horizon. `CLAUDE.md` gets the store, the live theme's ID and version, and the storefront password filled in. A project switches on the settings `CLAUDE.md` describes: live theme writes, uploads from `./uploads`, and the Shopify Dev MCP. Setup now checks the credentials right after you enter them. Replacing theme files or `THEME.md` asks first, and an existing `customizations.md` is always kept.

### Patch Changes

- [#15](https://github.com/acoderacom/shopify-admin-mcp/pull/15) [`636014a`](https://github.com/acoderacom/shopify-admin-mcp/commit/636014a09fc6aed6598ccfc1816349c00f63d5e6) Thanks [@acoderacom](https://github.com/acoderacom)! - The setup wizard's Node.js check calls this server "Shopify Admin MCP", matching "Shopify Dev MCP", instead of using the package name.

## 1.3.0

### Minor Changes

- [#12](https://github.com/acoderacom/shopify-admin-mcp/pull/12) [`83cdeb7`](https://github.com/acoderacom/shopify-admin-mcp/commit/83cdeb7543cb55f12167fceba0d7e74dbb5acccf) Thanks [@acoderacom](https://github.com/acoderacom)! - Add a `setup` command (`npx @acodera/shopify-admin-mcp setup`): an interactive wizard, built with Clack, that creates or updates `.mcp.json` in the current folder. It checks that Node.js meets the requirements of this server and the Shopify Dev MCP, asks for the store and an access token or client credentials, optionally adds the Shopify Dev MCP server, and offers advanced settings including creating an upload folder. It verifies the credentials before saving, keeps other servers and current values, writes the file readable only by its owner, and adds it to `.gitignore` in a git repo. The server itself never loads the wizard's code.

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
