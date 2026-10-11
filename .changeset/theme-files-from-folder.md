---
"@acodera/shopify-admin-mcp": minor
---

Send and pull theme files through a local folder, so file content doesn't pass through the conversation.

- New `--theme-dir` option (`SHOPIFY_THEME_DIR`): the absolute path of a local copy of the theme. Reads and writes stay inside it, refusing paths and symlinks that lead outside and files outside the theme's own folders.
- `shopify_theme_files_upsert` sends a file given only its filename from that folder, as text or base64. After Shopify's write job finishes, it reports whether each file was stored as sent; a file Shopify returns changed (JSON templates get its header and are reformatted, `config/settings_data.json` is rebuilt) is replaced in the folder with Shopify's copy.
- New `shopify_theme_files_pull` tool (with `--theme-dir`): copies theme files or patterns into the folder, up to 50 per call, returning only filenames and checksums and leaving matching files alone.
- Setup's Full theme design sets `SHOPIFY_THEME_DIR` to `./theme`.

A 50 KB section now takes about 2 seconds to push instead of minutes.
