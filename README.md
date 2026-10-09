# OpenVibe.Wiki

> Wiki spaces with page trees, revisions, citations, media and discussion — editable together, source-backed.

**Status:** alpha (roadmap Wave 16, Wiki half). **Public at https://openvibe.wiki since 2026-09-23**
(the launch release also removed the domain from [OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites)).
The only content is the official space's 10 AI-assisted seed pages; no person has reviewed them yet,
so every page is `noindex` and none is in Search.
**Domain:** `openvibe.wiki` · **Port:** 4800 · **Service id:** `wiki`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 — roadmap Wave 16, §15.13, §29, §32.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

The knowledge product of the network: spaces (official editorial spaces and user spaces), page
trees with canonical slugs, immutable revisions with diff and revert, manual editing by permitted
people, typed infoboxes, `[[internal links]]`, citations attached to the revision that used them,
Media attachments and Community discussion. AI proposes revisions; a person approves them; Wiki
publishes. Search indexes only published, public state.

It is the first full consumer of the shared publishing packages
([openvibe-publishing](https://github.com/OpenVibers/OpenVibe.Publishing) v0.2.1, ADR-019): revisions,
citations, redirects, the indexability gate, feeds, sitemaps, JSON-LD, authorship, scheduling,
media references, discussion references and the Search index hooks all come from there. Wiki owns
its publication state; the packages supply the mechanics.

## Owns

The ten authority tables of §15.13, in Wiki's own PostgreSQL database (`ov_wiki` on the host's data role, ADR-035; schema in [migrations/](migrations/)):

| Table | What | Mechanics |
|---|---|---|
| `wiki_spaces` | spaces: official / user, public / members / private | Wiki |
| `wiki_pages` | canonical page identity, slug, tree (`parent_id`), publication state, published revision | Wiki |
| `wiki_page_revisions` | immutable revisions (UPDATE/DELETE refused by PL/pgSQL triggers) | `openvibe-publishing/revisions`, prefix `wiki_page` |
| `wiki_page_links` | `[[links]]` of every revision (backlinks, red links) | Wiki |
| `wiki_page_redirects` | every historical path of a page or space (301; 410 when gone) | `openvibe-publishing/seo`, prefix `wiki_page` |
| `wiki_citations` | sources per (page, revision), append-only | `openvibe-publishing/citations`, prefix `wiki` |
| `wiki_infobox_values` | typed infobox values per (page, revision), append-only | Wiki |
| `wiki_permissions` | space roles: owner / editor / viewer | Wiki |
| `wiki_watchers` | who watches a page | Wiki |
| `wiki_ai_proposals` | AI-authored revisions awaiting a person's decision | Wiki + `openvibe-publishing/authorship` |

The packages add their helper tables under the same prefix (`wiki_page_drafts`, `wiki_page_reviews`,
`wiki_page_attachments`, `wiki_schedule_jobs`, `wiki_discussion_refs`, `wiki_index_revisions`, the
purge audit tables); the SDK outbox keeps `wiki_event_outbox`. Wiki's own `wiki_attachment_origins`
records who attached each Media object and what Media said about it at that moment.

## Does not own

- **Discussion** — OpenVibe.Community owns comment threads; Wiki stores only the thread id
  (`wiki_discussion_refs`) and renders or posts through Community's API.
- **Attachments** — OpenVibe.Media owns the bytes; Wiki stores Media object ids (`med_…`) and their
  last known state.
- **Source items** — OpenVibe.Sources owns them; a citation stores the item id plus the URL, title,
  retrieval time and license read from the item's provenance.
- **The network index** — OpenVibe.Search owns it; Wiki sends `wiki.index_document.*` events.
- **Publication truth by AI** — never. There are no AI provider calls in Wiki.
- **Identity** — OpenVibe.Network (subjects `usr_…`, SSO, service principals).

## What works

- **Spaces**: official (created by Network staff, or a service acting as itself) and user spaces
  (created by any signed-in person, who becomes owner). Visibility `public` (anyone), `members`
  (any signed-in OpenVibe account), `vip` (the space owner's OpenVibe.VIP members, see below), `private`
  (people with a role). Roles `owner` (settings, roles,
  delete, page visibility), `editor` (write, publish, revert, review proposals), `viewer` (read a
  private space). Staff act as owners of official spaces only; they get no silent access to user spaces.
- **VIP spaces and pages** (roadmap WS-K task 8, Contracts 0.64.0): a `vip` space or page is read by the
  space's roles and by the viewers OpenVibe.VIP admits as members of the space owner.
  - *Who decides:* Wiki asks `vip.resource.policy.evaluate` (`server/integrations/vip.js`). The resource
    is `wiki/page/<id>` when the page itself is VIP-only, else `wiki/space/<id>`, with the fallback
    `wiki:gated_page`, so a rule the owner sets in VIP wins.
  - *When it asks:* before rendering. Route params trigger `access.prepareVip`, answers are cached
    (a yes 30 s, a no 10 s), and the JSON export asks authoritatively.
  - *Who is refused:* others get a join prompt (403, never cached) linking to the owner's VIP plans.
    Every doubt refuses.
  - *Where it never shows:* search, sitemaps, feeds, and another viewer's lists.
  - *Official spaces* have no VIP owner and refuse `vip`.
  - Config: `OV_VIP_INTERNAL_URL`, `OV_VIP_URL`, and `WIKI_VIP_*` for the timeout and cache.
- **Pages**: a tree per space, canonical slugs, rename/move with history-aware 301s (chains
  collapse; renaming a space redirects all its pages), deletion answers 410 at every old address.
- **Revisions**: immutable, optimistic concurrency (`expected_revision` → 412 on conflict), word and
  line diffs, revert = a new revision copying the old text, infobox and citations. Readers see the
  published revision and its history; newer drafts and unapproved AI revisions are editor-only.
- **Editing without JavaScript**: plain HTML forms with preview, "save" and "save and publish",
  typed infobox rows (`Label | type | value`), citation rows, keep/drop per existing citation,
  conflict handling that keeps the typed text.
- **Infoboxes**: typed values (`text`, `number`, `date`, `url`, `boolean`, `page`, `media`),
  validated, never coerced silently.
- **Internal links**: `[[Title]]`, `[[Title|label]]`, `[[space:Title]]`; links follow redirects;
  missing (or unreadable) targets are red links — a link to the create form for editors, plain text
  for everyone else. "What links here" per page.
- **Citations**: OpenVibe.Sources items (url, title, `retrieved_at`, license from the item's
  provenance) or URLs with a required retrieval time; attached to one revision, carried forward
  explicitly, never edited; a published revision's sources are fixed. The citation inspector
  (`/w/:space/:slug/sources`, linked from the article's sources and every history row) shows one
  revision's sources in full — kind, retrieval time, license, quote, the revision that first cited
  each one, and what was kept, added, restored or dropped since the previous revision — under the
  article's read rules.
- **Media**: attachments by Media object id; a check against Media marks missing or deleted objects
  `broken` and the page shows an explicit "no longer available" placeholder instead of an image; an
  outage changes nothing (`check_failed`). A periodic check runs when Media is configured.
- **Media across authors and editors**: Media owns read rights (public and unlisted objects are
  readable by anyone, a private one only by its owner). A person attaches an object only if they can
  read it in Media — missing, deleted and other people's private objects get one answer
  (`media.not_readable`), so an id is never confirmed — and only public or unlisted objects are
  attached at all (every reader of a page sees its media; Wiki never re-shares a private object under
  its own authority). The attachment belongs to the page, with who attached it and the Media
  visibility checked then (`wiki_attachment_origins`); later editors revise, revert and publish
  without re-attaching and need no rights on it. When Media deletes an object or makes it private,
  the next check shows "deleted" or "no longer shared publicly" instead of the image, until Media
  shares it again. With Media unreachable or not configured nothing is attached (503). The model is
  documented at `attachMedia` in [server/wiki/service.js](server/wiki/service.js).
- **Discussion**: public, published pages get a Community thread (resolved once, stored as a
  reference); comments render server-side; signed-in people comment through a form (posted to
  Community as that person). Failures show an explicit "could not be loaded" state.
- **Watchers**: watch/unwatch; changes emit `wiki.watch.triggered` with the recipients who may still
  read the page (never the actor). No email.
- **Scheduling**: publish at a time (idempotent scheduling, lease-based worker, re-runs are no-ops).
- **AI proposals (seam for OpenVibe.AI)**: a service with `wiki.revision.propose` files a revision
  with `ai` authorship (workflow id + run id, stub-provider flag). It stays a pending proposal,
  hidden from readers and refused by publish, until a person with the editor role approves it
  (approval publishes it) or rejects it. Published AI text carries a disclosure at the item.
- **Discovery (§32)**: server-rendered pages with canonical URLs, robots from the gate, JSON-LD from
  real fields only (no invented author, image or date), breadcrumbs; `/sitemap.xml` (index) →
  `/sitemaps/spaces.xml`, `/sitemaps/pages-N.xml`; `/feed.atom` and `/feed.json` (recent changes; with nothing listable
  yet they are valid feeds with zero entries, never a 404);
  `/robots.txt`; `/llms.txt`; a JSON representation of every page at `<page>.json`.
- **IndexNow (openvibe-shared/indexnow)**: with `INDEXNOW_KEY` set, the key file is served at
  `/<key>.txt` as `text/plain`; publishing, updating (a new revision, a slug change, a space rename),
  unpublishing and deleting a public, indexable page pings `api.indexnow.org` with the page's
  canonical URL and `/sitemap.xml` (the module batches and debounces; a failed ping never takes a
  publish down). Drafts, private, members, VIP and noindex pages never ping. Unset: off — no key
  file, no requests. A key that is not 8–128 hex or alphanumeric is refused by the module: Wiki
  warns and runs with IndexNow off rather than failing to start.
- **The gate**: `openvibe-publishing/seo` decides indexing per page with explicit reasons
  (policy: at least `WIKI_GATE_MIN_WORDS` words and `WIKI_GATE_MIN_SOURCES` citations; AI text and
  AI-assisted imports only after a person's review; owner-requested noindex). Only public, published, indexable pages enter sitemaps and
  the Search index; members/private/deleted pages are tombstones and never appear in sitemaps,
  feeds or search, and are served `Cache-Control: private, no-store`.
- **Importing a space**: an owner imports a bundle of pages into their space —
  `POST /api/v1/spaces/:space/import` or the `/s/:space/import` form (paste the JSON; no
  JavaScript needed). The bundle is JSON in the seed file's page shape (`title`, Markdown `body`,
  `summary`, `parent` by title, `infobox`, `citations`, `visibility`), validated strictly first
  (unknown fields, duplicate slugs, parents, sizes: at most 200 pages, 2 MB, 200,000 characters per
  page) and imported in one transaction: one bad page imports nothing. Pages are created exactly like
  hand-made ones — drafts unless the bundle says `publish`, the same sanitising renderer, link and
  citation records, events and Search documents — with `imported` authorship naming the importer as
  the accountable person and where the text comes from; `ai_assisted: true` keeps every page noindex
  until a person reviews it. Existing slugs stop the import (409) unless `on_existing: "skip"`.
  Twenty imports per hour per address. Format: [server/wiki/import.js](server/wiki/import.js).
- **Seed**: `npm run seed` imports the official "OpenVibe" space (`seeds/openvibe.json`): ten pages
  about the network's repositories, summarised from their README/STATUS files at pinned commits,
  each cited with a GitHub permalink and retrieval time, authorship recorded as `imported` with
  `importedFrom.aiAssisted: true` ("summarised with AI assistance"). Idempotent. Being generated
  text, the pages are published and readable with that disclosure ("Not yet reviewed by a person")
  but the gate keeps them `noindex` (`ai_generated_unreviewed`) — out of sitemaps, feeds and Search —
  until a person reviews each one.
- **Reviewing revisions**: owners and editors (people) review an existing AI-assisted revision from
  the history view ("Reviewed — correct" / "Needs changes") or `POST /api/v1/pages/:id/revisions/:n/review`.
  The review goes into the append-only review log; for the published revision the gate is
  re-evaluated and a changed Search document goes out (with `wiki.page.updated`). Imported rows
  written before the flag existed are recognised by their "AI assistance" label, and at boot Wiki
  re-sends Search any document whose indexability changed (`reconcileIndex`, idempotent).

Not built yet: page-level talk moderation, media upload from Wiki (attach existing Media objects
only), consuming Media/Sources change events (Media does not emit deletion events yet; checks are
pull-based), per-space feeds, full-text ranking (Wiki's own `/api/v1/search` is a simple title/text
match; network search is OpenVibe.Search).

## Routes

Pages (SSR, useful without JavaScript): `/`, `/recent`, `/search?q=`, `/new-space`, `/s/:space`,
`/s/:space/new`, `/s/:space/settings`, `/s/:space/import`, `/s/:space/proposals`, `/w/:space/:slug` (`?rev=N`),
`/w/:space/:slug.json`, `/w/:space/:slug/history`, `/w/:space/:slug/sources` (`?rev=N`), `/w/:space/:slug/diff/:a/:b` (`?mode=line`),
`/w/:space/:slug/edit`, `/w/:space/:slug/revert?to=N`, `/w/:space/:slug/settings`,
`POST /w/:space/:slug/watch|discuss`. Sign-in: `/auth/login|callback|logout|me|refresh|fedcm`
(Network SSO, same session layer as OpenVibe.Community). Legal: `/terms`, `/privacy`, `/dmca`.
Operations: `GET /api/health`, `GET /api/ready` (db required; Network key, Events relay, Community,
Sources, Media optional → degraded), `GET /release.json`, `GET /metrics` (loopback only).

Caching: anonymous views of public published pages are `public, max-age=60`; signed-in views,
members/private pages, editing surfaces and errors are `private, no-store`. A page a visitor may
not read answers 404, so its existence does not leak.

Rate limits per address (besides nginx's): sign-in 60 per 15 min, API 300/min, form posts 120 per
10 min, `/search` 60/min, diffs 30/min, imports 20/hour. Outbound links in community spaces carry
`rel="nofollow ugc noopener"`. The threat review is [docs/threat-review.md](docs/threat-review.md).

### Per-actor limits

`/api/v1` and the editing forms also limit who calls them, once `req.actor` is resolved and before
any work (for a form, before its body is read): `server/http/actor-limits.js`, openvibe-sdk/limits,
roadmap WS-R task 4. Counted: a person as `user:usr_…` (their own token or cookie, or named by a
service in `X-OV-Subject`, or an app's `on_behalf_of`); a first-party service relaying a signed-out
visitor by the address it forwards; a service or app acting as itself (an AI workflow's proposals)
by its principal; a signed-out caller by address. A first-party service reading for itself is not
counted on reads. Past a limit: `429` problem+json `rate_limited` with `Retry-After`, one `[Limits]`
log line and `wiki_rate_limited_total{limit,window}`. A form and the API route that do the same thing
share one budget.

| Routes (API and form) | Per caller, a minute / an hour |
|---|---|
| API reads | `WIKI_LIMITS_MINUTE` / `WIKI_LIMITS_HOUR` (120 / 3000) |
| Space create (`POST /spaces`, `/new-space`) | 10 / 60 |
| Space settings and roles (`PATCH /spaces/:space`, `PUT …/roles/:subject`, `/s/:space/settings`) | 30 / 300 |
| Page create (`POST /spaces/:space/pages`, `/s/:space/new`) | 30 / 300 |
| Page edit and revert (`POST /pages/:id/revisions`, `/revert`, `/w/…/edit`, `/w/…/revert`) | 30 / 600 |
| Page move, visibility, delete (`PATCH`/`DELETE /pages/:id`, `/w/…/settings`) | 30 / 300 |
| Publish, schedule, unpublish, reviews (API and forms), proposal review | 30 / 300 |
| Citations attach | 30 / 300 |
| AI proposals (`POST /proposals`) | 60 / 1200 |
| Import (API and form) | 5 / 20 |
| Media attach and verify | 20 / 200 |
| Watch | 60 / 600 |
| Discussion comment (`/w/…/discuss`, sent to Community) | 20 / 300 |
| API search and diffs | 30 / 600 each |

Never limited per actor: `/api/health`, `/api/ready`, `/release.json`, `/metrics`, sign-in, and the
pages people read (the per-address limits above bound them). `test/actor-limits.test.js`; the other
tests boot with `rateLimits: false`, which turns off both kinds.

## API `/api/v1`

People use their Network user JWT (Bearer, or the `ov_token` cookie; cross-site cookie writes are
refused). Services use a Network client-credentials token for audience `openvibe.wiki`; every route
checks one capability, and content writes need the person in `X-OV-Subject` (whose space role
applies). Errors are RFC 9457 problem+json. The full route list is at the top of
[server/http/api.js](server/http/api.js).

| Capability | Routes |
|---|---|
| `wiki.space.create` | `POST /spaces`, `PATCH /spaces/:space`, `PUT /spaces/:space/roles/:subject` |
| `wiki.page.create` | `POST /spaces/:space/pages`, `POST /spaces/:space/import`, `POST /pages/:id/revisions`, `PATCH`/`DELETE /pages/:id`, `POST /pages/:id/media[/verify]` |
| `wiki.page.read` | `GET /pages/:id`, `/revisions`, `/revisions/:n`, `/diff`, `/revisions/:n/citations`, `GET /proposals/:id` |
| `wiki.revision.propose` | `POST /proposals` |
| `wiki.revision.publish` | `POST /pages/:id/publish`, `/schedule`, `/unpublish`, `POST /pages/:id/revisions/:n/review`, `POST /proposals/:id/review` |
| `wiki.revision.revert` | `POST /pages/:id/revert` |
| `wiki.citation.attach` | `POST /pages/:id/revisions/:n/citations` |
| `wiki.search.query` | `GET /search` |

The ids were proposed in [docs/capabilities-proposal/](docs/capabilities-proposal/) (the plan's
`wiki.search` becomes the three-segment `wiki.search.query`) and are released in openvibe-contracts,
which owns the wiki capability manifests, the service manifest and the `wiki.*` event payload schemas
(this repo pins v0.107.0) ([docs/service-manifest-proposal.json](docs/service-manifest-proposal.json)).
The proposal for `wiki.revision.publish` also lists the revision review route, which the released
capability names since v0.32.0 (as `wiki.page.create` does the space import route).

## Events

Through the SDK transactional outbox (`openvibe-sdk/events`, table `wiki_event_outbox`), in the same
transaction as the change; the relay publishes to OpenVibe.Events when `EVENTS_URL` is set.

- `wiki.space.updated` — created, settings, visibility, roles, renamed, deleted
- `wiki.revision.created` — every revision (internal: a revision is a draft until published)
- `wiki.page.published | updated | unpublished | deleted` — publication changes (public only for public, listable pages); `updated` also when a review changes what Search holds
- `wiki.watch.triggered` — recipients who may read the page
- `wiki.index_document.upserted | deleted` — `search.index-document@1` documents and tombstones for
  OpenVibe.Search, with a monotonic index revision (`createIndexSequencer`)

## Running it

```bash
fnm exec --using=22.22.1 npm install
cp .env.example .env
fnm exec --using=22.22.1 npm run seed     # the official "OpenVibe" space
fnm exec --using=22.22.1 npm run dev      # http://localhost:4800
fnm exec --using=22.22.1 npm test         # every test/*.test.js on PGlite (PostgreSQL in-process), no network
eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)" && npm run test:pg   # the same through PgBouncer
```

Without `DATABASE_URL`, development uses an embedded PGlite database in `data/pglite`.

Production: `/opt/openvibe.wiki`, env `/etc/openvibe/wiki.env`, unit
[deploy/systemd/openvibe-wiki.service](deploy/systemd/openvibe-wiki.service), database `ov_wiki`
(`DATABASE_URL` through PgBouncer; migrations on `DATABASE_DIRECT_URL`), nginx [deploy/nginx/openvibe.wiki.conf](deploy/nginx/openvibe.wiki.conf).

## Depends on

- PostgreSQL 18 and Valkey 9 (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through
  `openvibe-sdk/db`; Valkey holds the per-actor limit counters (optional: without `VALKEY_URL` they count per process).
- `openvibe-publishing` v1.3.0 (async PostgreSQL stores, ingest and publication chassis), `openvibe-contracts`
  v0.107.0, `openvibe-shared` v2.15.0
  (Frame, release, metrics, readiness, SEO helpers, legal pages), `openvibe-sdk` v0.37.0 (db, auth, PostgreSQL
  events outbox, per-actor limits, account export and deletion, testing) — pinned release tarballs.
- OpenVibe.Network (SSO, JWKS, service principal `wiki`), OpenVibe.Events, OpenVibe.Community,
  OpenVibe.Sources, OpenVibe.Media, OpenVibe.VIP (VIP spaces and pages), OpenVibe.Search (consumer of
  the index events). All but the Network key are optional at runtime and degrade to explicit failure
  states.
- OpenVibe.AI for proposals (not wired to Wiki yet: the proposal API is the seam).
- Account export and deletion (ADR-033): Network grants `events.subscription.manage` (openvibe.events) for the two
  subscriptions created at boot, then, last and once the release is live, `network.account.export.contribute` and
  `network.account.deletion.confirm` (openvibe.network).

### Account export and deletion (ADR-033)

`network.account.export_requested` and `network.account.deleted` arrive at `POST /internal/events`. The route is
loopback-only (nginx answers 404 for `/internal/`, and the handler refuses a forwarded request) and signed with
`WIKI_EVENTS_SECRET`. They are answered by `server/wiki/account-data.js` over `openvibe-sdk/account-data`, with one
receipt per export and deletion in `account_data_events`.

- **Export:** the person's spaces, pages, revisions, AI proposals, roles, watches, drafts and reviews.
- **Deleted:** a user space they own is deleted the way its owner would delete it (`deleteSpace` as the system actor:
  unpublished, out of Search and the sitemap, answering 410). Their roles, watches, drafts and wiki.projects state go
  too.
- **Authorless:** what they wrote in other spaces stays, with their id removed (`created_by`, `proposed_by` and
  `attached_by` become `deleted`). Revisions and citations are append-only, so only the erasure transaction may clear
  a revision's author (and their id in `meta.authorship.authors`) or a citation's `attached_by`
  (`wiki.account_erasure`, migration `0002_account_erasure.sql`); the text and sources never change.
- **Kept:** page reviews, since a person's approval is what lets reviewed text stay published.

## Capabilities

Implemented here (the service manifest's `capabilities`, audience `openvibe.wiki`, one per route;
routes under [API](#api-apiv1)): `wiki.space.create`, `wiki.page.create`, `wiki.page.read`,
`wiki.revision.propose`, `wiki.revision.publish`, `wiki.revision.revert`, `wiki.citation.attach` and
`wiki.search.query`.

Called elsewhere, as the service principal `svc:wiki` (client credentials, one token per audience;
[server/integrations/platform.js](server/integrations/platform.js)):

| Service | Grant | Why |
|---|---|---|
| OpenVibe.Events | `events.event.publish` | the outbox relay |
| OpenVibe.Community | `community.comment.write`, `community.comment.moderate` | comment threads by reference; hiding the thread of a page that stops being public |
| OpenVibe.Sources | `sources.item.read` | citations that name a Sources item |
| OpenVibe.Media | `media.object.read` (namespace `WIKI_MEDIA_APP`) | attached objects and their re-verification |
| OpenVibe.VIP | `vip.resource.policy.evaluate` | who may read a `vip` space or page |

## Acceptance (tested in `test/`)

- create → edit → publish → revise → diff → revert keeps an immutable lineage (`revisions.test.js`)
- citations and infobox values stay attached to the exact revision that used them (`revisions.test.js`);
  the citation inspector shows them per revision without JavaScript and leaks nothing the article
  would not show (`citation-inspector.test.js`)
- scheduled publication is idempotent across worker restarts (`schedule.test.js`)
- a private, members-only or deleted page leaves sitemaps, feeds and the Search index (tombstone)
  and is served `Cache-Control: private`; renames 301, deletions 410 (`visibility.test.js`)
- `/feed.atom` is a valid Atom feed with zero entries while nothing is listable (`feeds.test.js`)
- a public page is useful with JavaScript disabled, and so is editing (`nojs.test.js`)
- a deleted or missing Media object renders an explicit broken-asset state (`integrations.test.js`)
- Media permissions survive the author/editor handoff: an editor keeps the author's attachments,
  cannot attach an object only the author can read, and an object Media deletes or makes private is
  shown as broken or withheld on the public page (`media-handoff.test.js`)
- permissions are enforced; visitors without SSO read public content only; AI proposals need a
  person's approval (`permissions.test.js`)
- only owners import into a space; invalid, oversized and colliding bundles are refused and any
  failure imports nothing (`import.test.js`)
- every event is a valid `events.event-envelope@1` and every index document a valid
  `search.index-document@1` (`visibility.test.js`); the proposals validate against the contracts
  schemas (`proposals.test.js`); user text is escaped everywhere (`content.test.js`)
- IndexNow: off without `INDEXNOW_KEY` (no key route, nothing sent); with one the key file is served
  at `/<key>.txt` as `text/plain` and a publish, unpublish or delete of an indexable page pings the
  page path and the sitemap; a draft, a noindex page and a page the gate will not index never ping
  (`indexnow.test.js`)

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). The written threat review, with code
references and the gaps that remain: [docs/threat-review.md](docs/threat-review.md).

- **Auth.** People use a Network JWT (Bearer or the `ov_token` cookie; cross-site cookie writes are
  refused); services use client-credentials tokens for audience `openvibe.wiki`, one capability per
  route, and content writes need the person in `X-OV-Subject`, whose space role applies. Visitors
  without SSO read public content only; AI proposals need a person's approval.
- **Private data.** Private, members-only, VIP and deleted pages leave sitemaps, feeds and Search
  (tombstones) and are served `Cache-Control: private`; a VIP refusal is never cached; Media objects
  the reader may not see are withheld. User text is escaped everywhere.
- **Egress.** Wiki calls only its configured Network, Events, Community, Sources, Media and VIP hosts;
  it never fetches a URL a user chose.
- **Secrets.** `OV_OAUTH_CLIENT_SECRET` lives in `/etc/openvibe/wiki.env` (0600). nginx answers
  `/metrics` with 404 and caps import bodies.

## Deploy

Production deploys with `sudo ovhost deploy wiki` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.wiki`, install on a lockfile change, restart, wait for `/api/ready`).
The unit is `openvibe-wiki.service` on `127.0.0.1:4800`, the env file `/etc/openvibe/wiki.env`. The database is
`ov_wiki` on the host's data role (`sudo /opt/openvibe.host/roles/data/add-service.sh wiki` writes its settings);
the release migrates it at boot. nginx serves `openvibe.wiki` from
[deploy/nginx/openvibe.wiki.conf](deploy/nginx/openvibe.wiki.conf).
Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback wiki --to <sha>`. Nothing blocks a rollback: the schema
code only adds tables and columns.

## Launch rule

This repository does not make the product real on its own. `openvibe.wiki` kept its placeholder
page on [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until the following
held (plan §12.12); the launch release went out on 2026-09-23:

1. an owning runtime with health/readiness endpoints and observability — **built** (`/api/health`, `/api/ready`, `/metrics`);
2. canonical identity/auth integration (Network subjects, a scoped service principal) — **built**; principal `wiki` and its grants are provisioned in production;
3. server-rendered public routes useful without JavaScript — **built**;
4. real persistence and end-to-end workflows — **built** and deployed; `ovhost drill wiki` restored it on the production host on 2026-09-23;
5. capability and event registration against OpenVibe.Contracts — **released** (capabilities and service manifest in v0.17.0; the `wiki.*` event payload schemas are in the pinned release and every event this service emits validates against them, `test/event-contracts.test.js`);
6. a migration/seed strategy, a security/threat review, sitemap/robots/feed behaviour — seed and discovery **built**; the written threat review is [docs/threat-review.md](docs/threat-review.md) (2026-09-23: mitigations with code references, the gaps fixed in that pass with tests in `test/threat-review.test.js`, and the gaps that remain with their owners);
7. acceptance tests proving the advertised functionality — **built** (`npm test`).

The launch release removed `openvibe.wiki` from `OpenVibe.Sites/sites.json`, switched routing to this
service and opened its Network hub entry in the same release. A placeholder is never counted as an
implemented service. Still open: a person's review of the 10 seed pages (until then they stay
`noindex`).

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.35.0
- openvibe-shared: v2.15.0
- openvibe-publishing: v1.3.0
<!-- versions:end -->
