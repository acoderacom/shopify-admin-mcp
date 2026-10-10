---
"@acodera/shopify-admin-mcp": minor
---

Full theme design now follows acoderacom/claude-horizon's `versions.json`. A live theme on any supported version matches, and the project gets that exact Horizon commit and its `versions/<version>/THEME.md`, with the version filled in to `CLAUDE.md` and `customizations.md`; there's no version menu anymore. When the live theme is older, newer or not Horizon, setup explains that the Shopify theme store only installs the newest Horizon and offers to save an upload-ready `horizon-<version>.zip` to upload in the Shopify admin, then stops. Setup reads the template and Horizon from GitHub without its API, so its rate limit no longer applies.
