# Changelog

## Unreleased

- Every page is rendered through `openvibe-publishing/layout` (`openvibe-shared/shell` page()) instead of a local template: the same head tags, stylesheets, feed links, app icon and Frame, with robots still explicit on every page (the gate's decision on an article, a string elsewhere); `openvibe-shared` v2.5.0 → v2.6.0 and `openvibe-publishing` v1.1.0 → v1.2.0, and the JS size budgets rise by the shell's `web-runtime.js` (5 files, 245 KB raw, 59 KB brotli).
- A set-but-invalid `INDEXNOW_KEY` (not 8–128 hex/alnum) no longer crashes the service at boot: Wiki logs a warning and serves with IndexNow off, exactly as when the key is unset.
