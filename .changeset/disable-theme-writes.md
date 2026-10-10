---
"@acodera/shopify-admin-mcp": minor
---

New `--disable-theme-writes` option (`SHOPIFY_DISABLE_THEME_WRITES`) refuses every theme change: the theme write tools are left out, and raw GraphQL refuses all theme mutations, whichever theme they target. It overrides `--allow-live-theme-writes`.
