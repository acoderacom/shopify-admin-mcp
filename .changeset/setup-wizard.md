---
"@acodera/shopify-admin-mcp": minor
---

Add a `setup` command (`npx @acodera/shopify-admin-mcp setup`): an interactive wizard, built with Clack, that creates or updates `.mcp.json` in the current folder. It checks that Node.js meets the requirements of this server and the Shopify Dev MCP, asks for the store and an access token or client credentials, optionally adds the Shopify Dev MCP server, and offers advanced settings including creating an upload folder. It verifies the credentials before saving, keeps other servers and current values, writes the file readable only by its owner, and adds it to `.gitignore` in a git repo. The server itself never loads the wizard's code.
