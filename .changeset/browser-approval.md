---
"@acodera/shopify-admin-mcp": minor
---

Setup can now get an access token for an app installed on a store outside the app's organization, where Shopify refuses client credentials with `shop_not_permitted`: choose **Client ID and secret, approved in the browser**. Setup prints the redirect URL to add to the app's version (`http://localhost:3457/auth/callback`), opens Shopify's approval page, checks the callback's shop, state and HMAC on a loopback-only local server, and exchanges the code for an offline access token, which it saves as access-token auth. The client secret is only used for the approval and isn't saved.
