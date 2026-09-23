# OpenVibe.Wiki — threat review

Written 2026-09-23 for launch rule point 6 (plan §12.12). It covers the service as it is in this
repository at the commit that adds this file. Every mitigation below was checked by reading the
code (references are `file:line` at that commit) and, where noted, by a small experiment; a claim
that could not be checked from the repository says so. Section 15 lists what this pass fixed (each
with a test), section 16 what remains and why.

## 1. What is being protected

- **Private and members-only content**: pages, revisions, citations, attachments and discussion of
  `private` spaces/pages (people with a role) and `members` ones (any signed-in account); drafts,
  newer unpublished revisions and pending AI proposals, which only editors may see.
- **Integrity of published text**: nobody but a space's owners/editors (and staff in official
  spaces) changes it, every change stays in the history, and generated text is labelled.
- **Readers**: no script injection, no dangerous links, no content that pretends to be reviewed.
- **The service and its neighbours**: CPU/memory of this process, and the services it calls with
  its own authority (Media, Sources, Community, Events, Network).

Trust boundaries: browsers (anonymous or with the Network user JWT in `ov_token`), service
principals with a Network client-credentials token (first-party `svc:…`, third-party `app:…` /
`mod:…`), and the upstream services. nginx and Cloudflare sit in front
([deploy/nginx/openvibe.wiki.conf](../deploy/nginx/openvibe.wiki.conf)).

## 2. Markdown rendering (XSS, raw HTML, sanitiser)

Mitigations present:

- Markdown goes through `openvibe-publishing/ssr` `renderMarkdown` (v0.2.1), called from
  `server/wiki/content.js:87`. Its model (`node_modules/openvibe-publishing/lib/ssr.js:12-15`):
  the source is escaped before any tag is written, only the renderer's own tags are produced, no
  raw HTML, no images, no tables. Input is capped at 200,000 characters (`ssr.js:49`), and pages
  are refused above the same size (`server/wiki/service.js:218`, 413).
- `[[internal links]]` are replaced by placeholder tokens before Markdown and substituted after
  it; label, title and href are escaped (`server/wiki/content.js:73-89`).
- Every other interpolated value in a page goes through the `html` tagged template, which escapes
  unless a value is explicitly `raw()` (`server/render/views.js:3-4`); `raw()` is used only for
  output of the renderer, `figureHtml` (which escapes itself) and the views' own fragments.
- JSON-LD and the inline page config cannot be broken out of: `openvibe-shared/seo` escapes
  `</script`, and `server/render/layout.js:91` replaces `<` with `\u003c`.
- Tests: `test/content.test.js` (titles, labels, infobox values, citations, summaries, JSON-LD) and
  the escaping assertions in `test/integrations.test.js` (Community comments) and
  `test/import.test.js` (imported Markdown).
- Experiment (this review): `<img src=x onerror=…>`, `<script>`, `[a](JaVaScRiPt:…)`,
  `[a](&#106;avascript:…)`, `[a](data:text/html,…)`, `[a](vbscript:…)`, `[a](//evil.example)`,
  `[a](/\evil.example)` and `[a](https://ok.example/"onmouseover="x)` all render as inert text or
  as an attribute-escaped `https:` link.

Gaps:

- **CSP is not a second line of defence** (remains): `script-src` allows `'unsafe-inline'`
  (`server/app.js:41`) because the page shell has an inline bootstrap script
  (`server/render/layout.js:90-96`) and the shared chrome adds its own. `ov_token` is readable by
  JavaScript (`server/auth/session.js:71`, the shared navbar reads it), so any future escaping bug
  would expose the session token. Moving to nonces needs a change in `openvibe-shared` (its inline
  scripts) and the navbar's token handling (OpenVibe.Network); it is not a Wiki-only change.
- Harmless quirk, noted for completeness: typing the renderer's internal placeholder
  (`\u0001WL<n>\u0001`, a control character) repeats one of the page's own already-escaped
  `[[links]]`; it cannot produce markup.

## 3. Links

Mitigations present:

