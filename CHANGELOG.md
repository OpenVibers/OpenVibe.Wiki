# Changelog

## Unreleased

- `openvibe-contracts` v0.76.0 → v0.96.0: the wiki capabilities, the wiki service manifest and the `wiki.*` event payload schemas are released in Contracts, so the service-token guard resolves `wiki.*` through the library (the local proposal fallback stays for a future id) and `openvibe-contracts-check --service wiki` passes. Every event the service emits validates against its `wiki.*` payload schema (`test/event-contracts.test.js`). No route, body or payload changed.
- `openvibe-publishing` v1.2.0 → v1.3.0: `/llms-full.txt` now publishes the `llms.txt` header plus an excerpt of every indexable page (the same gate as the sitemap, never a whole article) under a 512 KiB cap, and the home page carries the site's one-line `ai-summary` meta and WebPage JSON-LD.
- Every page is rendered through `openvibe-publishing/layout` (`openvibe-shared/shell` page()) instead of a local template: the same head tags, stylesheets, feed links, app icon and Frame, with robots still explicit on every page (the gate's decision on an article, a string elsewhere); `openvibe-shared` v2.5.0 → v2.6.0 and `openvibe-publishing` v1.1.0 → v1.2.0, and the JS size budgets rise by the shell's `web-runtime.js` (5 files, 245 KB raw, 59 KB brotli).
- A set-but-invalid `INDEXNOW_KEY` (not 8–128 hex/alnum) no longer crashes the service at boot: Wiki logs a warning and serves with IndexNow off, exactly as when the key is unset.
