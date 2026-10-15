---
"@acodera/shopify-admin-mcp": minor
---

Add a third setup mode, **Full theme edit live site**, for working on a copy of a live store's theme, Horizon or not, without Horizon's checks. Setup lists the store's themes and you pick the unpublished copy Claude edits; the live theme is listed but can't be picked, and setup stops, saying how to make a copy, when the store has none. Live theme writes stay off and themes are locked, so the server refuses any change to the live theme and any theme create, duplicate, rename, delete or publish. It switches on theme files from `./theme`, uploads from `./uploads` and the Shopify Dev MCP, and writes `CLAUDE.md` and `customizations.md` from the template's `live-site/` folder with the copy's name, version and ID filled in, a blank `THEME.md` and an empty `./theme`. Copying the theme into `./theme`, having Claude learn it (write `THEME.md`) and publishing the copy are left to you. Running it again keeps `./theme`, `THEME.md` and the chosen copy unless you change them, warns when that copy has since been published, and asks first before switching a Horizon project over.

Add `--lock-themes` (`SHOPIFY_LOCK_THEMES`): theme files can still be edited, but the duplicate and delete tools are left out, and raw GraphQL refuses `themeCreate`, `themeDuplicate`, `themeUpdate`, `themeDelete` and `themePublish`.

The credentials check now reads every theme the store has, not only the live one. The Horizon mode is now labelled **Full theme design with Horizon**, and it replaces a `CLAUDE.md` written for a live site along with the files it already asked about.