- Markdown links keep only `http(s)://`, `mailto:`, same-site paths (not `//` or `/\`) and
  `#fragments` (`ssr.js:58`, checked at `ssr.js:160` after entity decoding).
- Citation URLs must be absolute `http(s)` (`node_modules/openvibe-publishing/lib/citations.js:44-49`;
  refused with 422, verified by experiment); infobox `url` values likewise
  (`server/wiki/content.js:146-150`, `test/content.test.js`). Media is referenced by object id
  only, never by URL (`server/wiki/service.js:1063-1070`, `test/integrations.test.js`).
- Internal links: `[[…]]` targets are resolved through the reader's own rights; a page the reader
  cannot read looks missing (a red link, plain text for readers who cannot create it) so links do
  not reveal private pages (`server/wiki/service.js:903-916`). Links are recorded per revision for
  "what links here", which also filters by the reader's rights.
- `rel`: outbound links in community spaces now carry `nofollow ugc noopener` everywhere (fixed in
  this pass, §15); official spaces keep `noopener` (staff vouch for them) and `noopener nofollow`
  on citations and infobox URLs (`server/wiki/service.js:923-927`, `server/render/views.js:18`).
- Open redirects: `/auth/login`, `/auth/callback` and `/auth/logout` accept `next` only as a
  same-site path (not `//` or `/\`) or an `https:` URL on openvibe.wiki / openvibe.network
  (`server/auth/session.js:26-36`). Experiment: `/\t/evil.com` passes the check but Express
  percent-encodes the tab in `Location`, so browsers treat it as a path. Page redirects come only
  from the redirect store (history of this wiki's own paths, `server/http/pages.js:67-80`).

Gaps:

- Same-site paths are allowed in user Markdown, so a page can link to `/auth/logout`, which signs
  the clicker out (a GET). Low impact (remains; see CSRF).

## 4. Media attachments and uploads

- Wiki has **no upload**: it attaches existing OpenVibe.Media objects by id (`med_…` or
  `legacy:…`, `node_modules/openvibe-publishing/lib/media.js` `MEDIA_ID_RE`). Images are served by
  Media at `https://openvibe.media/o/<id>` (`server/integrations/platform.js:141`).
- Read rights are Media's, applied at attach time for the attaching person
  (`server/wiki/service.js:1037-1087`, the model; `test/media-handoff.test.js`): the object must be
  public, unlisted or the person's own; missing, deleted and other people's private objects get one
  answer (`media.not_readable`); private objects are never attached (every reader of a page sees
  them); a Media outage attaches nothing (503). Who attached what, and the visibility checked, is
  kept in `wiki_attachment_origins` (immutable rows, `server/db.js:136-149`).
- Afterwards Media stays the authority: the check (on demand and every 6 hours when Media is
  configured, `server/index.js:43-45`) marks deleted/missing objects broken and objects made
  private withheld (`server/integrations/platform.js:147-172`); broken attachments render an
  explicit placeholder, never an `<img>` (`server/render/views.js:105-114`).
- Infobox `media` values are only displayed as text (`server/render/views.js`, `infoboxHtml`),
  never fetched or rendered as images.

Gaps (remain):

- Between Media deleting or hiding an object and Wiki's next check (up to 6 h, or an editor's
  "check attachments"), the page still points `<img>` at it. Media serves nothing for a deleted or
  private object, so no bytes leak, but the page shows a broken image instead of the placeholder.
  Closing this needs Media to emit deletion/visibility events (OpenVibe.Media) and Wiki to consume
  them.
- Wiki only reads its own Media namespace (`WIKI_MEDIA_APP`, `server/config.js:57`); an object
  uploaded under another app's namespace is "not readable" here. This is a scope limit, not a leak.

## 5. Permissions

- **One place decides** (`server/wiki/access.js`): space visibility public/members/private, a page
  can only narrow its space's (`access.js:22-26`); roles owner/editor/viewer (`access.js:32-41`);
  staff act as owners of official spaces only, never silently in user spaces (`access.js:36`).
  Reads: `canReadPage` (`access.js:63-68`) — drafts need edit rights. Unreadable things answer
  404, not 403 (`server/http/pages.js:78`, `server/http/api.js:109-113`), so existence does not
  leak.
- **Revisions**: readers see the published revision and older ones, never newer drafts or an AI
  proposal nobody approved (`server/wiki/service.js:460-465`); history, diff, the JSON view and the
  citation inspector all go through it.
- **Official spaces** are created only by staff, this service, or a first-party service acting as
  itself (`server/wiki/service.js:496-498`, `test/delegation.test.js`). Retired space slugs cannot
  be claimed by another space (`server/wiki/service.js:234-237`, `test/security.test.js`).
- **Identity**: user JWTs are verified offline (RS256, issuer, audience; `server/auth/viewer.js:79`);
  a bad Bearer token is 401, an expired cookie is anonymous (`viewer.js:100-107`). Pages ignore
  service tokens entirely (`viewer.js:100`).
- **Service tokens**: verified for audience `openvibe.wiki` (`viewer.js:47`); every API route checks
  one capability (`server/http/common.js:28-37`, `server/auth/capabilities.js:26`); content writes
  need a person, whose space role then applies.
- **Delegation**: developer apps and modules (`app:…`, `mod:…`) act only for their `on_behalf_of`
  person; naming anyone else in `X-OV-Subject` is 403, sandbox tokens 401 (`viewer.js:53-67`,
  `test/delegation.test.js`). First-party `svc:…` principals may name any person — they are trusted
  by construction (the Network grants them).
- **AI proposals** need no person and may target any space, so they are now limited to first-party
  services (fixed in this pass, §15, `server/wiki/service.js:1192-1195`); publishing one needs a
  person's approval (`server/wiki/service.js:445-446`, `test/proposals.test.js`).

Gaps (remain): every `wiki.*` capability is declared `first-party`
(`docs/capabilities-proposal/`), but Wiki does not itself refuse a first-party capability held by an
`app:`/`mod:` token (the delegation test relies on apps using `wiki.page.create` for their person).
That boundary is the Network's grant policy; the proposal route is now guarded locally, the rest
stays with the Network.

## 6. Spam

Mitigations present: community spaces' outbound links are `nofollow ugc` (fixed in this pass), so
link spam earns no ranking; only a space's own editors write in it (a wiki space is not openly
editable), so spam lands only in spaces the spammer owns; the indexability gate keeps thin or
unsourced pages out of sitemaps/Search (`WIKI_GATE_MIN_WORDS`, `WIKI_GATE_MIN_SOURCES`,
`server/config.js:65-70`); rate limits per address — form posts 120 per 10 min
(`server/app.js:92`), API 300/min (`server/app.js:82`), imports 20/hour (`server/app.js:78`), nginx
30 POST/min and 10 API requests/s (`deploy/nginx/openvibe.wiki.conf:14-18`).

