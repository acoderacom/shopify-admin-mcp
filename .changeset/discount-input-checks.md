---
"@acodera/shopify-admin-mcp": patch
---

Discount create tools reject inputs Shopify can't apply as asked. Combining `customerIds`, `customerSegmentIds`, and `marketIds` used to fail at Shopify, because a discount takes one kind of eligibility. Passing `collectionIds` together with `productIds` or `variantIds` used to drop the products and variants without a word.
