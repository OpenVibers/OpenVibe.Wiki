'use strict';
/**
 * The wiki domain: spaces, page trees, revisions, publication, links, infoboxes, citations,
 * attachments, watchers and AI proposals. Wiki owns its publication state; the Publishing
 * packages supply the mechanics (revisions, citations, the gate, redirects, index hooks).
 *
 * Every write runs in one SQLite transaction together with the events it causes (transactional
 * outbox): wiki.space.updated, wiki.revision.created, wiki.page.published|updated|unpublished|deleted,
 * wiki.watch.triggered, and the Search index events wiki.index_document.upserted|deleted.
 * After the commit (never inside it), a page that stops or starts being public has its Community
 * discussion thread hidden or shown again (best effort).
 *
 * Methods take an actor (server/wiki/access.js) and throw WikiError (status + stable code).
 */
const seo = require('openvibe-publishing/seo');
const hooks = require('openvibe-publishing/index-hooks');
const authorship = require('openvibe-publishing/authorship');
const ssr = require('openvibe-publishing/ssr');
const { isMediaId } = require('openvibe-publishing/media');
const { ulid } = require('openvibe-contracts').ids;
const content = require('./content');
const importer = require('./import');
const { createAccess, VISIBILITIES } = require('./access');

class WikiError extends Error {
    constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; if (extra) this.extra = extra; }
}

const SPACE_KINDS = ['official', 'user'];
const MAX_BODY = 200000;
const MAX_TITLE = 200;
const MAX_SUMMARY = 300;
const GATE_VIS = { public: 'public', members: 'gated', private: 'private' };
const PAGE_ID_RE = /^pg_[0-9A-HJKMNP-TV-Z]{26}$/;

function pageIdNew(t) { return `pg_${ulid(t)}`; }
function spaceIdNew(t) { return `spc_${ulid(t)}`; }
function proposalIdNew(t) { return `prp_${ulid(t)}`; }

function toIso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

/**
 * An imported revision whose text was produced with AI assistance (the seed) is generated content:
 * it needs a person's review before it may be indexed, exactly like AI output. Rows written before
 * the explicit flag existed are recognised by their import label.
 */
function aiAssistedImport(rec) {
    if (!rec || rec.mode !== 'imported' || !rec.importedFrom) return false;
    return rec.importedFrom.aiAssisted === true || /AI assistance/i.test(String(rec.importedFrom.label || ''));
}

/** Gate facts for a revision's authorship: AI-assisted imports count as AI output until reviewed. */
function authorshipGateFacts(rec, review) {
    if (aiAssistedImport(rec)) return { authorship: { mode: 'ai', reviewed: authorship.isReviewed(rec, review) } };
    return authorship.gateFacts(rec, review);
}

/** The disclosure shown at the item; AI-assisted imports say whether a person has reviewed them. */
function disclosureFor(rec, review) {
    const d = authorship.disclosure(rec, review);
    if (!d || !aiAssistedImport(rec)) return d;
    const reviewed = authorship.isReviewed(rec, review);
    return {
        ...d,
        short: 'Imported, written with AI assistance',
        long: `${d.long.replace(/\.\s*$/, '')}. ${reviewed ? 'Reviewed by a person.' : 'Not yet reviewed by a person.'}`,
        reviewed,
    };
}

