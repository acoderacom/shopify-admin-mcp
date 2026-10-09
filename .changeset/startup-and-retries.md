---
"@acodera/shopify-admin-mcp": patch
---

The server checks credentials with a small `shop` query and connects before introspecting the schema, so a slow introspection no longer delays the client's handshake; schema tools wait for it and retry it if it failed. HTTP 429 responses honor `Retry-After` (up to a minute), and discarded responses are released before retrying. `shopify_schema_details` lists root types by name and shortens descriptions on very large types, `shopify_schema_search` rejects an empty query, and the server sends usage instructions to MCP clients.
