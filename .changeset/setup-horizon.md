---
"@acodera/shopify-admin-mcp": minor
---

Setup can now set up a Horizon theme project. It downloads any version of Shopify's Horizon theme into `./theme`, with the store's live version preselected, and writes `CLAUDE.md`, `THEME.md` and `customizations.md` from acoderacom/claude-horizon. `CLAUDE.md` gets the store, the live theme's ID and version, and the storefront password filled in. A project switches on the settings `CLAUDE.md` describes: live theme writes, uploads from `./uploads`, and the Shopify Dev MCP. Setup now checks the credentials right after you enter them. Replacing theme files or `THEME.md` asks first, and an existing `customizations.md` is always kept.
