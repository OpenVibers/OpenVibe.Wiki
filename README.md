# OpenVibe.Wiki

> Wiki spaces with page trees, revisions, citations, media and discussion — editable together, source-backed.

**Status:** alpha (roadmap Wave 16, Wiki half). Runs and is tested; **not deployed**. The domain
`openvibe.wiki` keeps its placeholder page on [OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites)
until the launch rule below holds.
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
([openvibe-publishing](https://github.com/OpenVibers/OpenVibe.Publishing) v0.2.0, ADR-019): revisions,
citations, redirects, the indexability gate, feeds, sitemaps, JSON-LD, authorship, scheduling,
media references, discussion references and the Search index hooks all come from there. Wiki owns
its publication state; the packages supply the mechanics.

## Owns

The ten authority tables of §15.13, in Wiki's own SQLite database (`WIKI_DB_PATH`):

| Table | What | Mechanics |
|---|---|---|
| `wiki_spaces` | spaces: official / user, public / members / private | Wiki |
| `wiki_pages` | canonical page identity, slug, tree (`parent_id`), publication state, published revision | Wiki |
| `wiki_page_revisions` | immutable revisions (UPDATE/DELETE abort in SQLite triggers) | `openvibe-publishing/revisions`, prefix `wiki_page` |
| `wiki_page_links` | `[[links]]` of every revision (backlinks, red links) | Wiki |
| `wiki_page_redirects` | every historical path of a page or space (301; 410 when gone) | `openvibe-publishing/seo`, prefix `wiki_page` |
| `wiki_citations` | sources per (page, revision), append-only | `openvibe-publishing/citations`, prefix `wiki` |
| `wiki_infobox_values` | typed infobox values per (page, revision), append-only | Wiki |
| `wiki_permissions` | space roles: owner / editor / viewer | Wiki |
| `wiki_watchers` | who watches a page | Wiki |
| `wiki_ai_proposals` | AI-authored revisions awaiting a person's decision | Wiki + `openvibe-publishing/authorship` |

The packages add their helper tables under the same prefix (`wiki_page_drafts`, `wiki_page_reviews`,
`wiki_page_attachments`, `wiki_schedule_jobs`, `wiki_discussion_refs`, `wiki_index_revisions`, the
purge audit tables); the SDK outbox keeps `wiki_event_outbox`.

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
  (any signed-in OpenVibe account), `private` (people with a role). Roles `owner` (settings, roles,
  delete, page visibility), `editor` (write, publish, revert, review proposals), `viewer` (read a
  private space). Staff act as owners of official spaces only; they get no silent access to user spaces.
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
  explicitly, never edited; a published revision's sources are fixed.
- **Media**: attachments by Media object id; a check against Media marks missing or deleted objects
  `broken` and the page shows an explicit "no longer available" placeholder instead of an image; an
  outage changes nothing (`check_failed`). A periodic check runs when Media is configured.
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
  `/sitemaps/spaces.xml`, `/sitemaps/pages-N.xml`; `/feed.atom` and `/feed.json` (recent changes);
  `/robots.txt`; `/llms.txt`; a JSON representation of every page at `<page>.json`.
- **The gate**: `openvibe-publishing/seo` decides indexing per page with explicit reasons
  (policy: at least `WIKI_GATE_MIN_WORDS` words and `WIKI_GATE_MIN_SOURCES` citations; AI text only
  after review; owner-requested noindex). Only public, published, indexable pages enter sitemaps and
  the Search index; members/private/deleted pages are tombstones and never appear in sitemaps,
  feeds or search, and are served `Cache-Control: private, no-store`.
- **Seed**: `npm run seed` imports the official "OpenVibe" space (`seeds/openvibe.json`): ten pages
  about the network's repositories, summarised from their README/STATUS files at pinned commits,
  each cited with a GitHub permalink and retrieval time, authorship recorded as `imported`
  ("summarised with AI assistance"). Idempotent.

Not built yet: page-level talk moderation, media upload from Wiki (attach existing Media objects
only), consuming Media/Sources change events (Media does not emit deletion events yet; checks are
pull-based), per-space feeds, full-text ranking (Wiki's own `/api/v1/search` is a simple title/text
match; network search is OpenVibe.Search).

## Routes

Pages (SSR, useful without JavaScript): `/`, `/recent`, `/search?q=`, `/new-space`, `/s/:space`,
`/s/:space/new`, `/s/:space/settings`, `/s/:space/proposals`, `/w/:space/:slug` (`?rev=N`),
`/w/:space/:slug.json`, `/w/:space/:slug/history`, `/w/:space/:slug/diff/:a/:b` (`?mode=line`),
`/w/:space/:slug/edit`, `/w/:space/:slug/revert?to=N`, `/w/:space/:slug/settings`,
`POST /w/:space/:slug/watch|discuss`. Sign-in: `/auth/login|callback|logout|me|refresh|fedcm`
(Network SSO, same session layer as OpenVibe.Community). Legal: `/terms`, `/privacy`, `/dmca`.
Operations: `GET /api/health`, `GET /api/ready` (db required; Network key, Events relay, Community,
Sources, Media optional → degraded), `GET /release.json`, `GET /metrics` (loopback only).

Caching: anonymous views of public published pages are `public, max-age=60`; signed-in views,
members/private pages, editing surfaces and errors are `private, no-store`. A page a visitor may
not read answers 404, so its existence does not leak.

## API `/api/v1`

People use their Network user JWT (Bearer, or the `ov_token` cookie; cross-site cookie writes are
refused). Services use a Network client-credentials token for audience `openvibe.wiki`; every route
checks one capability, and content writes need the person in `X-OV-Subject` (whose space role
applies). Errors are RFC 9457 problem+json. The full route list is at the top of
[server/http/api.js](server/http/api.js).

| Capability (proposed) | Routes |
|---|---|
| `wiki.space.create` | `POST /spaces`, `PATCH /spaces/:space`, `PUT /spaces/:space/roles/:subject` |
| `wiki.page.create` | `POST /spaces/:space/pages`, `POST /pages/:id/revisions`, `PATCH`/`DELETE /pages/:id`, `POST /pages/:id/media[/verify]` |
| `wiki.page.read` | `GET /pages/:id`, `/revisions`, `/revisions/:n`, `/diff`, `/revisions/:n/citations`, `GET /proposals/:id` |
| `wiki.revision.propose` | `POST /proposals` |
| `wiki.revision.publish` | `POST /pages/:id/publish`, `/schedule`, `/unpublish`, `POST /proposals/:id/review` |
| `wiki.revision.revert` | `POST /pages/:id/revert` |
| `wiki.citation.attach` | `POST /pages/:id/revisions/:n/citations` |
| `wiki.search.query` | `GET /search` |

The ids are proposed in [docs/capabilities-proposal/](docs/capabilities-proposal/) (the plan's
`wiki.search` becomes the three-segment `wiki.search.query`), with the service manifest in
[docs/service-manifest-proposal.json](docs/service-manifest-proposal.json). Until a contracts
release defines them, [server/auth/capabilities.js](server/auth/capabilities.js) decides grants with
the contracts library's own matching rule.

## Events

Through the SDK transactional outbox (`openvibe-sdk/events`, table `wiki_event_outbox`), in the same
transaction as the change; the relay publishes to OpenVibe.Events when `EVENTS_URL` is set.

- `wiki.space.updated` — created, settings, visibility, roles, renamed, deleted
- `wiki.revision.created` — every revision (internal: a revision is a draft until published)
- `wiki.page.published | updated | unpublished | deleted` — publication changes (public only for public, listable pages)
- `wiki.watch.triggered` — recipients who may read the page
- `wiki.index_document.upserted | deleted` — `search.index-document@1` documents and tombstones for
  OpenVibe.Search, with a monotonic index revision (`createIndexSequencer`)

## Running it

```bash
fnm exec --using=22.22.1 npm install
cp .env.example .env
fnm exec --using=22.22.1 npm run seed     # the official "OpenVibe" space
fnm exec --using=22.22.1 npm run dev      # http://localhost:4800
fnm exec --using=22.22.1 npm test         # every test/*.test.js on temp databases, no network
```

Production (planned): `/opt/openvibe.wiki`, env `/etc/openvibe/wiki.env`, unit
[deploy/systemd/openvibe-wiki.service](deploy/systemd/openvibe-wiki.service), database
`/var/lib/openvibe-wiki/wiki.db`, nginx [deploy/nginx/openvibe.wiki.conf](deploy/nginx/openvibe.wiki.conf).

## Depends on

- `openvibe-publishing` v0.2.0, `openvibe-contracts` v0.13.0, `openvibe-shared` v1.3.0 (chrome,
  release, metrics, readiness, SEO helpers, legal pages), `openvibe-sdk` v0.2.2 (auth, events
  outbox) — pinned release tarballs.
- OpenVibe.Network (SSO, JWKS, service principal `wiki`), OpenVibe.Events, OpenVibe.Community,
  OpenVibe.Sources, OpenVibe.Media, OpenVibe.Search (consumer of the index events). All but the
  Network key are optional at runtime and degrade to explicit failure states.
- OpenVibe.AI for proposals (not built yet: the proposal API is the seam).

## Acceptance (tested in `test/`)

- create → edit → publish → revise → diff → revert keeps an immutable lineage (`revisions.test.js`)
- citations and infobox values stay attached to the exact revision that used them (`revisions.test.js`)
- scheduled publication is idempotent across worker restarts (`schedule.test.js`)
- a private, members-only or deleted page leaves sitemaps, feeds and the Search index (tombstone)
  and is served `Cache-Control: private`; renames 301, deletions 410 (`visibility.test.js`)
- a public page is useful with JavaScript disabled, and so is editing (`nojs.test.js`)
- a deleted or missing Media object renders an explicit broken-asset state (`integrations.test.js`)
- permissions are enforced; visitors without SSO read public content only; AI proposals need a
  person's approval (`permissions.test.js`)
- every event is a valid `events.event-envelope@1` and every index document a valid
  `search.index-document@1` (`visibility.test.js`); the proposals validate against the contracts
  schemas (`proposals.test.js`); user text is escaped everywhere (`content.test.js`)

## Launch rule

This repository does not make the product real on its own. `openvibe.wiki` keeps its placeholder
page on [OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following hold (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability — **built** (`/api/health`, `/api/ready`, `/metrics`);
2. canonical identity/auth integration (Network subjects, a scoped service principal) — **built**, principal and grants not provisioned yet;
3. server-rendered public routes useful without JavaScript — **built**;
4. real persistence and end-to-end workflows — **built**, not deployed;
5. capability and event registration against OpenVibe.Contracts — **proposed** in `docs/`, not released;
6. a migration/seed strategy, a security/threat review, sitemap/robots/feed behaviour — seed and discovery **built**; the security review is the lead's;
7. acceptance tests proving the advertised functionality — **built** (`npm test`).

The launch release removes `openvibe.wiki` from `OpenVibe.Sites/sites.json`, switches routing to this
service and registers its maturity in the ecosystem registry **in the same release it goes live**.
A placeholder is never counted as an implemented service, and this README does not call the
product live until that release has happened.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
