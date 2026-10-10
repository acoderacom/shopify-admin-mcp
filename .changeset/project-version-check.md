---
"@acodera/shopify-admin-mcp": minor
---

Setup now asks right after the Node.js check whether to connect to a store only or set up full theme design. Connecting to a store only turns theme edits off. Full theme design checks the template and Horizon versions on GitHub before any store questions, then checks the store's live theme against the template: a match is confirmed and recommended in the version menu, and a live theme that's older, newer, not Horizon or unreadable gets an upgrade or downgrade notice and stops setup without writing anything.