Gaps (remain, product decisions): no per-account quota on spaces or pages, no bot challenge on
space creation, no report/takedown flow for spaces (the gate has a `takedown` reason but nothing
sets it), and a new user space's human-written pages are indexable as soon as they pass the gate.
Options: noindex user spaces until the owner's account is trusted (needs a trust signal from the
Network), per-account quotas, Turnstile on `/new-space`, a staff takedown that sets the gate reason.

## 7. Revisions and vandalism

- Revisions, citations, infobox values and link rows are immutable in SQLite triggers
  (`node_modules/openvibe-publishing/lib/internal.js:97-104`, `server/db.js:91-97` and `:148-149` for Wiki's tables);
  revert is a new revision (`server/wiki/service.js:708`); edits need `expected_revision` and
  conflict with 412 (`server/wiki/service.js:683`, `test/revisions.test.js`).
- Who may vandalise is small by design: editors appointed by the space owner, staff in official
  spaces. Watchers get `wiki.watch.triggered` (`server/wiki/service.js:281-293`).
- Review and indexing: AI-authored revisions are held as proposals until a person approves them;
  AI-assisted imports (the seed, `ai_assisted` bundles) are published with a disclosure but stay
  noindex until a person reviews them (`server/wiki/service.js:47-66`, `test/review.test.js`).
  Owners can set noindex per page. Every AI or imported revision is labelled at the item.
- Rate limits: see §6.

Gaps (remain): no per-person edit throttle (limits are per address); no "patrolled" state for
human edits (not needed while only appointed editors write).

## 8. CSRF

- Session cookies are `SameSite=Lax` (`server/auth/session.js:71-74`), so cross-site POSTs carry no
  session. Form posts with a foreign `Origin` are refused (`server/http/pages.js:44-50`,
  `test/nojs.test.js`, `test/import.test.js`); cookie-authenticated API writes likewise
  (`server/http/api.js:93-99`); Bearer callers are not ambient credentials. OAuth `state` is
  checked in constant time (`session.js:134`), the FedCM nonce too (`session.js:149`).

Gaps (remain, low): the page check also accepts `Origin: null` (`pages.js:48`) — SameSite=Lax is
what actually protects those posts; `/auth/logout` is a GET, so a link or image can sign a person
out. Both are nuisance-level; tightening them touches the shared session layer copied from
OpenVibe.Community, so they should change together.

## 9. SSRF

Wiki never fetches a user-supplied URL: citation URLs are stored and linked, not retrieved; Media
and Sources are called only at configured internal base URLs with ids that are validated
(`itm_<ULID>`, `server/integrations/platform.js:127`; Media ids, `service.js:1070`) and
percent-encoded (`platform.js:129`, `platform.js:149`); Community thread ids come from Community
itself. Every call has a 5-second timeout (`platform.js:51-62`). No gap found.

## 10. Caching

- Anonymous views of public, published pages are `public, max-age=60`; everything else (signed in,
  members/private, drafts, editing, errors) is `private, no-store` with `Vary: Cookie,
  Authorization` (`server/http/pages.js:52-55`, `test/visibility.test.js`). nginx never caches
  (`deploy/nginx/openvibe.wiki.conf:81-82`). Feeds and sitemaps are `public, max-age=300` and
  identical for everyone (`server/http/machine.js`).

Gap (remains): a page that becomes private can still be served from a cache for up to 60 s (5 min
for feeds and sitemaps) — browsers and any CDN that stores HTML. Whether Cloudflare stores these
pages depends on the zone's cache rules, which are not in this repository. Closing it needs a purge
on visibility change (a `search.document.removed` consumer or a Cloudflare purge token — roadmap
item 12, outside Wiki) or dropping the public max-age, which would cost every anonymous view a
render. Kept for now: the window is short and the content was public until that moment.

## 11. Search, feeds, sitemaps and events

- Sitemaps, feeds and `llms.txt` list only public, published pages the gate lets through
  (`server/http/machine.js:31-37`, `:60-72`), plus public spaces. Wiki's own search filters every
  hit through the reader's rights (`server/wiki/service.js:959-972`).
- Search documents: members/private/non-listable pages are always tombstones
  (`server/wiki/service.js:337`), with a monotonic index revision; the product event for a
  non-public change is `internal`. Discussion threads are hidden when a page stops being public
  (`server/wiki/service.js:167-176`, `test/discussion-visibility.test.js`).
- `/feed.atom` is a valid empty feed while nothing is listable (`machine.js:79-88`,
  `test/feeds.test.js`); its `updated` is the last change to a *public* space, so the time of a
  hidden change does not leak.

No gap found beyond the cache window in §10.

## 12. Space import (`POST /api/v1/spaces/:space/import`, `/s/:space/import`)

- Owners only, acting as a person; a space the caller cannot read is 404
  (`server/wiki/service.js:608-614`). Strict validation before anything happens
  (`server/wiki/import.js:69-122`): unknown fields refused, 200 pages, 2 MB, 200,000 characters per
  page, 300-character summaries, duplicate slugs, parent loops, 200 Sources items per bundle.
- One transaction (`server/wiki/service.js:632-669`): one bad page imports nothing, outbox events
  included (`test/import.test.js` compares table counts). Pages are created by the same code as
  hand-made ones (same renderer, link/citation records, events, gate); authorship names the
  importer; `ai_assisted` keeps pages noindex until reviewed.
- Limits: 20 imports per hour per address (`server/app.js:78`); nginx passes at most 3 MB (API) /
  7 MB (form) to these two routes only (`deploy/nginx/openvibe.wiki.conf:100-109`); oversized API
  bodies are a clean 413 (`server/http/api.js:86-91`). Cross-site form posts are refused.

Gap (remains): an import can publish up to 200 pages in one step — spam amplification in the
importer's own space. It is bounded by the rate limit and covered by the spam decisions in §6.

## 13. Citation inspector (`/w/:space/:slug/sources`)

It is built on `view()` (`server/wiki/service.js:1012-1033`), so it has exactly the article's read
rules: 404 for unreadable pages and revisions, 410 for deleted pages, 301 after renames, private
caching for everything that is not a public published page (`server/http/pages.js:331-343`). The
"first cited in" revision is named only when the reader may read that revision, and the "dropped"
list comes from the previous revision the reader may read. `test/citation-inspector.test.js`
checks drafts, newer revisions, private pages, members spaces, drafts and deletions. No gap found.

## 14. Denial of service and limits

Body limits: forms 600 KB (`server/http/pages.js:40`), JSON 512 KB (`server/http/api.js:87`),
nginx 1 MB elsewhere (`deploy/nginx/openvibe.wiki.conf:59`). The Markdown renderer's patterns are
linear (Publishing v0.2.1 ReDoS fixes). Diffs: `openvibe-publishing/diff` bounds its search at 4000
edits (`node_modules/openvibe-publishing/lib/diff.js:75`); measured in this review, a word diff of two
unrelated 200,000-character revisions takes about 300 ms, and its trace can reach roughly 64 MB
(`diff.js:31`). Diffs and the HTML search (a `LIKE` scan over every published page) were not rate
limited; they now are (§15). `/metrics` answers only direct loopback callers
(`node_modules/openvibe-shared/metrics.js:317-323`) and nginx hides it (`openvibe.wiki.conf:85`).

Gap (remains): the diff's memory ceiling is in `openvibe-publishing`; a lower `maxEdits` or a
trace that does not keep every diagonal would need a Publishing release.

## 15. Fixed in this pass

| Gap | Fix | Test |
|---|---|---|
| Outbound links in community spaces had `rel="noopener"` only (Markdown links and bare URLs), citations/infobox URLs `noopener nofollow` without `ugc` | `nofollow ugc noopener` for every outbound link in user spaces; official spaces unchanged (`server/wiki/service.js:923-927`, `server/render/views.js:18`) | `test/threat-review.test.js`, `test/citation-inspector.test.js` |
| A page summary could be any JSON value of any size (experiment: 100 KB went into the meta description) | Text only, at most 300 characters, on create, edit, proposal and import (`server/wiki/service.js:210-216`) | `test/threat-review.test.js`, `test/import.test.js` |
| A developer app or module holding `wiki.revision.propose` could file proposals (draft pages) in any space, private ones included, without a person | Proposals only from first-party `svc:` principals or the service itself (`server/wiki/service.js:1192-1195`) | `test/threat-review.test.js` |
| `GET /search` (full `LIKE` scan) had no rate limit | 60 per minute per address (`server/app.js:94`) | `test/threat-review.test.js` |
| Diffs (SSR and API) could be requested without limit (≈300 ms CPU, tens of MB each for large revisions) | 30 per minute per address, shared (`server/app.js:81`) | `test/threat-review.test.js` |
| Attachments were not checked against the attacher's Media read rights | The attach model in §4 (earlier commit of this pass) | `test/media-handoff.test.js` |
| nginx's 1 MB body limit would have cut off import bundles before the app's own checks | Import routes get 3 MB / 7 MB (earlier commit of this pass) | — (nginx reference config) |

## 16. Remaining gaps

| Gap | Why it remains | Who |
|---|---|---|
| CSP allows inline scripts; `ov_token` is readable by JavaScript | Needs nonces in `openvibe-shared`'s inline scripts and a navbar that does not read the token | OpenVibe.Shared, OpenVibe.Network |
| Up to 60 s (feeds 5 min) of cached public copies after a page goes private | Needs a purge on visibility change; Cloudflare purge scope not available | Roadmap item 12 (Search consumer / CF token) |
| Spam controls: no per-account quotas, bot challenge, takedown flow; new user spaces indexable at once | Product/policy decisions; a trust signal would come from the Network | Owner decision, then Wiki |
| Attachments show a broken image (not the placeholder) until the next check after Media deletes or hides an object | Media does not emit deletion/visibility events yet | OpenVibe.Media, then Wiki |
| Diff memory ceiling (~64 MB for a pathological pair) | Lives in `openvibe-publishing/diff` | OpenVibe.Publishing |
| First-party capabilities held by `app:`/`mod:` tokens are not refused by Wiki (except proposals) | Apps legitimately use `wiki.page.create` for their person; the grant policy is the Network's | OpenVibe.Network |
| `Origin: null` accepted on form posts; `/auth/logout` is a GET | Nuisance-level with SameSite=Lax; the session layer is shared with OpenVibe.Community and should change in both | Wiki + Community together |