function createWikiService({ db, stores, outbox, config, community = null, now = () => Date.now(), log = console }) {
    const { revisions, citations, redirects, reviews, attachments, discussions, scheduler, sequencer } = stores;
    const access = createAccess(db);
    const origin = config.baseUrl;
    const policy = config.gate;

    // ── Queries ───────────────────────────────────────────────
    const q = {
        spaceById: db.prepare('SELECT * FROM wiki_spaces WHERE id = ?'),
        spaceBySlug: db.prepare('SELECT * FROM wiki_spaces WHERE slug = ?'),
        spaces: db.prepare('SELECT * FROM wiki_spaces WHERE deleted_at IS NULL ORDER BY kind = \'official\' DESC, name COLLATE NOCASE'),
        insertSpace: db.prepare(`INSERT INTO wiki_spaces (id, slug, name, description, kind, visibility, owner, created_by, created_at, updated_at)
                                 VALUES (@id, @slug, @name, @description, @kind, @visibility, @owner, @created_by, @now, @now)`),
        pageById: db.prepare('SELECT * FROM wiki_pages WHERE id = ?'),
        pageBySlug: db.prepare('SELECT * FROM wiki_pages WHERE space_id = ? AND slug = ?'),
        pagesOfSpace: db.prepare("SELECT * FROM wiki_pages WHERE space_id = ? AND state != 'deleted' ORDER BY position, title COLLATE NOCASE"),
        publishedOfSpace: db.prepare("SELECT id FROM wiki_pages WHERE space_id = ? AND state IN ('published','unpublished','scheduled','draft')"),
        insertPage: db.prepare(`INSERT INTO wiki_pages (id, space_id, slug, title, parent_id, position, state, visibility, created_by, created_at, updated_at)
                                VALUES (@id, @space_id, @slug, @title, @parent_id, @position, 'draft', @visibility, @created_by, @now, @now)`),
        children: db.prepare("SELECT * FROM wiki_pages WHERE parent_id = ? AND state != 'deleted' ORDER BY position, title COLLATE NOCASE"),
        insertLink: db.prepare('INSERT OR IGNORE INTO wiki_page_links (from_page_id, from_revision, target_space, target_slug, label) VALUES (?, ?, ?, ?, ?)'),
        linksOf: db.prepare('SELECT * FROM wiki_page_links WHERE from_page_id = ? AND from_revision = ? ORDER BY target_space, target_slug'),
        backlinks: db.prepare(`SELECT DISTINCT p.* FROM wiki_page_links l JOIN wiki_pages p ON p.id = l.from_page_id AND l.from_revision = p.published_revision
                               WHERE l.target_space = ? AND l.target_slug = ? AND p.state = 'published' ORDER BY p.title COLLATE NOCASE LIMIT 200`),
        insertInfobox: db.prepare(`INSERT INTO wiki_infobox_values (page_id, revision, position, key, label, type, value_text, value_number)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        infoboxOf: db.prepare('SELECT * FROM wiki_infobox_values WHERE page_id = ? AND revision = ? ORDER BY position'),
        roles: db.prepare('SELECT * FROM wiki_permissions WHERE space_id = ? ORDER BY role, subject'),
        putRole: db.prepare(`INSERT INTO wiki_permissions (space_id, subject, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
                             ON CONFLICT (space_id, subject) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at`),
        delRole: db.prepare('DELETE FROM wiki_permissions WHERE space_id = ? AND subject = ?'),
        owners: db.prepare("SELECT COUNT(*) AS n FROM wiki_permissions WHERE space_id = ? AND role = 'owner'"),
        watchers: db.prepare('SELECT subject FROM wiki_watchers WHERE page_id = ? ORDER BY subject'),
        watch: db.prepare('INSERT OR IGNORE INTO wiki_watchers (page_id, subject, created_at) VALUES (?, ?, ?)'),
        unwatch: db.prepare('DELETE FROM wiki_watchers WHERE page_id = ? AND subject = ?'),
        isWatching: db.prepare('SELECT 1 FROM wiki_watchers WHERE page_id = ? AND subject = ?'),
        proposal: db.prepare('SELECT * FROM wiki_ai_proposals WHERE id = ?'),
        proposalByRev: db.prepare('SELECT * FROM wiki_ai_proposals WHERE page_id = ? AND revision = ?'),
        proposalsOfPage: db.prepare('SELECT * FROM wiki_ai_proposals WHERE page_id = ? ORDER BY created_at DESC'),
        pendingProposals: db.prepare("SELECT * FROM wiki_ai_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 200"),
        insertProposal: db.prepare(`INSERT INTO wiki_ai_proposals (id, page_id, space_id, revision, base_revision, workflow_id, run_id, stub_provider, status, proposed_by, note, created_at)
                                    VALUES (@id, @page_id, @space_id, @revision, @base_revision, @workflow_id, @run_id, @stub_provider, 'pending', @proposed_by, @note, @now)`),
        reviewProposal: db.prepare("UPDATE wiki_ai_proposals SET status = @status, reviewed_by = @by, review_note = @note, reviewed_at = @now WHERE id = @id AND status = 'pending'"),
        recent: db.prepare(`SELECT p.* FROM wiki_pages p JOIN wiki_spaces s ON s.id = p.space_id
                            WHERE p.state = 'published' AND s.deleted_at IS NULL AND s.visibility = 'public' AND p.visibility = 'public'
                            ORDER BY p.revision_published_at DESC, p.id LIMIT ?`),
        allPublishedPublic: db.prepare(`SELECT p.* FROM wiki_pages p JOIN wiki_spaces s ON s.id = p.space_id
                            WHERE p.state = 'published' AND s.deleted_at IS NULL AND s.visibility = 'public' AND p.visibility = 'public'
                            ORDER BY p.id`),
        insertOrigin: db.prepare(`INSERT INTO wiki_attachment_origins (attachment_id, page_id, media_id, attached_by, media_owner, media_visibility, attached_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`),
        originsOf: db.prepare('SELECT * FROM wiki_attachment_origins WHERE page_id = ?'),
        search: db.prepare(`SELECT p.* FROM wiki_pages p JOIN wiki_spaces s ON s.id = p.space_id
                            JOIN wiki_page_revisions r ON r.entity_id = p.id AND r.number = p.published_revision
                            WHERE p.state = 'published' AND s.deleted_at IS NULL AND (@space IS NULL OR s.slug = @space)
                              AND (p.title LIKE @like ESCAPE '\\' OR r.content LIKE @like ESCAPE '\\')
                            ORDER BY (p.title LIKE @like ESCAPE '\\') DESC, p.revision_published_at DESC LIMIT 200`),
    };

    // ── Paths and small helpers ───────────────────────────────
    const spacePath = (space) => `/s/${encodeURIComponent(space.slug)}`;
    const pagePath = (space, page) => `/w/${encodeURIComponent(space.slug)}/${encodeURIComponent(page.slug)}`;
    const pageUrl = (space, page) => seo.canonicalUrl(origin, pagePath(space, page));
    const fail = (status, code, message, extra) => { throw new WikiError(status, code, message, extra); };

    // Work that must wait until the write has committed (never inside the transaction). Queued by
    // afterCommit() and run once the outermost tx() returns; dropped when the transaction throws.
    let commitQueue = null;
    function tx(fn) {
        if (commitQueue) return db.transaction(fn)();
        commitQueue = [];
        let out;
        try {
            out = db.transaction(fn)();
        } catch (err) {
            commitQueue = null;
            throw err;
        }
        const queue = commitQueue;
        commitQueue = null;
        for (const job of queue) {
            try { job(); } catch (err) { log.warn(`[Wiki] after-commit: ${err && err.message}`); }
        }
        return out;
    }
    function afterCommit(job) {
        if (commitQueue) commitQueue.push(job);
        else job();
    }

    /**
     * Keep a page's Community discussion thread in step with the page: hidden when it is
     * unpublished, deleted or stops being public, shown again when it is public again. Best effort
     * after the commit (needs community.comment.moderate); a failure never fails the write. A page
     * that never had a thread (threads exist only for public pages) calls nothing.
     */
    function followThread(pageId, visibility) {
        if (!community || typeof community.setThreadVisibility !== 'function') return;
        afterCommit(() => {
            const known = discussions.get(pageId);
            if (!known) return;
            Promise.resolve()
                .then(() => community.setThreadVisibility(known.threadId, visibility))
                .catch((err) => log.warn(`[Wiki] could not set the discussion thread of ${pageId} to ${visibility}: ${err && err.message}`));
        });
    }

    function actorId(actor) {
        if (!actor) return 'svc:wiki';
        if (actor.subject) return actor.subject;
        if (actor.service) return actor.service;
        return 'svc:wiki';
    }

    function requirePerson(actor) {
        if (!access.isPerson(actor)) fail(403, 'wiki.person_required', 'This action is taken by a signed-in person (a service must name one in X-OV-Subject)');
        return actor.subject;
    }

    function spaceOrFail(idOrSlug) {
        const s = /^spc_/.test(String(idOrSlug)) ? q.spaceById.get(idOrSlug) : q.spaceBySlug.get(String(idOrSlug));
        if (!s || s.deleted_at) fail(404, 'space.not_found', 'No such space');
        return s;
    }

    function pageOrFail(id) {
        const p = PAGE_ID_RE.test(String(id)) ? q.pageById.get(id) : null;
        if (!p) fail(404, 'page.not_found', 'No such page');
        return p;
    }

    function checkTitle(title) {
        const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
        if (!t) fail(422, 'page.invalid_title', 'A page needs a title');
        if (t.length > MAX_TITLE) fail(422, 'page.invalid_title', `A title is at most ${MAX_TITLE} characters`);
        return t;
    }

    /** A summary is one short sentence of text (it becomes the meta description, feeds and Search). */
    function checkSummary(summary) {
        if (summary == null || summary === '') return null;
        if (typeof summary !== 'string') fail(422, 'page.invalid_summary', 'summary must be text');
        const t = summary.replace(/\s+/g, ' ').trim();
        if (t.length > MAX_SUMMARY) fail(422, 'page.invalid_summary', `A summary is at most ${MAX_SUMMARY} characters`);
        return t || null;
    }

    function checkBody(body) {
        if (typeof body !== 'string') fail(422, 'page.invalid_body', 'body must be Markdown text');
        if (body.length > MAX_BODY) fail(413, 'page.body_too_large', `A page is at most ${MAX_BODY} characters`);
        return body.replace(/\r\n?/g, '\n');
    }

    function checkVisibility(v, fallback) {
        const out = v == null || v === '' ? fallback : String(v);
        if (!VISIBILITIES.includes(out)) fail(422, 'wiki.invalid_visibility', `visibility is one of ${VISIBILITIES.join(', ')}`);
        return out;
    }

    /**
     * A renamed (or deleted) space's old slug keeps answering with its redirect (or 410): nobody but
     * that space may take it, or the old links would serve someone else's pages.
     */
    function checkSlugNotRetired(slug, spaceId = null) {
        const r = svc.resolveRedirect(`/s/${slug}`);
        if (r && r.entityId !== spaceId) fail(409, 'space.slug_retired', `The space slug "${slug}" belonged to another space and still leads there`);
    }

    function wrapContentError(fn) {
        try { return fn(); } catch (err) {
            if (err instanceof content.ContentError) fail(422, err.code, err.message);
            if (err && err.name === 'PublishingError') fail(err.status || 400, err.code, err.message, err.expected !== undefined ? { expected: err.expected, current: err.current } : undefined);
            if (err instanceof TypeError && /citation|url|quote|retrievedAt|media|role|variant|workflow|authors|mode/i.test(err.message)) fail(422, 'wiki.invalid_input', err.message);
            throw err;
        }
    }

    // ── Events ───────────────────────────────────────────────
    function emit(envelope) { return outbox.enqueue(envelope); }

    function spaceEvent(space, actor, change) {
        emit({
            event_type: 'wiki.space.updated',
            actor: hooks.subjectRef(actorId(actor)),
            subject: { type: 'space', id: space.id },
            visibility: space.visibility === 'public' && !space.deleted_at ? 'public' : 'internal',
            payload: {
                slug: space.slug, name: space.name, kind: space.kind, visibility: space.visibility,
                deleted: !!space.deleted_at, change, url: seo.canonicalUrl(origin, spacePath(space)),
            },
        });
    }

    function revisionEvent(space, page, rev, actor, extra = {}) {
        const rec = rev.meta && rev.meta.authorship;
        // A new revision is a draft until it is published: the event is internal.
        emit({
            event_type: 'wiki.revision.created',
            actor: hooks.subjectRef(actorId(actor)),
            subject: { type: 'page', id: page.id, revision: rev.number },
            visibility: 'internal',
            payload: {
                space_id: space.id, space: space.slug, slug: page.slug, number: rev.number, kind: rev.kind,
                parent_number: rev.parentNumber, reverted_to: rev.revertedTo, authorship: rec ? hooks.AUTHORSHIP[rec.mode] : null,
                author: rev.author, message: rev.message, ...extra,
            },
        });
    }

    /** One event per change listing the watchers who may read the page (never the actor). */
    function notifyWatchers(space, page, action, revision, actor) {
        const who = actorId(actor);
        const recipients = q.watchers.all(page.id).map((r) => r.subject)
            .filter((s) => s !== who && access.subjectCanRead(space, page.state === 'deleted' ? { ...page, state: 'published' } : page, s));
        if (!recipients.length) return;
        emit({
            event_type: 'wiki.watch.triggered',
            actor: hooks.subjectRef(who),
            subject: { type: 'page', id: page.id, revision: revision || 0 },
            visibility: 'internal',
            payload: { action, space: space.slug, slug: page.slug, title: page.title, revision: revision || null, url: pageUrl(space, page), recipients },
        });
    }

    // ── The gate, index documents and publication events ─────
    function gateFacts(space, page, rev) {
        const text = ssr.markdownToText(rev.content);
        const rec = rev.meta && rev.meta.authorship;
        return {
            state: space.deleted_at ? 'deleted' : page.state,
            visibility: GATE_VIS[access.effectiveVisibility(space, page)],
            canonicalUrl: pageUrl(space, page),
            text,
            citationCount: citations.forRevision(page.id, rev.number).length,
            noindex: !!page.noindex,
            ...(rec ? authorshipGateFacts(rec, reviews.latest(page.id, rev.number)) : {}),
        };
    }

    function decide(space, page, rev) {
        return seo.evaluate(gateFacts(space, page, rev), { policy, now: now() });
    }

    function snapshot(page) {
        if (!page) return null;
        const space = q.spaceById.get(page.space_id);
        return { state: space.deleted_at ? 'deleted' : page.state, visibility: access.effectiveVisibility(space, page), revision: page.published_revision };
    }

    /**
     * After any change to a page: send Search the current document or a tombstone when it differs
     * from the last one sent (members/private pages are always tombstones: never in search), and the
     * product event when the publication state moved. Both go to the outbox in the caller's transaction.
     * When the page stops (or starts) being public, its discussion thread follows after the commit.
     */
    function sync(before, pageId, actor, { updatedIfIndexChanged = false } = {}) {
        const page = q.pageById.get(pageId);
        const space = q.spaceById.get(page.space_id);
        const eff = access.effectiveVisibility(space, page);
        const state = space.deleted_at ? 'deleted' : page.state;
        const rev = page.published_revision ? revisions.get(page.id, page.published_revision) : null;
        const decision = rev && state === 'published' ? decide(space, page, rev) : null;
        const cites = rev ? citations.forRevision(page.id, rev.number) : [];
        const doc = sequencer.stamp(hooks.buildIndexDocument({
            owner: 'wiki', type: 'page', id: page.id, revision: 0, state, visibility: GATE_VIS[eff],
            // Not listable (e.g. unreviewed generated text): never in Search, like members/private pages.
            deleted: eff !== 'public' || !decision || !decision.listable,
            canonicalUrl: pageUrl(space, page), title: rev ? rev.fields.title : page.title,
            summary: rev ? (rev.fields.summary || ssr.markdownToText(rev.content, 300)) : null,
            body: rev ? ssr.markdownToText(rev.content) : '',
            facets: { space: space.slug, space_kind: space.kind },
            authorship: rev && rev.meta.authorship, citations: cites, decision,
            publishedAt: page.published_at, updatedAt: page.revision_published_at,
        }));
        const sentBefore = before ? before.indexRevision : null;
        if (doc.revision !== sentBefore) emit(hooks.indexEvent({ document: doc, now: now() }));

        const after = { state, visibility: eff, revision: page.published_revision };
        const wasPublic = Boolean(before) && before.state === 'published' && before.visibility === 'public';
        const isPublic = state === 'published' && eff === 'public';
        if (wasPublic !== isPublic) followThread(page.id, isPublic ? 'public' : 'hidden');
        let action = hooks.actionFor(before && before.state ? before : null, after);
        // A review changes only the gate decision: announce it when what Search holds changed.
        if (!action && updatedIfIndexChanged && state === 'published' && doc.revision !== sentBefore) action = 'updated';
        if (action) {
            let evDoc = doc;
            if (doc.deleted && (action === 'published' || action === 'updated')) {
                // A members/private page is published but never indexed: the product event carries
                // its state, not a Search document.
                evDoc = { owner: 'wiki', type: 'page', id: page.id, revision: doc.revision, deleted: false, visibility: GATE_VIS[eff], canonical_url: pageUrl(space, page), publication_state: 'published', indexability: decision ? hooks.searchIndexability(decision) : null };
            }
            emit(hooks.publicationEvent({
                product: 'wiki', type: 'page', action, id: page.id, revision: page.published_revision || 0,
                actor: hooks.subjectRef(actorId(actor)), document: evDoc, decision, now: now(),
                extra: { space: space.slug, slug: page.slug, visibility: eff },
            }));
            notifyWatchers(space, page, action, page.published_revision, actor);
        }
        return { action, indexRevision: doc.revision, deleted: doc.deleted };
    }

    function before(page) {
        const s = snapshot(page);
        return s ? { ...s, indexRevision: sequencer.current('wiki', 'page', page.id) } : null;
    }

    // ── Side tables written with each revision ───────────────
    function writeRevisionExtras(space, page, rev, infobox) {
        for (const l of content.extractLinks(rev.content, space.slug)) q.insertLink.run(page.id, rev.number, l.space, l.slug, l.label);
        infobox.forEach((e, i) => q.insertInfobox.run(page.id, rev.number, i, e.key, e.label, e.type,
            e.type === 'number' ? null : String(e.value), e.type === 'number' ? e.value : null));
    }

    function infoboxOf(pageId, revision) {
        return q.infoboxOf.all(pageId, revision).map((r) => ({
            key: r.key, label: r.label, type: r.type,
            value: r.type === 'number' ? r.value_number : r.type === 'boolean' ? r.value_text === 'true' : r.value_text,
        }));
    }

    function attachCitationList(page, revisionNumber, list, actor) {
        if (!list || !list.length) return [];
        return wrapContentError(() => citations.attachMany(page.id, revisionNumber, list.map((c) => {
            if (!c || (!c.url && !c.sourceItemId)) fail(422, 'citation.no_source', 'A citation needs a URL or a Sources item id');
            if (c.url && !c.sourceItemId && !c.retrievedAt) fail(422, 'citation.retrieved_at_required', `When was ${c.url} read? A URL citation needs retrievedAt`);
            return { ...c, attachedBy: actorId(actor) };
        })));
    }

    function carryCitations(page, from, to, keep, actor) {
        if (!from || keep === 'none' || (Array.isArray(keep) && !keep.length)) return [];
        const ids = keep === 'all' || keep == null ? null : keep.map(Number).filter(Number.isInteger);
        return citations.carryForward({ entityId: page.id, fromRevision: from, toRevision: to, ids, attachedBy: actorId(actor) });
    }

    function humanRecord(actor) {
        return authorship.record({ mode: 'human', authors: [requirePerson(actor)] });
    }

    /** A new page with its first revision (permission checks and authorship are the caller's). */
    function insertPage(space, { title, body, infobox = [], parentId = null, visibility = 'public', citations: cites = [], message = null, summary = null }, actor, rec) {
        const cleanTitle = checkTitle(title);
        const slug = wrapContentError(() => content.pageSlug(cleanTitle));
        const cleanSummary = checkSummary(summary);
        const text = checkBody(body == null ? '' : body);
        const box = wrapContentError(() => content.normalizeInfobox(infobox));
        const vis = checkVisibility(visibility, 'public');
        return tx(() => {
            const existing = q.pageBySlug.get(space.id, slug);
            if (existing) fail(409, existing.state === 'deleted' ? 'page.slug_deleted' : 'page.slug_taken', existing.state === 'deleted' ? `A deleted page held "${slug}"; its address stays gone (410)` : `A page "${slug}" already exists in this space`, { page_id: existing.id });
            if (parentId) { const par = q.pageById.get(parentId); if (!par || par.space_id !== space.id || par.state === 'deleted') fail(422, 'page.invalid_parent', 'The parent must be a page of the same space'); }
            const t = now();
            const id = pageIdNew(t);
            q.insertPage.run({ id, space_id: space.id, slug, title: cleanTitle, parent_id: parentId || null, position: 0, visibility: vis, created_by: actorId(actor), now: t });
            redirects.release(`/w/${space.slug}/${slug}`);
            const { revision } = wrapContentError(() => revisions.create({
                entityId: id, expectedRevision: 0, content: text, fields: { title: cleanTitle, summary: cleanSummary, infobox: box },
                meta: { authorship: rec }, author: actorId(actor), message,
            }));
            const page = q.pageById.get(id);
            writeRevisionExtras(space, page, revision, box);
            attachCitationList(page, revision.number, cites, actor);
            revisionEvent(space, page, revision, actor);
            if (/^usr_/.test(actorId(actor))) q.watch.run(id, actorId(actor), t);
            return { page, revision };
        });
    }

    // ── Publication (internal: no permission checks) ─────────
    function publishRevision(page, revisionNumber, actor) {
        const rev = revisions.get(page.id, revisionNumber);
        if (!rev) fail(404, 'revision.not_found', `No revision ${revisionNumber}`);
        const rec = rev.meta.authorship;
        if (rec) {
            const ok = authorship.canPublish(rec, reviews.latest(page.id, revisionNumber));
            if (!ok.ok) fail(409, ok.reason, 'AI-generated revisions are published only after a person approves them');
        }
        const b = before(page);
        const t = now();
        db.prepare(`UPDATE wiki_pages SET state = 'published', published_revision = ?, title = ?, published_at = COALESCE(published_at, ?),
                    revision_published_at = CASE WHEN published_revision IS ? AND state = 'published' THEN revision_published_at ELSE ? END, updated_at = ? WHERE id = ?`)
            .run(revisionNumber, rev.fields.title || page.title, t, revisionNumber, t, t, page.id);
        return sync(b, page.id, actor);
    }

    /**
     * Readers who are not editors see the published revision and the history before it, never
     * newer drafts and never an AI proposal a person has not approved.
     */
    function revisionVisible(space, page, n, actor) {
        if (access.canEdit(space, actor)) return true;
        if (page.state !== 'published' || !page.published_revision || n > page.published_revision) return false;
        const p = q.proposalByRev.get(page.id, n);
        return !p || p.status === 'approved';
    }

    // ── Public API ───────────────────────────────────────────
    const svc = {
        access, spacePath, pagePath, pageUrl, WikiError,

        // Spaces ---------------------------------------------------------------------------
        listSpaces(actor) { return q.spaces.all().filter((s) => access.canReadSpace(s, actor)); },

        getSpace(idOrSlug, actor) {
            const s = spaceOrFail(idOrSlug);
            if (!access.canReadSpace(s, actor)) fail(404, 'space.not_found', 'No such space');
            return s;
        },

        /** Raw lookup for redirects and routing (no permission check; callers decide). */
        findSpace(slug) { return q.spaceBySlug.get(String(slug)) || null; },
        findPage(spaceId, slug) { return q.pageBySlug.get(spaceId, String(slug)) || null; },
        pageById(id) { return PAGE_ID_RE.test(String(id)) ? q.pageById.get(id) || null : null; },
        spaceById(id) { return q.spaceById.get(id) || null; },

        createSpace({ slug, name, description = null, kind = 'user', visibility = 'public' } = {}, actor) {
            const cleanName = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 120);
            if (!cleanName) fail(422, 'space.invalid_name', 'A space needs a name');
            let cleanSlug;
            try { cleanSlug = slug ? String(slug).trim().toLowerCase() : content.pageSlug(cleanName); } catch (err) { fail(422, 'space.invalid_slug', err.message); }
            if (!content.SPACE_SLUG_RE.test(cleanSlug)) fail(422, 'space.invalid_slug', 'A space slug is 2–63 lowercase letters, digits and dashes');
            if (!SPACE_KINDS.includes(kind)) fail(422, 'space.invalid_kind', 'kind is official or user');
            const vis = checkVisibility(visibility, 'public');
            // Official (editorial) spaces: Network staff, this service, or a first-party service (svc:…)
            // acting as itself. A developer app or module (app:…, mod:…) never does.
            const firstPartyService = actor && actor.kind === 'service' && !actor.subject && /^svc:/.test(String(actor.service));
            if (kind === 'official' && !(actor && (actor.kind === 'system' || (actor.kind === 'user' && actor.staff) || firstPartyService))) {
                fail(403, 'space.official_staff_only', 'Only OpenVibe staff create official spaces');
            }
            if (kind === 'user') requirePerson(actor);
            const owner = kind === 'user' ? actor.subject : (actor && actor.kind === 'service' ? actor.service : 'svc:wiki');
            return tx(() => {
                if (q.spaceBySlug.get(cleanSlug)) fail(409, 'space.slug_taken', `The space slug "${cleanSlug}" is taken`);
                checkSlugNotRetired(cleanSlug);
                const t = now();
                const id = spaceIdNew(t);
                q.insertSpace.run({ id, slug: cleanSlug, name: cleanName, description: description == null ? null : String(description).slice(0, 1000), kind, visibility: vis, owner, created_by: actorId(actor), now: t });
                if (/^usr_/.test(owner)) q.putRole.run(id, owner, 'owner', actorId(actor), t);
                redirects.release(`/s/${cleanSlug}`);
                const space = q.spaceById.get(id);
                spaceEvent(space, actor, 'created');
                return space;
            });
        },

        updateSpace(idOrSlug, { name, description, visibility, slug } = {}, actor) {
            const space = spaceOrFail(idOrSlug);
            if (!access.canManage(space, actor)) fail(403, 'space.forbidden', 'Only an owner of this space can change it');
            return tx(() => {
                const pages = q.publishedOfSpace.all(space.id).map((r) => q.pageById.get(r.id));
                const snaps = new Map(pages.map((p) => [p.id, before(p)]));
                const t = now();
                const next = {
                    name: name == null ? space.name : String(name).replace(/\s+/g, ' ').trim().slice(0, 120) || space.name,
                    description: description === undefined ? space.description : (description == null ? null : String(description).slice(0, 1000)),
                    visibility: checkVisibility(visibility, space.visibility),
                    slug: slug == null || slug === '' ? space.slug : String(slug).trim().toLowerCase(),
                };
                if (!content.SPACE_SLUG_RE.test(next.slug)) fail(422, 'space.invalid_slug', 'A space slug is 2–63 lowercase letters, digits and dashes');
                if (next.slug !== space.slug) {
                    if (q.spaceBySlug.get(next.slug)) fail(409, 'space.slug_taken', `The space slug "${next.slug}" is taken`);
                    checkSlugNotRetired(next.slug, space.id);
                    redirects.recordMove(space.id, `/s/${space.slug}`, `/s/${next.slug}`, { reason: 'space_renamed' });
                    for (const p of q.pagesOfSpace.all(space.id)) redirects.recordMove(p.id, `/w/${space.slug}/${p.slug}`, `/w/${next.slug}/${p.slug}`, { reason: 'space_renamed' });
                }
                db.prepare('UPDATE wiki_spaces SET name = ?, description = ?, visibility = ?, slug = ?, updated_at = ? WHERE id = ?')
                    .run(next.name, next.description, next.visibility, next.slug, t, space.id);
                const updated = q.spaceById.get(space.id);
                spaceEvent(updated, actor, next.slug !== space.slug ? 'renamed' : (next.visibility !== space.visibility ? 'visibility' : 'settings'));
                for (const p of pages) sync(snaps.get(p.id), p.id, actor);
                return updated;
            });
        },

        deleteSpace(idOrSlug, actor) {
            const space = spaceOrFail(idOrSlug);
            if (!access.canManage(space, actor)) fail(403, 'space.forbidden', 'Only an owner of this space can delete it');
            return tx(() => {
                const pages = q.publishedOfSpace.all(space.id).map((r) => q.pageById.get(r.id));
                const snaps = new Map(pages.map((p) => [p.id, before(p)]));
                db.prepare('UPDATE wiki_spaces SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), space.id);
                for (const p of pages) { scheduler.cancelPending(p.id); sync(snaps.get(p.id), p.id, actor); }
                spaceEvent(q.spaceById.get(space.id), actor, 'deleted');
                return { deleted: true };
            });
        },

        roles(idOrSlug, actor) {
            const space = spaceOrFail(idOrSlug);
            if (!access.canManage(space, actor)) fail(403, 'space.forbidden', 'Only an owner sees the role list');
            return q.roles.all(space.id).map((r) => ({ subject: r.subject, role: r.role, granted_by: r.granted_by, granted_at: toIso(r.granted_at) }));
        },

        setRole(idOrSlug, subject, role, actor) {
            const space = spaceOrFail(idOrSlug);
            if (!access.canManage(space, actor)) fail(403, 'space.forbidden', 'Only an owner can change roles');
            if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject || ''))) fail(422, 'wiki.invalid_subject', 'Roles go to people: a usr_… subject id');
            if (role != null && !['owner', 'editor', 'viewer'].includes(role)) fail(422, 'wiki.invalid_role', 'role is owner, editor or viewer (or null to remove)');
            return tx(() => {
                const current = q.roles.all(space.id).find((r) => r.subject === subject);
                const losingOwner = current && current.role === 'owner' && role !== 'owner';
                if (losingOwner && space.kind === 'user' && q.owners.get(space.id).n <= 1) fail(409, 'space.last_owner', 'A user space keeps at least one owner');
                if (role == null) q.delRole.run(space.id, subject);
                else q.putRole.run(space.id, subject, role, actorId(actor), now());
                spaceEvent(space, actor, 'roles');
                return svc.roles(space.id, actor);
            });
        },

        // Pages ----------------------------------------------------------------------------
        tree(space, actor) {
            const pages = q.pagesOfSpace.all(space.id).filter((p) => access.canReadPage(space, p, actor));
            const byParent = new Map();
            for (const p of pages) {
                const k = p.parent_id && pages.some((x) => x.id === p.parent_id) ? p.parent_id : null;
                if (!byParent.has(k)) byParent.set(k, []);
                byParent.get(k).push(p);
            }
            const build = (parent, depth) => (byParent.get(parent) || []).map((p) => ({ page: p, depth, children: depth < 12 ? build(p.id, depth + 1) : [] }));
            return build(null, 0);
        },

        createPage(spaceIdOrSlug, { title, body, infobox = [], parentId = null, visibility = 'public', citations: cites = [], message = null, summary = null, authorship: importRecord = null } = {}, actor) {
            const space = spaceOrFail(spaceIdOrSlug);
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can create pages');
            // Only this service's own import path (the seed) may state another authorship; people are human authors.
            const rec = actor && actor.kind === 'system' && importRecord ? wrapContentError(() => authorship.record(importRecord)) : humanRecord(actor);
            // authorship.record() keeps label and original author only; the AI-assistance flag is ours.
            if (importRecord && rec.mode === 'imported' && importRecord.importedFrom && importRecord.importedFrom.aiAssisted === true) rec.importedFrom.aiAssisted = true;
            return insertPage(space, { title, body, infobox, parentId, visibility, citations: cites, message, summary }, actor, rec);
        },

        /**
         * Space import, step 1 (before any outbound call): who may import, and a strictly validated
         * bundle (server/wiki/import.js). Only an owner of the space, acting as a person. A space the
         * caller cannot read is "not found", exactly like everywhere else.
         */
        prepareImport(spaceIdOrSlug, input, actor) {
            const space = spaceOrFail(spaceIdOrSlug);
            if (!access.canReadSpace(space, actor)) fail(404, 'space.not_found', 'No such space');
            if (!access.canManage(space, actor)) fail(403, 'import.forbidden', 'Only an owner of this space imports pages into it');
            requirePerson(actor);
            return { space, bundle: importer.validateBundle(input) };
        },

        /**
         * Space import, step 2: every page of the bundle (citations already resolved) in ONE
         * transaction — any failure imports nothing, events included. Each page is created exactly
         * like one made by hand (same slug rule, sanitising renderer at view time, [[link]] and
         * citation records, wiki.revision.created, the importer watching it), as a draft unless the
         * bundle says publish (then the usual publication events and Search documents follow).
         * Authorship is `imported` with the importer as the accountable person; an AI-assisted bundle
         * stays noindex until a person reviews each page. Existing slugs: "fail" (409, nothing
         * imported) or "skip" (left alone, reported).
         */
        importPages(spaceIdOrSlug, bundle, actor) {
            const space = spaceOrFail(spaceIdOrSlug);
            if (!access.canManage(space, actor)) fail(403, 'import.forbidden', 'Only an owner of this space imports pages into it');
            const who = requirePerson(actor);
            const rec = wrapContentError(() => authorship.record({ mode: 'imported', authors: [who], importedFrom: { label: bundle.source || 'a page bundle', originalAuthor: bundle.originalAuthor || null } }));
            if (bundle.aiAssisted) rec.importedFrom.aiAssisted = true;
            return tx(() => {
                const existing = bundle.pages.map((p) => ({ p, page: q.pageBySlug.get(space.id, p.slug) })).filter((x) => x.page);
                if (existing.length && bundle.onExisting !== 'skip') {
                    fail(409, 'import.pages_exist', `Already in this space: ${existing.map((x) => x.p.slug).join(', ')}. Nothing was imported (import with on_existing "skip" to leave them alone)`, { slugs: existing.map((x) => x.p.slug) });
                }
                const skipped = existing.map((x) => ({ slug: x.p.slug, title: x.p.title, reason: x.page.state === 'deleted' ? 'deleted' : 'exists' }));
                const skip = new Set(skipped.map((x) => x.slug));
                const toCreate = new Set(bundle.pages.map((p) => p.slug).filter((sl) => !skip.has(sl)));
                const made = new Map();
                const created = [];
                let pending = bundle.pages.filter((p) => toCreate.has(p.slug));
                // Parents first: a page whose parent (in the bundle) is not created yet waits for the next pass.
                while (pending.length) {
                    const next = [];
                    for (const p of pending) {
                        let parentId = null;
                        if (p.parentSlug) {
                            if (toCreate.has(p.parentSlug) && !made.has(p.parentSlug)) { next.push(p); continue; }
                            const parent = made.get(p.parentSlug) || q.pageBySlug.get(space.id, p.parentSlug);
                            if (!parent || parent.state === 'deleted') fail(422, 'import.invalid_parent', `"${p.title}": its parent is neither in the bundle nor a page of this space`);
                            parentId = parent.id;
                        }
                        let out;
                        try {
                            out = insertPage(space, { ...p, parentId }, actor, rec);
                        } catch (err) {
                            if (err instanceof WikiError) fail(err.status, err.code, `"${p.title}": ${err.message}`, err.extra);
                            throw err;
                        }
                        made.set(p.slug, out.page);
                        created.push(out);
                    }
                    if (next.length === pending.length) fail(422, 'import.invalid_parent', `Parents form a loop: ${next.map((p) => p.title).join(', ')}`);
                    pending = next;
                }
                if (bundle.publish) for (const c of created) publishRevision(q.pageById.get(c.page.id), c.revision.number, actor);
                return { space, created: created.map((c) => ({ page: q.pageById.get(c.page.id), revision: c.revision })), skipped, published: !!bundle.publish };
            });
        },

        /**
         * New revision. keepCitations: 'all' (default) carries the base revision's citations
         * forward, an array keeps only those citation ids, 'none' drops them all (they stay on
         * the older revision). citations: new ones for this revision.
         */
        editPage(pageId, { expectedRevision, baseRevision = null, title, body, infobox, summary, citations: cites = [], keepCitations = 'all', message = null } = {}, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (page.state === 'deleted') fail(410, 'page.deleted', 'This page was deleted');
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can edit it');
            const rec = humanRecord(actor);
            if (!Number.isInteger(expectedRevision)) fail(422, 'revision.expected_required', 'expectedRevision (the revision you edited) is required');
            return tx(() => {
                const head = revisions.head(page.id);
                if (!head) fail(404, 'revision.not_found', 'This page has no revision');
                const text = body == null ? head.content : checkBody(body);
                const box = infobox === undefined ? (head.fields.infobox || []) : wrapContentError(() => content.normalizeInfobox(infobox));
                const fields = { title: title == null ? head.fields.title : checkTitle(title), summary: summary === undefined ? head.fields.summary || null : checkSummary(summary), infobox: box };
                const { revision, created } = wrapContentError(() => revisions.create({
                    entityId: page.id, expectedRevision, content: text, fields, meta: { authorship: rec }, author: actorId(actor), message,
                }));
                if (!created) return { page, revision, created: false };
                writeRevisionExtras(space, page, revision, box);
                // Citations come from the revision the editor started from (the head unless the
                // head is an AI proposal the editor chose not to build on).
                const from = baseRevision != null && revisions.get(page.id, Number(baseRevision)) ? Number(baseRevision) : head.number;
                carryCitations(page, from, revision.number, keepCitations, actor);
                attachCitationList(page, revision.number, cites, actor);
                db.prepare('UPDATE wiki_pages SET updated_at = ? WHERE id = ?').run(now(), page.id);
                revisionEvent(space, page, revision, actor);
                notifyWatchers(space, page, 'revised', revision.number, actor);
                return { page: q.pageById.get(page.id), revision, created: true };
            });
        },

        /** Revert = a new revision copying an old one (content, fields, citations, infobox). */
        revert(pageId, { toRevision, expectedRevision, message = null, publish = null } = {}, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (page.state === 'deleted') fail(410, 'page.deleted', 'This page was deleted');
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can revert');
            const who = requirePerson(actor);
            return tx(() => {
                const target = revisions.get(page.id, Number(toRevision));
                if (!target) fail(404, 'revision.not_found', `No revision ${toRevision}`);
                const trec = target.meta.authorship;
                // Restoring AI text keeps the AI workflow on record: the reverting person is accountable (hybrid).
                const rec = trec && (trec.mode === 'ai' || trec.mode === 'hybrid') && trec.workflow
                    ? authorship.record({ mode: 'hybrid', authors: [who], workflow: trec.workflow })
                    : authorship.record({ mode: 'human', authors: [who] });
                const { revision } = wrapContentError(() => revisions.revert({ entityId: page.id, toRevision: target.number, expectedRevision, author: who, message, meta: { authorship: rec } }));
                writeRevisionExtras(space, page, revision, target.fields.infobox || []);
                carryCitations(page, target.number, revision.number, 'all', actor);
                db.prepare('UPDATE wiki_pages SET updated_at = ? WHERE id = ?').run(now(), page.id);
                revisionEvent(space, page, revision, actor, { reverted_to: target.number });
                const livePage = q.pageById.get(page.id);
                const shouldPublish = publish == null ? livePage.state === 'published' : !!publish;
                if (shouldPublish) publishRevision(livePage, revision.number, actor);
                else notifyWatchers(space, livePage, 'revised', revision.number, actor);
                return { page: q.pageById.get(page.id), revision, published: shouldPublish };
            });
        },

        publish(pageId, { revision } = {}, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (page.state === 'deleted') fail(410, 'page.deleted', 'This page was deleted');
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can publish');
            if (!actor || actor.kind !== 'system') requirePerson(actor);
            return tx(() => {
                const n = revision == null ? revisions.headNumber(page.id) : Number(revision);
                const out = publishRevision(q.pageById.get(page.id), n, actor);
                return { page: q.pageById.get(page.id), ...out };
            });
        },

        unpublish(pageId, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can unpublish');
            if (page.state !== 'published') fail(409, 'page.not_published', 'The page is not published');
            return tx(() => {
                const b = before(page);
                db.prepare("UPDATE wiki_pages SET state = 'unpublished', updated_at = ? WHERE id = ?").run(now(), page.id);
                scheduler.cancelPending(page.id, 'unpublish');
                return { page: q.pageById.get(page.id), ...sync(b, page.id, actor) };
            });
        },

        /** Idempotent: the same (page, revision, time) returns the existing job. */
        schedulePublish(pageId, { revision, runAt } = {}, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (page.state === 'deleted') fail(410, 'page.deleted', 'This page was deleted');
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can schedule');
            requirePerson(actor);
            const at = typeof runAt === 'number' ? runAt : Date.parse(runAt);
            if (!Number.isFinite(at)) fail(422, 'schedule.invalid_time', 'runAt must be an ISO 8601 time');
            const n = revision == null ? revisions.headNumber(page.id) : Number(revision);
            if (!revisions.get(page.id, n)) fail(404, 'revision.not_found', `No revision ${n}`);
            return tx(() => {
                const { job, created } = scheduler.schedule({ entityId: page.id, action: 'publish', runAt: at, revision: n });
                if (page.state === 'draft' || page.state === 'unpublished') {
                    const b = before(page);
                    db.prepare("UPDATE wiki_pages SET state = 'scheduled', updated_at = ? WHERE id = ?").run(now(), page.id);
                    sync(b, page.id, actor);
                }
                return { job, created, page: q.pageById.get(page.id) };
            });
        },

        jobs(pageId) { return scheduler.jobs(pageId); },

        /** The worker: publishes due jobs. Re-running a job that already took effect changes nothing. */
        async runSchedule({ worker = config.workerId } = {}) {
            return scheduler.runDue({
                worker,
                handler: (job) => tx(() => {
                    const page = q.pageById.get(job.entityId);
                    if (!page || page.state === 'deleted') return { skipped: 'deleted' };
                    const space = q.spaceById.get(page.space_id);
                    if (!space || space.deleted_at) return { skipped: 'space_deleted' };
                    if (job.action === 'publish') {
                        if (page.state === 'published' && page.published_revision === job.revision) return { noop: true };
                        publishRevision(page, job.revision, { kind: 'system', service: 'svc:wiki', subject: null });
                        return { published: job.revision };
                    }
                    if (page.state !== 'published') return { noop: true };
                    const b = before(page);
                    db.prepare("UPDATE wiki_pages SET state = 'unpublished', updated_at = ? WHERE id = ?").run(now(), page.id);
                    sync(b, page.id, { kind: 'system', service: 'svc:wiki' });
                    return { unpublished: true };
                }),
            });
        },

        movePage(pageId, { slug, title, parentId } = {}, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (page.state === 'deleted') fail(410, 'page.deleted', 'This page was deleted');
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can move pages');
            return tx(() => {
                const b = before(page);
                let nextSlug = page.slug;
                if (slug != null || title != null) nextSlug = slug != null ? String(slug).trim().toLowerCase() : wrapContentError(() => content.pageSlug(checkTitle(title)));
                if (!content.PAGE_SLUG_RE.test(nextSlug)) fail(422, 'page.invalid_slug', 'A page slug is lowercase letters, digits and dashes');
                if (nextSlug !== page.slug) {
                    const clash = q.pageBySlug.get(space.id, nextSlug);
                    if (clash) fail(409, 'page.slug_taken', `A page "${nextSlug}" already exists in this space`);
                    redirects.recordMove(page.id, `/w/${space.slug}/${page.slug}`, `/w/${space.slug}/${nextSlug}`);
                }
                let parent = page.parent_id;
                if (parentId !== undefined) {
                    parent = parentId || null;
                    for (let p = parent ? q.pageById.get(parent) : null, i = 0; p; p = p.parent_id ? q.pageById.get(p.parent_id) : null, i++) {
                        if (p.id === page.id || i > 50) fail(422, 'page.invalid_parent', 'A page cannot be moved under itself');
                        if (p.space_id !== space.id) fail(422, 'page.invalid_parent', 'The parent must be a page of the same space');
                    }
                }
                db.prepare('UPDATE wiki_pages SET slug = ?, parent_id = ?, updated_at = ? WHERE id = ?').run(nextSlug, parent, now(), page.id);
                sync(b, page.id, actor);
                return q.pageById.get(page.id);
            });
        },

        setPageVisibility(pageId, { visibility, noindex } = {}, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (!access.canManage(space, actor)) fail(403, 'page.forbidden', 'Only an owner of this space changes page visibility');
            return tx(() => {
                const b = before(page);
                db.prepare('UPDATE wiki_pages SET visibility = ?, noindex = ?, updated_at = ? WHERE id = ?')
                    .run(checkVisibility(visibility, page.visibility), noindex == null ? page.noindex : (noindex ? 1 : 0), now(), page.id);
                return { page: q.pageById.get(page.id), ...sync(b, page.id, actor) };
            });
        },

        deletePage(pageId, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (!access.canManage(space, actor)) fail(403, 'page.forbidden', 'Only an owner of this space can delete pages');
            if (page.state === 'deleted') return { page, action: null };
            return tx(() => {
                const b = before(page);
                db.prepare("UPDATE wiki_pages SET state = 'deleted', updated_at = ? WHERE id = ?").run(now(), page.id);
                db.prepare('UPDATE wiki_pages SET parent_id = ? WHERE parent_id = ?').run(page.parent_id, page.id);
                scheduler.cancelPending(page.id);
                return { page: q.pageById.get(page.id), ...sync(b, page.id, actor) };
            });
        },

        // Reading --------------------------------------------------------------------------
        /** The page as `actor` may see it; revision defaults to the published one (editors: head of a draft). */
        view(space, page, actor, { revision } = {}) {
            if (!access.canReadPage(space, page, actor)) fail(404, 'page.not_found', 'No such page');
            const canEdit = access.canEdit(space, actor);
            let n = revision == null ? (page.state === 'published' ? page.published_revision : revisions.headNumber(page.id)) : Number(revision);
            if (!Number.isInteger(n) || !revisionVisible(space, page, n, actor)) fail(404, 'revision.not_found', 'No such revision');
            const rev = revisions.get(page.id, n);
            if (!rev) fail(404, 'revision.not_found', 'No such revision');
            n = rev.number;
            const review = reviews.latest(page.id, n);
            const rec = rev.meta.authorship || null;
            const decision = page.state === 'published' && n === page.published_revision ? decide(space, page, rev) : seo.evaluate({ ...gateFacts(space, page, rev), state: page.state === 'published' ? 'draft' : page.state }, { policy, now: now() });
            return {
                space, page, revision: rev, decision, canEdit, canManage: access.canManage(space, actor),
                isPublishedRevision: n === page.published_revision && page.state === 'published',
                authorship: rec, review, disclosure: rec ? disclosureFor(rec, review) : null,
                needsReview: !!rec && aiAssistedImport(rec) && !authorship.isReviewed(rec, review),
                proposal: q.proposalByRev.get(page.id, n) || null,
                infobox: infoboxOf(page.id, n),
                citations: citations.forRevision(page.id, n),
                links: q.linksOf.all(page.id, n),
                attachments: svc.attachmentsOf(page.id),
                children: q.children.all(page.id).filter((c) => access.canReadPage(space, c, actor)),
                parent: page.parent_id ? (() => { const p = q.pageById.get(page.parent_id); return p && access.canReadPage(space, p, actor) ? p : null; })() : null,
                backlinks: svc.backlinks(space, page, actor),
                discussion: discussions.get(page.id),
                watching: actor && actor.subject ? !!q.isWatching.get(page.id, actor.subject) : false,
                pendingProposals: canEdit ? q.proposalsOfPage.all(page.id).filter((p) => p.status === 'pending') : [],
                jobs: canEdit ? scheduler.jobs(page.id).filter((j) => j.status === 'pending' || j.status === 'running') : [],
                headNumber: canEdit ? revisions.headNumber(page.id) : null,
            };
        },

        backlinks(space, page, actor) {
            return q.backlinks.all(space.slug, page.slug).filter((p) => p.id !== page.id).map((p) => ({ page: p, space: q.spaceById.get(p.space_id) }))
                .filter(({ page: p, space: s }) => access.canReadPage(s, p, actor));
        },

        /** [[link]] target → { href, exists }. Pages the actor cannot read look missing. */
        resolveLink({ space: spaceSlug, slug, title }, actor) {
            const space = q.spaceBySlug.get(spaceSlug);
            if (!space || space.deleted_at || !access.canReadSpace(space, actor)) return { href: null, exists: false };
            let page = q.pageBySlug.get(space.id, slug);
            if (!page) {
                const r = redirects.resolve(`/w/${space.slug}/${slug}`, { currentPath: (id) => { const p = q.pageById.get(id); return p && p.state !== 'deleted' ? pagePath(q.spaceById.get(p.space_id), p) : null; } });
                if (r && r.status === 301) { const moved = q.pageById.get(r.entityId); if (moved) page = moved; }
            }
            if (page && page.state === 'published' && access.canReadPage(q.spaceById.get(page.space_id), page, actor)) {
                return { href: pagePath(q.spaceById.get(page.space_id), page), exists: true };
            }
            if (!page && access.canEdit(space, actor)) return { href: `/w/${encodeURIComponent(space.slug)}/${encodeURIComponent(slug)}/edit?title=${encodeURIComponent(title || slug)}`, exists: false };
            return { href: null, exists: false };
        },

        /**
         * Markdown → safe HTML. Outbound links in community (user) spaces carry rel="nofollow ugc":
         * nobody vouches for them, so they pass no ranking (link spam gains nothing). Official spaces
         * are edited by staff, who vouch for their links.
         */
        renderRevision(space, rev, actor) {
            return content.renderContent(rev.content, { currentSpace: space.slug, resolve: (t) => svc.resolveLink(t, actor), rel: svc.linkRel(space) });
        },

        linkRel(space) { return space && space.kind === 'official' ? 'noopener' : 'nofollow ugc noopener'; },

        history(page, { limit = 100, before: cursor, actor = { kind: 'system' } } = {}) {
            const props = new Map(q.proposalsOfPage.all(page.id).map((p) => [p.revision, p]));
            const space = q.spaceById.get(page.space_id);
            return revisions.list(page.id, { limit, before: cursor }).filter((r) => revisionVisible(space, page, r.number, actor)).map((r) => ({
                ...r, proposal: props.get(r.number) || null, published: page.state === 'published' && r.number === page.published_revision,
                review: reviews.latest(page.id, r.number),
                aiAssisted: aiAssistedImport(r.meta && r.meta.authorship),
                needsReview: aiAssistedImport(r.meta && r.meta.authorship) && !authorship.isReviewed(r.meta.authorship, reviews.latest(page.id, r.number)),
                citationCount: citations.forRevision(page.id, r.number).length,
            }));
        },

        diff(page, a, b, { mode = 'word', actor = { kind: 'system' } } = {}) {
            const space = q.spaceById.get(page.space_id);
            for (const n of [Number(a), Number(b)]) if (!Number.isInteger(n) || !revisionVisible(space, page, n, actor)) fail(404, 'revision.not_found', 'No such revision');
            return wrapContentError(() => revisions.diff(page.id, Number(a), Number(b), { mode: mode === 'line' ? 'line' : 'word' }));
        },

        resolveRedirect(path) {
            return redirects.resolve(path, {
                currentPath: (id) => {
                    if (/^spc_/.test(id)) { const s = q.spaceById.get(id); return s && !s.deleted_at ? spacePath(s) : null; }
                    const p = q.pageById.get(id);
                    if (!p || p.state === 'deleted') return null;
                    const s = q.spaceById.get(p.space_id);
                    return s && !s.deleted_at ? pagePath(s, p) : null;
                },
            });
        },

        search(text, actor, { space = null, limit = 20 } = {}) {
            const words = String(text || '').trim().slice(0, 200);
            if (!words) return [];
            const like = `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            const out = [];
            for (const p of q.search.all({ like, space })) {
                const s = q.spaceById.get(p.space_id);
                if (!access.canReadPage(s, p, actor)) continue;
                const rev = revisions.get(p.id, p.published_revision);
                out.push({ page: p, space: s, summary: rev.fields.summary || ssr.markdownToText(rev.content, 200) });
                if (out.length >= Math.min(50, Math.max(1, Number(limit) || 20))) break;
            }
            return out;
        },

        // Discovery (public, indexable only) -----------------------------------------------
        publishedPublic() {
            return q.allPublishedPublic.all().map((page) => {
                const space = q.spaceById.get(page.space_id);
                const rev = revisions.get(page.id, page.published_revision);
                return { space, page, rev, decision: decide(space, page, rev) };
            });
        },

        recentChanges(limit = 50) {
            return q.recent.all(Math.min(200, Math.max(1, limit))).map((page) => {
                const space = q.spaceById.get(page.space_id);
                const rev = revisions.get(page.id, page.published_revision);
                return { space, page, rev, decision: decide(space, page, rev) };
            });
        },

        // Citations and media ----------------------------------------------------------------
        /** Citations go on an unpublished head revision (a published revision's sources are fixed). */
        attachCitations(pageId, revisionNumber, list, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can cite');
            const n = Number(revisionNumber);
            if (n !== revisions.headNumber(page.id)) fail(409, 'citation.not_head', 'Citations are attached to the newest revision; edit the page to cite in a new one');
            if (page.state === 'published' && page.published_revision === n) fail(409, 'citation.revision_published', 'That revision is published; its sources are fixed. Edit the page to add sources to a new revision');
            return tx(() => attachCitationList(page, n, list, actor));
        },

        citationsOf(page, revisionNumber) { return citations.forRevision(page.id, Number(revisionNumber)); },

        /**
         * The citation inspector: one revision's sources (the published one by default) with their
         * retrieval times, where each was first cited, and how the list changed from the previous
         * revision the actor may read (kept, new, restored from an older revision, dropped). Same
         * read rules as the article (view() refuses what the actor may not see); an origin revision
         * the actor may not read is not named.
         */
        citationInspector(space, page, actor, { revision } = {}) {
            const v = svc.view(space, page, actor, { revision });
            const n = v.revision.number;
            const readable = svc.history(page, { limit: 500, actor });
            const visible = new Set(readable.map((r) => r.number));
            const lineage = (c) => c.carriedFrom || c.id;
            const prev = readable.find((r) => r.number < n) || null;
            const prevCites = prev ? citations.forRevision(page.id, prev.number) : [];
            const prevLines = new Set(prevCites.map(lineage));
            const items = v.citations.map((c) => {
                const first = c.carriedFrom ? citations.get(c.carriedFrom) : c;
                const shown = first && visible.has(first.revision) ? first : null;
                const change = prevLines.has(lineage(c)) ? 'kept' : (c.carriedFrom ? 'restored' : 'new');
                return { ...c, change, firstRevision: shown ? shown.revision : null, firstAttachedAt: shown ? shown.attachedAt : null };
            });
            const here = new Set(v.citations.map(lineage));
            return {
                view: v, citations: items,
                previous: prev ? prev.number : null,
                dropped: prevCites.filter((c) => !here.has(lineage(c))),
                revisions: readable.map((r) => ({ number: r.number, createdAt: r.createdAt, citationCount: r.citationCount, published: r.published })),
            };
        },
        citationHistory(page) { return citations.history(page.id); },

        /**
         * MEDIA ATTACHMENTS ACROSS AUTHORS AND EDITORS. OpenVibe.Media owns an object's read rights:
         * public and unlisted objects are readable by anyone, a private one only by its owner (the
         * rule Media applies to an app acting for one of its users). Wiki reads Media with its own
         * authority, which sees the whole namespace, so it applies that rule itself:
         *
         *  1. Attaching is done by a person (an editor of the space, or a service acting for one), and
         *     the object must be readable by that person: it exists, is not deleted, and is public,
         *     unlisted or theirs. Anything else — missing, deleted, someone else's private object —
         *     gets one answer (media.not_readable), so an id is never confirmed to exist.
         *  2. A page shows its attachments to every reader of the page, and Wiki never re-shares an
         *     object under its own authority, so a private object is refused even for its owner
         *     (media.private: share it in Media first). Only public and unlisted objects are attached.
         *  3. The attachment belongs to the page (every revision), with a record of who attached it
         *     and what Media said then (wiki_attachment_origins). Editors who revise, revert or publish
         *     later do not need read rights on existing attachments and never re-attach them: what was
         *     checked is the attacher's grant. A later editor can detach an attachment, and attaches
         *     new objects under rule 1 with their own rights.
         *  4. Media stays the authority afterwards: the check (verifyMedia, periodic when Media is
         *     configured) marks an object that was deleted broken ('deleted'), and one that is missing
         *     or became private broken ('not_found' / 'forbidden'). A broken attachment renders an
         *     explicit placeholder, never an image; it is shown again when Media shares it again.
         *
         * describe(mediaId) is platform.media.describe. A Media outage refuses the attachment (503):
         * nothing is attached unchecked.
         */
        async attachMedia(pageId, { mediaId, alt = null, caption = null, role = 'inline' } = {}, actor, { describe } = {}) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (page.state === 'deleted') fail(410, 'page.deleted', 'This page was deleted');
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can attach media');
            const who = actor && actor.kind === 'system' ? null : requirePerson(actor);
            const id = String(mediaId || '').trim();
            if (!isMediaId(id)) fail(400, 'media.invalid_id', 'mediaId must be a Media object id (med_<ULID> or legacy:<app>:<kind>:<id>)');
            if (typeof describe !== 'function') fail(503, 'media.unavailable', 'Attachments are checked against OpenVibe.Media, which is not configured here: nothing was attached');
            let obj;
            try { obj = await describe(id); } catch (err) {
                fail(503, 'media.unavailable', `Attachments are checked against OpenVibe.Media, which could not answer (${err && err.message}): nothing was attached`);
            }
            if (obj && obj.exists && !['public', 'unlisted', 'private'].includes(obj.visibility)) fail(503, 'media.unavailable', 'OpenVibe.Media did not say who may read that object: nothing was attached');
            const readable = !!(obj && obj.exists && (obj.visibility !== 'private' || (who && obj.owner === who)));
            if (!readable) fail(422, 'media.not_readable', 'No OpenVibe.Media object you can read has that id');
            if (obj.visibility === 'private') fail(409, 'media.private', 'That object is private in OpenVibe.Media. Every reader of a wiki page sees its media, so make the object unlisted or public in Media first');
            if (obj.status && obj.status !== 'ready') fail(409, 'media.not_ready', `That object is ${obj.status} in OpenVibe.Media, not ready yet`);
            return tx(() => {
                const att = wrapContentError(() => attachments.attach({ entityId: page.id, mediaId: id, alt, caption, role }));
                q.insertOrigin.run(att.id, page.id, id, actorId(actor), obj.owner || null, obj.visibility, now());
                attachments.markAvailable(id);
                return svc.attachmentsOf(page.id).find((a) => a.id === att.id);
            });
        },

        /** A page's attachments, each with who attached it (null for rows older than the record). */
        attachmentsOf(pageId) {
            const origins = new Map(q.originsOf.all(pageId).map((o) => [o.attachment_id, o]));
            return attachments.list(pageId).map((a) => {
                const o = origins.get(a.id);
                return { ...a, attachedBy: o ? o.attached_by : null, mediaVisibilityAtAttach: o ? o.media_visibility : null };
            });
        },

        detachMedia(pageId, attachmentId, actor) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            if (!access.canEdit(space, actor)) fail(403, 'page.forbidden', 'Only editors of this space can detach media');
            return attachments.detach(page.id, attachmentId);
        },

        markMediaBroken(mediaId, reason) { return attachments.markBroken(mediaId, reason); },

        /** Check every attachment against Media; outages change nothing (check_failed). */
        async verifyMedia(pageId, resolve) { return attachments.verify(pageId, { resolve }); },

        async verifyAllMedia(resolve) {
            const ids = db.prepare('SELECT DISTINCT entity_id FROM wiki_page_attachments').all().map((r) => r.entity_id);
            const out = [];
            for (const id of ids) out.push(...await attachments.verify(id, { resolve }));
            return out;
        },

        // Discussion -------------------------------------------------------------------------
        /** The Community thread of a public, published page (resolved once, then stored as a reference). */
        async discussionThread(space, page, client) {
            const known = discussions.get(page.id);
            if (known) return known.threadId;
            if (page.state !== 'published' || access.effectiveVisibility(space, page) !== 'public') return null;
            const out = await discussions.threadFor(page.id, { service: 'wiki', type: 'page', id: page.id, label: page.title.slice(0, 200) }, { client });
            return out.threadId;
        },

        // Watchers ---------------------------------------------------------------------------
        watch(pageId, actor, on = true) {
            const page = pageOrFail(pageId);
            const space = spaceOrFail(page.space_id);
            const who = requirePerson(actor);
            if (!access.canReadPage(space, page, actor)) fail(404, 'page.not_found', 'No such page');
            if (on) q.watch.run(page.id, who, now()); else q.unwatch.run(page.id, who);
            return { watching: on };
        },

        /**
         * Re-send Search whatever differs from what it was last sent, for every page (idempotent: the
         * sequencer sends nothing for an unchanged document). Run at boot, so a rule change — e.g.
         * AI-assisted imports becoming noindex until reviewed — reaches Search for rows written earlier.
         */
        reconcileIndex() {
            return tx(() => {
                let sent = 0;
                for (const { id } of db.prepare('SELECT id FROM wiki_pages ORDER BY id').all()) {
                    const b = before(q.pageById.get(id));
                    if (b.indexRevision == null) continue; // never sent: nothing in Search to correct
                    const out = sync(b, id, { kind: 'system', service: 'svc:wiki' });
                    if (out.indexRevision !== b.indexRevision) sent++;
                }
                return { sent };
            });
        },

        /**
         * A person reviews an existing revision ("reviewed, correct" = approved / "needs changes" =
         * rejected). Recorded in the append-only review log; when it is the published revision the
         * gate is re-evaluated, and a changed Search document goes out with wiki.page.updated.
         * Pending AI proposals are reviewed through reviewProposal instead.
         */
        reviewRevision(spaceIdOrSlug, slug, revisionNumber, { decision, note = null } = {}, actor) {
            const space = spaceOrFail(spaceIdOrSlug);
            const page = q.pageBySlug.get(space.id, String(slug));
            if (!page || page.state === 'deleted') fail(404, 'page.not_found', 'No such page');
            if (!access.canEdit(space, actor)) fail(403, 'review.forbidden', 'Only owners and editors of this space review revisions');
            const who = requirePerson(actor);
            if (decision !== 'approved' && decision !== 'rejected') fail(422, 'review.invalid_decision', 'decision is approved or rejected');
            const n = Number(revisionNumber);
            if (!Number.isInteger(n) || !revisions.get(page.id, n)) fail(404, 'revision.not_found', `No revision ${revisionNumber}`);
            const prop = q.proposalByRev.get(page.id, n);
            if (prop && prop.status === 'pending') fail(409, 'review.proposal_pending', 'This revision is a pending AI proposal: approve or reject the proposal', { proposal_id: prop.id });
            return tx(() => {
                const b = before(page);
                const review = wrapContentError(() => reviews.record({ entityId: page.id, revision: n, reviewer: who, decision, note }));
                const out = page.state === 'published' && page.published_revision === n
                    ? sync(b, page.id, actor, { updatedIfIndexChanged: true })
                    : { action: null, indexRevision: b ? b.indexRevision : null };
                const fresh = q.pageById.get(page.id);
                const rev = revisions.get(page.id, n);
                const decisionNow = fresh.state === 'published' && fresh.published_revision === n ? decide(space, fresh, rev) : null;
                return { review, page: fresh, action: out.action, indexable: decisionNow ? decisionNow.indexable : null, reasons: decisionNow ? decisionNow.codes : null };
            });
        },

        // AI proposals (a seam for OpenVibe.AI: Wiki never calls a model) -------------------
        /**
         * An AI workflow proposes a revision. It becomes an immutable revision with ai authorship
         * (workflow + run id) and a pending proposal; nothing is published until a person approves.
         * pageId null + title = propose a new page (created as a draft).
         */
        propose({ space: spaceIdOrSlug, pageId = null, title, body, infobox = [], summary = null, citations: cites = [], workflow, stubProvider = false, expectedRevision, note = null } = {}, actor) {
            // A proposal may target any space, private ones included, and never needs a person: only
            // first-party services (svc:…, i.e. OpenVibe.AI) file them, never a developer app or module.
            const firstParty = actor && actor.kind === 'service' && /^svc:/.test(String(actor.service)) && (!actor.claims || actor.claims.actor_type === 'service');
            if (!actor || (actor.kind !== 'system' && !firstParty)) fail(403, 'proposal.service_only', 'AI proposals come from a first-party service principal');
            if (!workflow || !workflow.id || !workflow.runId) fail(400, 'authorship.workflow_required', 'An AI proposal names its OpenVibe.AI workflow (workflow.id) and run (workflow.run_id)');
            const rec = wrapContentError(() => authorship.record({ mode: 'ai', workflow, stubProvider: !!stubProvider }));
            const cleanSummary = checkSummary(summary);
            const text = checkBody(body == null ? '' : body);
            const box = wrapContentError(() => content.normalizeInfobox(infobox));
            return tx(() => {
                let page = pageId ? pageOrFail(pageId) : null;
                const space = page ? spaceOrFail(page.space_id) : spaceOrFail(spaceIdOrSlug);
                const t = now();
                let base = 0;
                if (!page) {
                    const cleanTitle = checkTitle(title);
                    const slug = wrapContentError(() => content.pageSlug(cleanTitle));
                    if (q.pageBySlug.get(space.id, slug)) fail(409, 'page.slug_taken', `A page "${slug}" already exists in this space`);
                    const id = pageIdNew(t);
                    q.insertPage.run({ id, space_id: space.id, slug, title: cleanTitle, parent_id: null, position: 0, visibility: 'public', created_by: actorId(actor), now: t });
                    page = q.pageById.get(id);
                } else {
                    if (page.state === 'deleted') fail(410, 'page.deleted', 'This page was deleted');
                    base = revisions.headNumber(page.id);
                    if (expectedRevision != null && Number(expectedRevision) !== base) fail(412, 'revision.conflict', `Revision conflict: expected ${expectedRevision}, current is ${base}`, { expected: Number(expectedRevision), current: base });
                }
                const head = base ? revisions.head(page.id) : null;
                const fields = { title: title ? checkTitle(title) : (head ? head.fields.title : page.title), summary: cleanSummary, infobox: box };
                const { revision } = wrapContentError(() => revisions.create({
                    entityId: page.id, expectedRevision: base, content: text, fields, meta: { authorship: rec }, author: actorId(actor),
                    message: note ? `AI proposal: ${String(note).slice(0, 200)}` : 'AI proposal', allowUnchanged: true,
                }));
                writeRevisionExtras(space, page, revision, box);
                attachCitationList(page, revision.number, cites, actor);
                const id = proposalIdNew(t);
                q.insertProposal.run({ id, page_id: page.id, space_id: space.id, revision: revision.number, base_revision: base, workflow_id: rec.workflow.id, run_id: rec.workflow.runId, stub_provider: rec.stubProvider ? 1 : 0, proposed_by: actorId(actor), note: note == null ? null : String(note).slice(0, 2000), now: t });
                revisionEvent(space, page, revision, actor, { proposal_id: id });
                notifyWatchers(space, page, 'proposed', revision.number, actor);
                return { proposal: q.proposal.get(id), page: q.pageById.get(page.id), revision };
            });
        },

        proposals(pageId) { return q.proposalsOfPage.all(pageFor(pageId).id); },
        pendingProposals(actor) {
            return q.pendingProposals.all().filter((p) => access.canEdit(q.spaceById.get(p.space_id), actor));
        },
        getProposal(id) { return q.proposal.get(String(id)) || null; },

        /** A person approves (and by default publishes) or rejects an AI proposal. */
        reviewProposal(id, { decision, note = null, publish = true } = {}, actor) {
            const p = q.proposal.get(String(id));
            if (!p) fail(404, 'proposal.not_found', 'No such proposal');
            const space = spaceOrFail(p.space_id);
            if (!access.canEdit(space, actor)) fail(403, 'proposal.forbidden', 'Only editors of this space review proposals');
            const who = requirePerson(actor);
            if (decision !== 'approved' && decision !== 'rejected') fail(422, 'proposal.invalid_decision', 'decision is approved or rejected');
            if (p.status !== 'pending') fail(409, 'proposal.already_reviewed', `This proposal was already ${p.status}`);
            return tx(() => {
                reviews.record({ entityId: p.page_id, revision: p.revision, reviewer: who, decision, note });
                q.reviewProposal.run({ id: p.id, status: decision, by: who, note: note == null ? null : String(note).slice(0, 2000), now: now() });
                let published = null;
                if (decision === 'approved' && publish) published = publishRevision(q.pageById.get(p.page_id), p.revision, actor);
                return { proposal: q.proposal.get(p.id), published: !!published };
            });
        },
    };

    function pageFor(id) { return pageOrFail(id); }

    return svc;
}

module.exports = { createWikiService, WikiError, GATE_VIS, aiAssistedImport };
