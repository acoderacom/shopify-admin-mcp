---
"@acodera/shopify-admin-mcp": minor
---

Support Windows. CI now runs every test on Windows as well as Linux, and starts the packed server through npm's command shim the way `npx` does. Local uploads now compare paths the way Windows does (letter case, short folder names such as `RUNNER~1`, other drives), and a path outside the upload folder is refused with the same message whether or not the file exists, so the error doesn't reveal what's on the machine. The README notes the Windows Claude Desktop config path, and that Windows has no owner-only file mode for `.mcp.json`.
