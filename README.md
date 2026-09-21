# OpenVibe.Wiki

> Wiki spaces with page trees, revisions, citations, media and discussion — editable together, source-backed.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.wiki`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.5 and §12.15.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

The knowledge product: spaces, canonical page identities/slugs, immutable revisions, redirects, citations and infoboxes. AI proposes revisions through registered workflows; humans publish. Community owns talk pages; Media owns attachments; Search indexes only published state.

## Owns

- `wiki_spaces`, `wiki_pages`, `wiki_page_revisions`, `wiki_page_links`, `wiki_page_redirects`, `wiki_citations`, `wiki_infobox_values`, `wiki_permissions`, `wiki_watchers`, `wiki_ai_proposals`

## Does not own

- discussion (Community)
- attachments (Media)
- publication truth by AI (never)

## Planned surfaces

- create/import a space, page tree navigation, edit/preview/publish/revert, history/diff, citation inspector, backlinks/link validation, AI research proposals with review state

## Data (authority tables / families)

- see above

## Capabilities and events

- `wiki.space.create`, `wiki.page.create|read`, `wiki.revision.propose|publish|revert`, `wiki.citation.attach`, `wiki.search`

Events: ``wiki.space.updated``, ``wiki.revision.created``, ``wiki.page.published|updated|deleted``

## Depends on

- shared publishing packages (`@openvibe/publishing-*`)
- OpenVibe.Network
- OpenVibe.Media
- OpenVibe.Community
- OpenVibe.AI + source registry
- Search
- OpenVibe.Events

## Acceptance (must be true before "done")

- create → edit → publish → revise → diff → revert keeps an immutable lineage
- citations stay attached to the exact revision that used them
- a private/deleted page leaves search, sitemaps and caches consistently
- a public page is useful with JavaScript disabled

## Bootstrap / extraction source

No current implementation; bootstraps from the shared publishing runtime. First full publishing consumer alongside Blog (Wave 14).

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
