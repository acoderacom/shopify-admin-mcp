---
"@acodera/shopify-admin-mcp": minor
---

Setup's "Full theme design with Horizon" now starts by listing the Horizon versions the template supports, newest first with the recommended one marked, and asks which one the project uses. The store's live theme must be that version; otherwise setup saves its zip and waits as before, and says when the live theme is another supported version that could be chosen instead. A Horizon live theme whose version can't be read now waits for the switch too, instead of stopping setup. A folder set up before starts on its own version.
