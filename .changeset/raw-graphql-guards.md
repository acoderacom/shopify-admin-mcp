---
"@acodera/shopify-admin-mcp": minor
---

Apply the live-theme guard to `shopify_graphql`: `themeFilesUpsert`, `themeFilesDelete`, and `themeFilesCopy` are refused when they target the live theme, and `themePublish` is refused, unless the server runs with `--allow-live-theme-writes`. Previously raw GraphQL could skip the guard the theme tools enforce. Add `--disable-raw-graphql` (`SHOPIFY_DISABLE_RAW_GRAPHQL`) to leave out `shopify_graphql`, so `--toolsets` limits what the assistant can reach.
