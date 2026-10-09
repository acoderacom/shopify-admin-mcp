---
"@acodera/shopify-admin-mcp": patch
---

Treat blank values and unfilled `${VAR}` / `$VAR` references as not set for every option, so a config can list both an access token and client credentials and use whichever is filled in (previously a literal `${SHOPIFY_ACCESS_TOKEN}` was sent as the token). The startup log now names the authentication method, and incomplete client credentials report which value is missing.
