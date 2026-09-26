'use strict';
/**
 * /api/v1 — JSON API for people (Network user JWT as Bearer or the ov_token cookie) and services
 * (Network client-credentials token for audience openvibe.wiki, one capability per route, acting
 * for the person named in X-OV-Subject). Errors are RFC 9457 problem+json. Responses are
 * Cache-Control: private, no-store.
 *
 *   GET    /spaces                                   readable spaces
 *   POST   /spaces                         wiki.space.create     { slug?, name, description?, kind?, visibility? }
 *   GET    /spaces/:space                            space + page tree
 *   PATCH  /spaces/:space                  wiki.space.create     { name?, description?, visibility?, slug? }   owner
 *   GET    /spaces/:space/roles                      owner
 *   PUT    /spaces/:space/roles/:subject   wiki.space.create     { role: owner|editor|viewer|null }  owner
 *   POST   /spaces/:space/pages            wiki.page.create      { title, body, summary?, infobox?, parent_id?, visibility?, citations?, message? }
 *   POST   /spaces/:space/import           wiki.page.create      { pages: [...], publish?, on_existing?, source?, original_author?, ai_assisted? }  owner; all or nothing (server/wiki/import.js)
 *   GET    /pages/:id                      wiki.page.read        page + the revision the caller may read (?revision=)
 *   PATCH  /pages/:id                      wiki.page.create      { slug?, parent_id?, visibility?, noindex? }
 *   DELETE /pages/:id                      wiki.page.create      owner
 *   GET    /pages/:id/revisions            wiki.page.read        history (?before=&limit=)
 *   POST   /pages/:id/revisions            wiki.page.create      { expected_revision, body?, title?, summary?, infobox?, citations?, keep_citations?, message? }
 *   GET    /pages/:id/revisions/:n         wiki.page.read
 *   GET    /pages/:id/diff?from=&to=&mode= wiki.page.read
 *   GET    /pages/:id/revisions/:n/citations  wiki.page.read
 *   POST   /pages/:id/revisions/:n/citations  wiki.citation.attach  { citations: [...] }  (unpublished head only)
 *   POST   /pages/:id/revisions/:n/review     wiki.revision.publish { decision: approved|rejected, note? }  a person (owner/editor)
 *   POST   /pages/:id/publish              wiki.revision.publish { revision? }
 *   POST   /pages/:id/schedule             wiki.revision.publish { revision?, run_at }
 *   POST   /pages/:id/unpublish            wiki.revision.publish
 *   POST   /pages/:id/revert               wiki.revision.revert  { to_revision, expected_revision, message?, publish? }
 *   POST   /pages/:id/media                wiki.page.create      { media_id, alt?, caption? }  a person who can read the object in Media
 *   POST   /pages/:id/media/verify         wiki.page.create
 *   PUT    /pages/:id/watch                                      { watching: bool }  people only
 *   POST   /proposals                      wiki.revision.propose { space, page_id?, title?, body, summary?, infobox?, citations?, workflow: { id, run_id, version?, model? }, stub_provider?, expected_revision?, note? }
 *   GET    /proposals/:id                  wiki.page.read
 *   POST   /proposals/:id/review           wiki.revision.publish { decision: approved|rejected, note?, publish? }  a person
 *   GET    /search?q=&space=&limit=        wiki.search.query
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { actorMiddleware, guard, run, resolveCitations, resolveBundleCitations } = require('./common');
const importer = require('../wiki/import');

const { http } = contracts;

function serializeSpace(s) {
    return { id: s.id, slug: s.slug, name: s.name, description: s.description, kind: s.kind, visibility: s.visibility, created_at: new Date(s.created_at).toISOString(), updated_at: new Date(s.updated_at).toISOString() };
}

function serializePage(p, svc, space) {
    return {
        id: p.id, space: space.slug, slug: p.slug, title: p.title, parent_id: p.parent_id, state: p.state, visibility: p.visibility,
        noindex: !!p.noindex, published_revision: p.published_revision,
        published_at: p.published_at ? new Date(p.published_at).toISOString() : null,
        revision_published_at: p.revision_published_at ? new Date(p.revision_published_at).toISOString() : null,
        updated_at: new Date(p.updated_at).toISOString(), url: svc.pageUrl(space, p),
    };
}

function serializeRevision(r) {
    return {
        number: r.number, id: r.id, kind: r.kind, parent_number: r.parentNumber, reverted_to: r.revertedTo,
        title: r.fields.title, summary: r.fields.summary || null, infobox: r.fields.infobox || [], body: r.content,
        authorship: r.meta.authorship || null, author: r.author, message: r.message, created_at: r.createdAt,
    };
}

function serializeCitation(c) {
    return { id: c.id, revision: c.revision, url: c.url, title: c.title, source_item_id: c.sourceItemId, retrieved_at: c.retrievedAt, quote: c.quote, license_note: c.licenseNote, carried_from: c.carriedFrom, attached_by: c.attachedBy, attached_at: c.attachedAt };
}

function serializeAttachment(a) {
    return { id: a.id, media_id: a.mediaId, alt: a.alt, caption: a.caption, state: a.state, broken_reason: a.brokenReason, checked_at: a.checkedAt, attached_by: a.attachedBy };
}

function serializeTree(nodes, svc, space) {
    return nodes.map((n) => ({ ...serializePage(n.page, svc, space), children: serializeTree(n.children, svc, space) }));
}

function int(v) { const n = Number(v); return Number.isInteger(n) ? n : undefined; }

function createApi({ svc, viewers, platform, config, log = console }) {
    const router = express.Router();
    const ownOrigin = new URL(config.baseUrl).origin;
    router.use(http.middleware());
    // An import bundle may be larger than any other request body (server/wiki/import.js).
    router.post('/spaces/:space/import', express.json({ limit: importer.MAX_BUNDLE_BYTES }));
    router.use(express.json({ limit: '512kb' }));
    router.use((err, req, res, next) => {
        if (!err) return next();
        if (err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { detail: `The request body is larger than ${err.limit} bytes`, ctx: req.ov });
        return http.sendProblem(res, 400, 'request.invalid_json', { detail: 'Malformed JSON body', ctx: req.ov });
    });
    // Cookie-authenticated writes from another site are refused (Bearer callers are not browsers' ambient credentials).
    router.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD' || req.headers.authorization) return next();
        const o = req.get('origin');
        if (o && o !== ownOrigin) return http.sendProblem(res, 403, 'request.cross_site', { detail: 'Cross-site requests with cookies are not accepted', ctx: req.ov });
        next();
    });
    router.use(actorMiddleware(viewers));
    const R = (fn, status) => run(fn, status, log);
    // VIP (WS-K task 8): ask VIP about the space or page a route names before its synchronous access check.
    const prepare = (req, pairs, next) => (req.actor && req.actor.subject ? svc.access.prepareVip(req.actor, pairs).then(() => next(), next) : next());
    router.param('space', (req, res, next, ref) => {
        const space = svc.findSpace(ref);
        return space && !space.deleted_at ? prepare(req, [{ space }, ...svc.vipPagesOf(space.id).map((page) => ({ space, page }))], next) : next();
    });
    router.param('id', (req, res, next, id) => {
        const page = svc.pageById(id);
        const space = page && svc.spaceById(page.space_id);
        return space ? prepare(req, [{ space }, { space, page }], next) : next();
    });

    const pageAndSpace = (id) => {
        const page = svc.pageById(id);
        if (!page) throw new svc.WikiError(404, 'page.not_found', 'No such page');
        const space = svc.spaceById(page.space_id);
        return { page, space };
    };
    const readable = (req, id) => {
        const { page, space } = pageAndSpace(id);
        if (!svc.access.canReadPage(space, page, req.actor)) throw new svc.WikiError(404, 'page.not_found', 'No such page');
        return { page, space };
    };

    // Spaces
    router.get('/spaces', R((req) => ({ spaces: svc.listSpaces(req.actor).map(serializeSpace) })));
    router.post('/spaces', guard('wiki.space.create'), R((req) => ({ space: serializeSpace(svc.createSpace(req.body || {}, req.actor)) }), 201));
    router.get('/spaces/:space', R((req) => {
        const space = svc.getSpace(req.params.space, req.actor);
        return { space: serializeSpace(space), pages: serializeTree(svc.tree(space, req.actor), svc, space) };
    }));
    router.patch('/spaces/:space', guard('wiki.space.create'), R((req) => ({ space: serializeSpace(svc.updateSpace(req.params.space, req.body || {}, req.actor)) })));
    router.get('/spaces/:space/roles', R((req) => ({ roles: svc.roles(req.params.space, req.actor) })));
    router.put('/spaces/:space/roles/:subject', guard('wiki.space.create'), R((req) => ({ roles: svc.setRole(req.params.space, req.params.subject, (req.body || {}).role == null ? null : String(req.body.role), req.actor) })));
    router.post('/spaces/:space/pages', guard('wiki.page.create'), R(async (req) => {
        const b = req.body || {};
        const cites = await resolveCitations(b.citations, platform);
        const out = svc.createPage(req.params.space, { title: b.title, body: b.body, summary: b.summary, infobox: b.infobox, parentId: b.parent_id || null, visibility: b.visibility, citations: cites, message: b.message }, req.actor);
        const space = svc.spaceById(out.page.space_id);
        return { page: serializePage(out.page, svc, space), revision: serializeRevision(out.revision), citations: svc.citationsOf(out.page, out.revision.number).map(serializeCitation) };
    }, 201));

    router.post('/spaces/:space/import', guard('wiki.page.create'), R(async (req) => {
        const { space, bundle } = svc.prepareImport(req.params.space, req.body, req.actor);
        await resolveBundleCitations(bundle, platform);
        const out = svc.importPages(space.id, bundle, req.actor);
        return {
            space: serializeSpace(out.space), published: out.published, skipped: out.skipped,
            created: out.created.map((c) => ({ ...serializePage(c.page, svc, out.space), revision: c.revision.number })),
        };
    }, 201));

    // Pages
    router.get('/pages/:id', guard('wiki.page.read'), R((req) => {
        const { page, space } = readable(req, req.params.id);
        const v = svc.view(space, page, req.actor, { revision: int(req.query.revision) });
        return {
            page: serializePage(page, svc, space), revision: serializeRevision(v.revision),
            citations: v.citations.map(serializeCitation), infobox: v.infobox,
            attachments: v.attachments.map(serializeAttachment),
            links: v.links.map((l) => ({ space: l.target_space, slug: l.target_slug, label: l.label })),
            indexability: { indexable: v.decision.indexable, reasons: v.decision.reasons },
            discussion_thread: v.discussion ? v.discussion.threadId : null,
        };
    }));
    router.patch('/pages/:id', guard('wiki.page.create'), R((req) => {
        const b = req.body || {};
        let page = svc.pageById(req.params.id);
        if (!page) throw new svc.WikiError(404, 'page.not_found', 'No such page');
        if (b.slug !== undefined || b.parent_id !== undefined) page = svc.movePage(page.id, { slug: b.slug, parentId: b.parent_id }, req.actor);
        if (b.visibility !== undefined || b.noindex !== undefined) page = svc.setPageVisibility(page.id, { visibility: b.visibility, noindex: b.noindex }, req.actor).page;
        return { page: serializePage(page, svc, svc.spaceById(page.space_id)) };
    }));
    router.delete('/pages/:id', guard('wiki.page.create'), R((req) => {
        const out = svc.deletePage(req.params.id, req.actor);
        return { page: serializePage(out.page, svc, svc.spaceById(out.page.space_id)) };
    }));
    router.get('/pages/:id/revisions', guard('wiki.page.read'), R((req) => {
        const { page, space } = readable(req, req.params.id);
        if (page.state !== 'published' && !svc.access.canEdit(space, req.actor)) throw new svc.WikiError(404, 'page.not_found', 'No such page');
        return { revisions: svc.history(page, { limit: req.query.limit, before: req.query.before, actor: req.actor }).map((r) => ({ ...serializeRevision(r), body: undefined, published: r.published, citation_count: r.citationCount, proposal: r.proposal ? { id: r.proposal.id, status: r.proposal.status } : null })) };
    }));
    router.post('/pages/:id/revisions', guard('wiki.page.create'), R(async (req) => {
        const b = req.body || {};
        const cites = await resolveCitations(b.citations, platform);
        const out = svc.editPage(req.params.id, {
            expectedRevision: int(b.expected_revision), title: b.title, body: b.body, summary: b.summary, infobox: b.infobox,
            citations: cites, keepCitations: b.keep_citations === undefined ? 'all' : b.keep_citations, message: b.message,
        }, req.actor);
        const space = svc.spaceById(out.page.space_id);
        return { page: serializePage(out.page, svc, space), revision: serializeRevision(out.revision), created: out.created, citations: svc.citationsOf(out.page, out.revision.number).map(serializeCitation) };
    }, (out) => (out.created ? 201 : 200)));
    router.get('/pages/:id/revisions/:n', guard('wiki.page.read'), R((req) => {
        const { page, space } = readable(req, req.params.id);
        const v = svc.view(space, page, req.actor, { revision: int(req.params.n) });
        return { revision: serializeRevision(v.revision), citations: v.citations.map(serializeCitation), infobox: v.infobox };
    }));
    router.get('/pages/:id/diff', guard('wiki.page.read'), R((req) => {
        const { page, space } = readable(req, req.params.id);
        if (page.state !== 'published' && !svc.access.canEdit(space, req.actor)) throw new svc.WikiError(404, 'page.not_found', 'No such page');
        return { diff: svc.diff(page, int(req.query.from), int(req.query.to), { mode: req.query.mode, actor: req.actor }) };
    }));
    router.get('/pages/:id/revisions/:n/citations', guard('wiki.page.read'), R((req) => {
        const { page, space } = readable(req, req.params.id);
        svc.view(space, page, req.actor, { revision: int(req.params.n) });
        return { citations: svc.citationsOf(page, int(req.params.n)).map(serializeCitation) };
    }));
    router.post('/pages/:id/revisions/:n/citations', guard('wiki.citation.attach'), R(async (req) => {
        const cites = await resolveCitations((req.body || {}).citations, platform);
        return { citations: svc.attachCitations(req.params.id, int(req.params.n), cites, req.actor).map(serializeCitation) };
    }, 201));
    router.post('/pages/:id/revisions/:n/review', guard('wiki.revision.publish'), R((req) => {
        const { page, space } = pageAndSpace(req.params.id);
        const b = req.body || {};
        const out = svc.reviewRevision(space.id, page.slug, int(req.params.n), { decision: b.decision, note: b.note == null ? null : String(b.note) }, req.actor);
        return { review: out.review, page: serializePage(out.page, svc, space), action: out.action, indexable: out.indexable, reasons: out.reasons };
    }, 201));
    router.post('/pages/:id/publish', guard('wiki.revision.publish'), R((req) => {
        const out = svc.publish(req.params.id, { revision: int((req.body || {}).revision) }, req.actor);
        return { page: serializePage(out.page, svc, svc.spaceById(out.page.space_id)), action: out.action };
    }));
    router.post('/pages/:id/schedule', guard('wiki.revision.publish'), R((req) => {
        const b = req.body || {};
        const out = svc.schedulePublish(req.params.id, { revision: int(b.revision), runAt: b.run_at }, req.actor);
        return { job: out.job, created: out.created };
    }, (out) => (out.created ? 201 : 200)));
    router.post('/pages/:id/unpublish', guard('wiki.revision.publish'), R((req) => {
        const out = svc.unpublish(req.params.id, req.actor);
        return { page: serializePage(out.page, svc, svc.spaceById(out.page.space_id)), action: out.action };
    }));
    router.post('/pages/:id/revert', guard('wiki.revision.revert'), R((req) => {
        const b = req.body || {};
        const out = svc.revert(req.params.id, { toRevision: int(b.to_revision), expectedRevision: int(b.expected_revision), message: b.message, publish: b.publish }, req.actor);
        return { page: serializePage(out.page, svc, svc.spaceById(out.page.space_id)), revision: serializeRevision(out.revision), published: out.published };
    }, 201));
    router.post('/pages/:id/media', guard('wiki.page.create'), R(async (req) => {
        const b = req.body || {};
        const a = await svc.attachMedia(req.params.id, { mediaId: b.media_id, alt: b.alt, caption: b.caption }, req.actor, { describe: platform.media.describe });
        return { attachment: serializeAttachment(a) };
    }, 201));
    router.post('/pages/:id/media/verify', guard('wiki.page.create'), R(async (req) => {
        const { space } = pageAndSpace(req.params.id);
        if (!svc.access.canEdit(space, req.actor)) throw new svc.WikiError(403, 'page.forbidden', 'Only editors of this space can check media');
        return { results: await svc.verifyMedia(req.params.id, platform.media.resolve) };
    }));
    router.put('/pages/:id/watch', R((req) => svc.watch(req.params.id, req.actor, (req.body || {}).watching !== false)));

    // AI proposals
    router.post('/proposals', guard('wiki.revision.propose'), R(async (req) => {
        const b = req.body || {};
        const cites = await resolveCitations(b.citations, platform);
        const wf = b.workflow || {};
        const out = svc.propose({
            space: b.space, pageId: b.page_id || null, title: b.title, body: b.body, summary: b.summary, infobox: b.infobox, citations: cites,
            workflow: { id: wf.id, runId: wf.run_id || wf.runId, version: wf.version, model: wf.model }, stubProvider: !!b.stub_provider,
            expectedRevision: b.expected_revision, note: b.note,
        }, req.actor);
        return { proposal: out.proposal, page: serializePage(out.page, svc, svc.spaceById(out.page.space_id)), revision: serializeRevision(out.revision) };
    }, 201));
    router.get('/proposals/:id', guard('wiki.page.read'), R((req) => {
        const p = svc.getProposal(req.params.id);
        if (!p || !svc.access.canEdit(svc.spaceById(p.space_id), req.actor)) {
            // Proposers may read their own proposal's state.
            if (!p || !req.actor || req.actor.kind !== 'service' || p.proposed_by !== req.actor.service) throw new svc.WikiError(404, 'proposal.not_found', 'No such proposal');
        }
        return { proposal: p };
    }));
    router.post('/proposals/:id/review', guard('wiki.revision.publish'), R((req) => {
        const b = req.body || {};
        return svc.reviewProposal(req.params.id, { decision: b.decision, note: b.note, publish: b.publish !== false }, req.actor);
    }));

    router.get('/search', guard('wiki.search.query'), R((req) => ({
        results: svc.search(req.query.q, req.actor, { space: req.query.space || null, limit: req.query.limit }).map((r) => ({ ...serializePage(r.page, svc, r.space), summary: r.summary })),
    })));

    router.use((req, res) => http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createApi, serializePage, serializeRevision, serializeCitation, serializeSpace };
