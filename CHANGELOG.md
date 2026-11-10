# Changelog

## Unreleased

- Pictures come from OpenVibe.AI's one shared image task (`image.picture`): `POST /api/v1/pages/:id/images/suggest`
  asks its find mode once (Commons/Openverse, licence and author kept) and gets Media references in the wiki tenant
  rather than external URLs; its make mode draws an illustration only when nothing real exists, never for a real
  person, and labels it "Illustration made with <model>". The "Vibe a wiki" writer uses the same find mode instead of
  fetching and uploading pictures itself. `server/wiki/images.js`, `server/wiki/vibe.js`; tests `wiki-rich`, `vibe`.

- Rich wiki articles (rich-content plan W1): a body is Markdown plus `openvibe-publishing/blocks` (infobox, figure, gallery, timeline, quote, callout, stat, …), rendered server-side by `server/render/blocks.js` in the article, the editor's preview, the `.json` body and the Markdown twin; a body with no blocks renders as before. The API takes `blocks` on create and revision writes, serializes them to the Markdown a revision keeps, and returns `blocks` next to `body_markdown` (`?format=blocks` for the tree alone). Pins `openvibe-publishing` v1.6.1. `test/wiki-rich.test.js`.
- The image task: `POST /api/v1/pages/:id/images/suggest` asks `wiki.article.images` for the lead picture and figures — Commons and Openverse first with the licence and author kept, then OpenVibe.Pics and the page's Media; an AI illustration only when nothing real exists and never for an article about a real person ("Illustration made with <model>"). `server/wiki/images.js`.
- The wiki writer: `POST /api/v1/pages/:id/draft` runs OpenVibe.AI's `content.wiki` workflow (web search plus the article's own sources, a citation on every sentence, the infobox from structured facts) and files the revision as a pending proposal. It never publishes. `server/wiki/writer.js`.
- Share: every article carries the network's one Share button (`data-ov-share-sheet`) in its page actions, with the article's canonical address, title and summary; `openvibe-shared`'s navbar loads the sheet on the first press. `test/share-sheet.test.js`.
- Account export and deletion (ADR-033): `POST /internal/events` (loopback, `WIKI_EVENTS_SECRET`) answers network.account.export_requested and network.account.deleted through `server/wiki/account-data.js` over `openvibe-sdk/account-data` (SDK v0.37.0, was v0.35.0).
  - **Deleted:** the person's own user spaces (through `deleteSpace`), roles, watches and drafts.
  - **Authorless:** their contributions elsewhere stay without their id.
  - **Kept:** reviews.
  - Migration `0002_account_erasure.sql` adds `account_data_events` and lets only the erasure transaction clear the author on the append-only revisions and citations. The two subscriptions are created at boot. `test/account-data.test.js`.
- Pin refresh: `openvibe-contracts` v0.96.0 → v0.107.0, `openvibe-shared` v2.9.0 → v2.11.0 and `openvibe-sdk` v0.26.0 → v0.34.0 (`openvibe-publishing` stays v1.3.0, already the newest tag). The releases are additive — Contracts adds capabilities and event schemas for other services, Shared adds showcase next-step cards and a Bot icon, SDK adds Fabric/usage/bot subpaths and a PGlite-backed `createTestDb` — with no change to the shell a page renders through or to any contract this service validates, so no route, page or payload changed.
- `openvibe-contracts` v0.76.0 → v0.96.0: the wiki capabilities, the wiki service manifest and the `wiki.*` event payload schemas are released in Contracts, so the service-token guard resolves `wiki.*` through the library (the local proposal fallback stays for a future id) and `openvibe-contracts-check --service wiki` passes. Every event the service emits validates against its `wiki.*` payload schema (`test/event-contracts.test.js`). No route, body or payload changed.
- `openvibe-publishing` v1.2.0 → v1.3.0: `/llms-full.txt` now publishes the `llms.txt` header plus an excerpt of every indexable page (the same gate as the sitemap, never a whole article) under a 512 KiB cap, and the home page carries the site's one-line `ai-summary` meta and WebPage JSON-LD.
- Every page is rendered through `openvibe-publishing/layout` (`openvibe-shared/shell` page()) instead of a local template: the same head tags, stylesheets, feed links, app icon and Frame, with robots still explicit on every page (the gate's decision on an article, a string elsewhere); `openvibe-shared` v2.5.0 → v2.6.0 and `openvibe-publishing` v1.1.0 → v1.2.0, and the JS size budgets rise by the shell's `web-runtime.js` (5 files, 245 KB raw, 59 KB brotli).
- A set-but-invalid `INDEXNOW_KEY` (not 8–128 hex/alnum) no longer crashes the service at boot: Wiki logs a warning and serves with IndexNow off, exactly as when the key is unset.
