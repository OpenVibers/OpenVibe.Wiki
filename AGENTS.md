# AGENTS.md — OpenVibe.Wiki

## Project overview

OpenVibe.Wiki (`https://openvibe.wiki`) is the network's knowledge product: wiki spaces (official
editorial and community), page trees with canonical slugs, immutable revisions with diff and revert,
typed infoboxes, `[[internal links]]`, citations bound to the revision that used them, Media
attachments and Community discussion — server-rendered and useful without JavaScript.

- **Entry:** `server/index.js`; app `server/app.js`; port `4800`, service id `wiki`.
- **API/pages:** `server/http/api.js` (`/api/v1`), `pages.js`, `machine.js`, `openapi.js`,
  `actor-limits.js`, `common.js`, `frame-groups.js`; rendering `server/render/` (`layout.js`,
  `views.js`, `blocks.js`, `short.js`); public CSS/JS in `public/`.
- **Wiki domain:** `server/wiki/` — `service.js`, `content.js`, `writer.js`, `access.js`,
  `images.js`, `review-kind.js`, `import.js`, `seed.js`, `vibe.js`, `account-data.js`.
- **Integrations:** `server/integrations/` — `platform.js` (Network/SSO), `image-fetch.js`,
  `projects-module.js`, `vip.js` (gated spaces/pages).
- **Docs:** `docs/threat-review.md`; seeds in `seeds/` and `scripts/seed.js`; `STATUS.json`.

## Owns, does not own

Owns the ten authority tables in `ov_wiki`: `wiki_spaces` (official/user, public/members/private),
`wiki_pages` (canonical identity, slug, tree via `parent_id`, publication state, published revision),
`wiki_page_revisions` (**immutable**; PL/pgSQL triggers refuse UPDATE/DELETE), plus the page
content/blocks, citations, discussion refs, media refs, review queue, shares, proposals and outbox.

Does not own: discussion (Community owns threads; Wiki stores only `wiki_discussion_refs` and
renders/posts through Community); attachments (Media owns bytes; Wiki stores `med_…` ids and their
last known state); source items (Sources; a citation stores the item id plus URL, title, retrieval
time and licence read from its provenance); the network index (Search; Wiki sends
`wiki.index_document.*`). It also does not own identity (Network), entitlements (VIP/Billing) or the
projects module (Services).

## Who calls it, what it calls

People use their Network JWT (Bearer, or the `ov_token` cookie; cross-site cookie writes are refused);
services use client-credentials tokens for audience `openvibe.wiki` with one capability per route, and
content writes need the person in `X-OV-Subject` (whose space role applies). SDK `openvibe-sdk/wiki`
is the read client; `openvibe-sdk/community` is used for discussion. Wiki calls Network (SSO, JWKS,
names), Community (threads), Media (upload/read), Sources (citation provenance), Search (index events
out), Events (outbox), AI (`wiki` proposals/drafts) and VIP (gated spaces/pages). AI proposals are
drafts: a person reviews and publishes them.

## Database and migrations

PostgreSQL `ov_wiki` through `openvibe-sdk/db` (PgBouncer for the app, direct owner role for
migrations); `migrations/0001..0009` cover spaces/pages/revisions, review kinds, shares, the outbox
rejection index and defaults. Applied at boot; never edit one that has run. Revision immutability is
enforced by database triggers, not only by code. Tests use PGlite or `WIKI_TEST_STORE=pg`; a migration
that a rollback cannot tolerate is not allowed.

## Auth and privacy

Network RS256 JWTs (offline JWKS) and SSO. A person's space role decides writes; services act for a
person only with `X-OV-Subject` and the capability. Visitors without SSO read public content only; a
members/private space is gated through VIP and the entitlement check. Cross-site cookie writes are
refused. AI generates proposals/drafts that need a person's approval before publication; every seed
page is currently `noindex` because no person has reviewed it, and none is in Search. Public pages are
cacheable; a signed-in page is `private, no-store`.

## Deploy

`sudo ovhost deploy wiki` (git-checkout: fast-forward `/opt/openvibe.wiki`, install on a lockfile
change, restart, wait for `/api/ready`; rollback `sudo ovhost rollback wiki --to <sha>`). Unit
`openvibe-wiki.service` on `127.0.0.1:4800`, env `/etc/openvibe/wiki.env`, database `ov_wiki`, nginx
`deploy/nginx/openvibe.wiki.conf`; the release migrates at boot.

## Commands and tests

```bash
npm ci
npm run dev                 # http://127.0.0.1:4800
npm test                    # every test/*.test.js, temp PGlite + stub upstreams
npm test -- revisions seo   # only matching files
npm run test:pg             # the same on PostgreSQL
npm run seed                # the official space's seed pages
```

`test/run.js` uses `openvibe-shared/test-runner` (60 s, serial): temporary PGlite, a generated RSA key
and stub upstreams, never the network. Coverage includes page trees/slugs, immutable revisions and
diff/revert, blocks/infoboxes/internal links, citations and the citation inspector, Media and
Community integration, access/VIP/delegation, AI proposals/review, discovery/SEO, account data and the
empty states.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; RFC 9457 problem+json, escaped HTML and a safe
  block renderer (user content never becomes raw markup).
- **A revision is immutable.** Publish a new revision; never UPDATE/DELETE a `wiki_page_revisions` row
  or bypass the trigger. Diff/revert and citations are computed from revisions.
- **Citations are provenance, not decoration:** store the Sources item id, URL, title, retrieval time
  and licence; a changed/removed source must be visible as such, never silently rewritten.
- **Discussion and bytes live elsewhere:** store the Community thread id / Media `med_` id, verify the
  access with the owning service, and never copy a thread or a file into Wiki.
- **Seed/AI text is unreviewed until a person approves it:** keep `noindex` and out of Search until
  reviewed; AI drafts are proposals, not publications.
- **Slug and tree changes are redirects:** a moved page keeps its canonical identity and leaves a
  redirect; `[[internal links]]` resolve through the canonical slug.
- **Search is downstream:** publish/update/remove through `wiki.index_document.*` in the transaction
  (or the outbox), never write Search's tables.
