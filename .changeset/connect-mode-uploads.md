---
"@acodera/shopify-admin-mcp": patch
---

Setup's "Connect to a store only" mode now switches on local uploads from `./uploads` (and creates the folder), so product images and other local files can be uploaded without editing `.mcp.json`. An upload folder already set in `.mcp.json` is kept. The setup questions also drop their option hints.
