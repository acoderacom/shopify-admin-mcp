---
"@acodera/shopify-admin-mcp": patch
---

Nested lists with a fixed size (product variants and metafields, order line items, inventory levels, customer addresses and orders, theme files, publications, market regions, and more) now include `pageInfo.hasNextPage`, and `shopify_product_get` returns `variantsCount`, so the assistant can tell when results were cut short. Product tools accept the `UNLISTED` status. `shopify_theme_files_get` flags files it couldn't read as an error, and `shopify_file_upload` reports Shopify's reason when a staged upload is rejected instead of a JavaScript error.
