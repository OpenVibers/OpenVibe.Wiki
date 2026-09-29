'use strict';
/**
 * Server-rendered pages. Everything a reader or an editor does works with plain links and HTML
 * form posts; the shared navbar is progressive enhancement.
 *
 *   GET  /                              spaces + recently published
 *   GET  /recent, /search?q=
 *   GET|POST /new-space
 *   GET  /s/:space                      the page tree
 *   GET|POST /s/:space/new              new page (?title= prefill, from a red link)
 *   GET|POST /s/:space/settings         owner: settings, roles, delete
 *   GET|POST /s/:space/import           owner: import a JSON bundle of pages (all or nothing)
 *   GET  /s/:space/proposals            editors: AI proposals to review;  POST /proposals/:id
 *   GET  /w/:space/:slug                the article (?rev=N for an old revision)
 *   GET  /w/:space/:slug.json           the same data as JSON (same visibility rules)
 *   GET  /w/:space/:slug/history        every revision; /compare?a&b → /diff/:a/:b
 *   GET  /w/:space/:slug/sources        citation inspector (?rev=N; default the published revision)
 *   GET  /w/:space/:slug/diff/:a/:b     word (default) or ?mode=line diff
 *   GET|POST /w/:space/:slug/edit       edit form (preview / save / save and publish)
 *   GET|POST /w/:space/:slug/revert     revert as a new revision
 *   GET  /w/:space/:slug/publish?rev=   confirm publishing an older revision
 *   GET|POST /w/:space/:slug/settings   publish, schedule, unpublish, move, media, visibility, delete
 *   POST /w/:space/:slug/watch, /discuss, /review (a person reviews an AI-assisted revision)
 *
 * Caching: an anonymous view of a public, published page is `public, max-age=60`; everything
 * else (signed-in views, members/private pages, editing surfaces, errors) is `private, no-store`.
 * A page a visitor may not read answers 404 (not 403), so its existence does not leak.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const { renderPage } = require('../render/layout');
const views = require('../render/views');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const content = require('../wiki/content');
const { actorMiddleware, resolveCitations, resolveBundleCitations, citationsFromForm } = require('./common');
const importer = require('../wiki/import');

function createPages({ svc, viewers, platform, config, log = console, limits }) {
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '600kb' });
    router.use(actorMiddleware(viewers, { services: false }));
    // Per-actor limits on the editing forms (http/actor-limits.js): each form shares its budget with the
    // API route that does the same thing, counted before the form body is read. Reading pages is left
    // to the per-address limits.
    const B = (name) => limits.budget(name);

    // VIP (WS-K task 8): before any handler's synchronous access check, ask VIP about the space and page this
    // URL names (and a space's VIP-only pages, for its tree). The JSON export is sensitive: VIP asks Billing.
    router.param('space', (req, res, next, ref) => {
        (async () => {
            const space = await svc.findSpace(ref);
            if (!space || space.deleted_at || !req.actor || !req.actor.subject) return;
            const page = req.params.slug ? await svc.findPage(space.id, req.params.slug) : null;
            const pairs = [{ space }, ...(page ? [{ space, page }] : (await svc.vipPagesOf(space.id)).map((p) => ({ space, page: p })))];
            await svc.access.prepareVip(req.actor, pairs, { sensitive: /\.json$/.test(req.path) });
        })().then(() => next(), next);
    });

    const origin = new URL(config.baseUrl).origin;
    // Cross-site form posts are refused (the session cookie is SameSite=Lax as well).
    router.use((req, res, next) => {
        if (req.method !== 'POST') return next();
        const o = req.get('origin');
        if (o && o !== origin && o !== 'null') return res.status(403).type('text/plain').set('Cache-Control', 'private, no-store').send('Cross-site form posts are not accepted.');
        next();
    });

    const send = (req, res, status, body, o = {}) => {
        const cacheable = o.cache === 'public' && req.actor.kind === 'anonymous' && status === 200;
        res.status(status).set('Cache-Control', cacheable ? 'public, max-age=60' : 'private, no-store').set('Vary', 'Cookie, Authorization').type('html')
            .send(renderPage({ config, actor: req.actor, path: o.path || req.path, ...o, body }));
    };
    const errorPage = (req, res, status, title, message) => send(req, res, status, views.errorBody({ status, title, message }), { title, robots: 'noindex, nofollow' });
    const notFound = (req, res) => errorPage(req, res, 404, 'Page not found', 'Nothing lives at that address, or it is not visible to you.');
    const gone = (req, res) => errorPage(req, res, 410, 'Gone', 'This page was deleted. Its history is kept, but it is no longer published.');
    // VIP (WS-K task 8): the join prompt for a VIP space or page the viewer is not admitted to (403, never cached).
    const vipGate = (req, res, space, page) => {
        const r = svc.access.vipRefusal(space, page, req.actor);
        if (!r) return false;
        send(req, res, 403, views.vipGateBody({ title: page ? page.title : space.name, spaceName: space.name, joinUrl: r.joinUrl, signedIn: !!req.actor.subject, signInUrl: `/auth/login?next=${encodeURIComponent(req.originalUrl)}` }), { title: 'For VIP members', robots: 'noindex, nofollow' });
        return true;
    };
    const needSignIn = (req, res, message) => send(req, res, 401, views.signInPage({ next: req.originalUrl, message }), { title: 'Sign in', robots: 'noindex, nofollow' });
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err && err.status && err.status < 500) return errorPage(req, res, err.status, 'That did not work', err.message);
        next(err);
    });

    /** Resolve :space/:slug; follows history-aware redirects (301) and reports deleted pages (410). */
    async function locate(req, res, suffix = '') {
        const space = await svc.findSpace(req.params.space);
        const page = space && !space.deleted_at ? await svc.findPage(space.id, req.params.slug) : null;
        if (page && page.state === 'deleted') { gone(req, res); return null; }
        if (!page) {
            const r = await svc.resolveRedirect(`/w/${req.params.space}/${req.params.slug}`);
            if (r && r.status === 301) { res.set('Cache-Control', 'public, max-age=300').redirect(301, r.location + suffix + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')); return null; }
            if ((r && r.status === 410) || (space && space.deleted_at)) { gone(req, res); return null; }
            notFound(req, res);
            return null;
        }
        if (!svc.access.canReadPage(space, page, req.actor)) { if (page.state !== 'published' || !vipGate(req, res, space, page)) notFound(req, res); return null; }
        return { space, page };
    }

    async function locateSpace(req, res) {
        const space = await svc.findSpace(req.params.space);
        if (!space || space.deleted_at) {
            const r = await svc.resolveRedirect(`/s/${req.params.space}`);
            if (r && r.status === 301) { res.redirect(301, r.location + req.path.replace(/^\/s\/[^/]+/, '')); return null; }
            if ((r && r.status === 410) || (space && space.deleted_at)) { gone(req, res); return null; }
            notFound(req, res);
            return null;
        }
        if (!svc.access.canReadSpace(space, req.actor)) { if (!vipGate(req, res, space, null)) notFound(req, res); return null; }
        return space;
    }

    // ── Home, recent, search ─────────────────────────────────
    router.get('/', wrap(async (req, res) => {
        if (req.actor.subject) await svc.access.prepareVip(req.actor, (await svc.vipSpaces()).map((space) => ({ space })));   // VIP spaces the viewer may see
        const [spaces, recent] = await Promise.all([svc.listSpaces(req.actor), svc.recentChanges(10)]);
        send(req, res, 200, views.home({ spaces, recent, actor: req.actor }) + frame.shipped({ service: 'wiki', title: 'Recently shipped on OpenVibe.Wiki' }), {
            robots: 'index, follow', cache: 'public', active: 'home', path: '/', styles: [showcase.STYLESHEET],
            jsonLd: seo.structuredData.webPage({ url: `${config.baseUrl}/`, name: 'OpenVibe.Wiki', description: 'Wiki spaces of the OpenVibe network.' }),
        });
    }));
    // What shipped on OpenVibe.Wiki: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(req, res, 200, frame.updatesBody({ service: 'wiki', siteName: 'OpenVibe.Wiki' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`, { title: 'What shipped on OpenVibe.Wiki', robots: 'index, follow', cache: 'public', path: '/updates' }));
    router.get('/recent', wrap(async (req, res) => send(req, res, 200, views.recentPage({ items: await svc.recentChanges(100) }), { title: 'Recent changes', robots: 'noindex, follow', cache: 'public', active: 'recent' })));
    router.get('/search', wrap(async (req, res) => {
        const query = String(req.query.q || '').slice(0, 200);
        send(req, res, 200, views.searchPage({ query, results: query ? await svc.search(query, req.actor) : [] }), { title: query ? `Search: ${query}` : 'Search', robots: 'noindex, follow', query, active: 'search' });
    }));

    // ── Spaces ───────────────────────────────────────────────
    router.get('/new-space', (req, res) => {
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to start a space.');
        send(req, res, 200, views.newSpacePage({ staff: req.actor.staff }), { title: 'Start a space', robots: 'noindex, nofollow' });
    });
    router.post('/new-space', B('wiki.space.create'), form, wrap(async (req, res) => {
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in with your OpenVibe account to start a space.');
        const b = req.body || {};
        try {
            const space = await svc.createSpace({ name: b.name, slug: b.slug || null, description: b.description || null, visibility: b.visibility, kind: b.official === '1' && req.actor.staff ? 'official' : 'user' }, req.actor);
            res.redirect(303, `/s/${encodeURIComponent(space.slug)}`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            send(req, res, err.status, views.newSpacePage({ values: b, error: err.message, staff: req.actor.staff }), { title: 'Start a space', robots: 'noindex, nofollow' });
        }
    }));

    router.get('/s/:space', wrap(async (req, res) => {
        const space = await locateSpace(req, res);
        if (!space) return;
        const canEdit = svc.access.canEdit(space, req.actor);
        const proposals = canEdit ? (await svc.pendingProposals(req.actor)).filter((p) => p.space_id === space.id) : [];
        const open = space.visibility === 'public';
        send(req, res, 200, views.spacePage({ space, tree: await svc.tree(space, req.actor), canEdit, canManage: svc.access.canManage(space, req.actor), proposals }), {
            title: space.name, description: space.description || `${space.name}: a space on OpenVibe.Wiki.`, path: svc.spacePath(space),
            robots: open ? 'index, follow' : 'noindex, nofollow', cache: open ? 'public' : null,
            jsonLd: open ? seo.structuredData.breadcrumbs([{ name: 'Wiki', url: `${config.baseUrl}/` }, { name: space.name, url: `${config.baseUrl}${svc.spacePath(space)}` }]) : null,
        });
    }));

    function editorsOnly(req, res, space) {
        if (svc.access.canEdit(space, req.actor)) return true;
        if (!req.actor.subject) needSignIn(req, res, 'Sign in to edit. Only editors of this space can change it.');
        else errorPage(req, res, 403, 'Not an editor', 'Only editors of this space can do that. An owner of the space can give you a role.');
        return false;
    }

    async function parentsOf(space, actor) {
        const out = [];
        const walk = (nodes) => { for (const n of nodes) { out.push(n.page); walk(n.children); } };
        walk(await svc.tree(space, actor));
        return out;
    }

    router.get('/s/:space/new', wrap(async (req, res) => {
        const space = await locateSpace(req, res);
        if (!space || !editorsOnly(req, res, space)) return;
        send(req, res, 200, views.editPage({ space, values: { title: String(req.query.title || '').slice(0, 200) }, parents: await parentsOf(space, req.actor) }), { title: `New page in ${space.name}`, robots: 'noindex, nofollow' });
    }));

    router.post('/s/:space/new', B('wiki.page.create'), form, wrap(async (req, res) => {
        const space = await locateSpace(req, res);
        if (!space || !editorsOnly(req, res, space)) return;
        const b = req.body || {};
        const values = { title: b.title, body: b.body, summary: b.summary, infobox: b.infobox, parent_id: b.parent_id, visibility: b.visibility, message: b.message };
        const parents = await parentsOf(space, req.actor);
        const again = (status, error, preview = null) => send(req, res, status, views.editPage({ space, values, error, preview, parents }), { title: `New page in ${space.name}`, robots: 'noindex, nofollow' });
        try {
            const infobox = content.parseInfoboxText(b.infobox);
            if (b.op === 'preview') return again(200, null, await svc.renderRevision(space, { content: String(b.body || '') }, req.actor));
            const cites = await resolveCitations(citationsFromForm(b), platform);
            const out = await svc.createPage(space.id, { title: b.title, body: String(b.body || ''), summary: b.summary || null, infobox, parentId: b.parent_id || null, visibility: b.visibility, citations: cites, message: b.message || null }, req.actor);
            if (b.op === 'publish') await svc.publish(out.page.id, { revision: out.revision.number }, req.actor);
            res.redirect(303, views.wpath(space, out.page));
        } catch (err) {
            if (!err.status || err.status >= 500 && err.status !== 503) throw err;
            again(err.status, err.message);
        }
    }));

    router.get('/s/:space/settings', wrap(async (req, res) => {
        const space = await locateSpace(req, res);
        if (!space) return;
        if (!svc.access.canManage(space, req.actor)) return req.actor.subject ? errorPage(req, res, 403, 'Owners only', 'Only an owner of this space can change its settings.') : needSignIn(req, res, 'Sign in as an owner of this space.');
        send(req, res, 200, views.spaceSettingsPage({ space, roles: await svc.roles(space.id, req.actor), flash: req.query.saved ? 'Saved.' : null }), { title: `Settings of ${space.name}`, robots: 'noindex, nofollow' });
    }));

    router.post('/s/:space/settings', B('wiki.space.update'), form, wrap(async (req, res) => {
        const space = await locateSpace(req, res);
        if (!space) return;
        const b = req.body || {};
        try {
            if (b.op === 'role') await svc.setRole(space.id, String(b.subject || ''), b.role ? String(b.role) : null, req.actor);
            else if (b.op === 'delete') { if (b.confirm !== 'yes') throw new svc.WikiError(422, 'space.confirm', 'Tick the box to confirm'); await svc.deleteSpace(space.id, req.actor); return res.redirect(303, '/'); }
            else { const s = await svc.updateSpace(space.id, { name: b.name, description: b.description, visibility: b.visibility }, req.actor); return res.redirect(303, `/s/${encodeURIComponent(s.slug)}/settings?saved=1`); }
            res.redirect(303, `/s/${encodeURIComponent(space.slug)}/settings?saved=1`);
        } catch (err) {
            if (!err.status || err.status >= 500) throw err;
            if (!svc.access.canManage(space, req.actor)) return errorPage(req, res, err.status, 'Owners only', err.message);
            send(req, res, err.status, views.spaceSettingsPage({ space, roles: await svc.roles(space.id, req.actor), error: err.message }), { title: `Settings of ${space.name}`, robots: 'noindex, nofollow' });
        }
    }));

    // Import pages into a space (owners): the same JSON bundle as POST /api/v1/spaces/:space/import,
    // pasted into a form; the options come from the form's controls.
    const importForm = express.urlencoded({ extended: false, limit: '6mb' });
    function ownersOnly(req, res, space) {
        if (svc.access.canManage(space, req.actor)) return true;
        if (!req.actor.subject) needSignIn(req, res, 'Sign in as an owner of this space to import pages.');
        else errorPage(req, res, 403, 'Owners only', 'Only an owner of this space imports pages into it.');
        return false;
    }
    router.get('/s/:space/import', wrap(async (req, res) => {
        const space = await locateSpace(req, res);
        if (!space || !ownersOnly(req, res, space)) return;
        send(req, res, 200, views.importPage({ space, values: {} }), { title: `Import pages into ${space.name}`, robots: 'noindex, nofollow' });
    }));
    router.post('/s/:space/import', B('wiki.page.import'), importForm, wrap(async (req, res) => {
        const space = await locateSpace(req, res);
        if (!space || !ownersOnly(req, res, space)) return;
        const b = req.body || {};
        const values = { bundle: String(b.bundle || ''), publish: b.publish === '1', on_existing: b.on_existing, source: b.source, ai_assisted: b.ai_assisted === '1' };
        const again = (status, error, result = null) => send(req, res, status, views.importPage({ space, values, error, result }), { title: `Import pages into ${space.name}`, robots: 'noindex, nofollow' });
        try {
            const parsed = importer.parseBundleText(values.bundle);
            const input = Array.isArray(parsed) ? { pages: parsed } : { ...parsed };
            Object.assign(input, { publish: values.publish, on_existing: values.on_existing || 'fail', source: values.source || input.source || null, ai_assisted: values.ai_assisted });
            const { bundle } = await svc.prepareImport(space.id, input, req.actor);
            await resolveBundleCitations(bundle, platform);
            const out = await svc.importPages(space.id, bundle, req.actor);
            again(200, null, out);
        } catch (err) {
            if (!err.status || (err.status >= 500 && err.status !== 503)) throw err;
            again(err.status, err.message);
        }
    }));

    router.get('/s/:space/proposals', wrap(async (req, res) => {
        const space = await locateSpace(req, res);
        if (!space || !editorsOnly(req, res, space)) return;
        const items = [];
        for (const proposal of (await svc.pendingProposals(req.actor)).filter((p) => p.space_id === space.id)) items.push({ proposal, page: await svc.pageById(proposal.page_id) });
        send(req, res, 200, views.proposalsPage({ space, items }), { title: `AI proposals in ${space.name}`, robots: 'noindex, nofollow' });
    }));

    router.post('/proposals/:id', B('wiki.revision.publish'), form, wrap(async (req, res) => {
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in to review proposals.');
        const p = await svc.getProposal(req.params.id);
        if (!p) return notFound(req, res);
        await svc.reviewProposal(p.id, { decision: (req.body || {}).decision, publish: true }, req.actor);
        const space = await svc.spaceById(p.space_id);
        res.redirect(303, `/s/${encodeURIComponent(space.slug)}/proposals`);
    }));

    // ── Articles ─────────────────────────────────────────────
    async function discussionFor(space, page, actor) {
        if (page.state !== 'published' || svc.access.effectiveVisibility(space, page) !== 'public') return { state: 'not_public' };
        if (!platform.community.configured) return { state: 'unavailable', reason: 'OpenVibe.Community is not configured on this server' };
        try {
            const threadId = await svc.discussionThread(space, page, platform.community);
            const data = await platform.community.getThread(threadId, { subject: actor.subject });
            return { state: 'ok', threadId, thread: data.thread, comments: data.comments || [] };
        } catch (err) {
            return { state: 'unavailable', reason: err.code === 'thread.not_found' ? 'the thread was removed' : null };
        }
    }

    function articleData(v, space, page) {
        return {
            id: page.id, space: space.slug, slug: page.slug, url: svc.pageUrl(space, page), state: page.state, visibility: svc.access.effectiveVisibility(space, page),
            revision: v.revision.number, title: v.revision.fields.title, summary: v.revision.fields.summary || null, body_markdown: v.revision.content,
            published_at: page.published_at ? new Date(page.published_at).toISOString() : null,
            revision_published_at: page.revision_published_at ? new Date(page.revision_published_at).toISOString() : null,
            revision_created_at: v.revision.createdAt,
            authorship: v.authorship ? { mode: v.authorship.mode, workflow: v.authorship.workflow || null, reviewed: !!(v.review && v.review.decision === 'approved') } : null,
            infobox: v.infobox,
            citations: v.citations.map((c) => ({ url: c.url, title: c.title, source_item_id: c.sourceItemId, retrieved_at: c.retrievedAt, quote: c.quote ? c.quote.text : null, license_note: c.licenseNote })),
            attachments: v.attachments.map((a) => ({ media_id: a.mediaId, state: a.state, broken_reason: a.brokenReason, alt: a.alt, caption: a.caption })),
            links: v.links.map((l) => ({ space: l.target_space, slug: l.target_slug })),
            indexability: { indexable: v.decision.indexable, reasons: v.decision.codes },
        };
    }

    router.get('/w/:space/:slug', wrap(async (req, res) => {
        const json = /\.json$/.test(req.params.slug);
        if (json) req.params.slug = req.params.slug.slice(0, -5);
        const found = await locate(req, res, json ? '.json' : '');
        if (!found) return;
        const { space, page } = found;
        const rev = req.query.rev != null ? Number(req.query.rev) : undefined;
        if (rev !== undefined && !Number.isInteger(rev)) return notFound(req, res);
        let v;
        try { v = await svc.view(space, page, req.actor, { revision: rev }); } catch (err) { if (err.status === 404) return notFound(req, res); throw err; }
        const open = page.state === 'published' && svc.access.effectiveVisibility(space, page) === 'public';
        const cache = open && v.isPublishedRevision ? 'public' : null;
        if (json) {
            res.status(200).set('Cache-Control', cache && req.actor.kind === 'anonymous' ? 'public, max-age=60' : 'private, no-store').set('Vary', 'Cookie, Authorization')
                .set('X-Robots-Tag', v.isPublishedRevision ? seo.xRobotsTag(v.decision) : 'noindex, nofollow').json(articleData(v, space, page));
            return;
        }
        // Infobox values of type page link to that page: resolved before the (synchronous) view renders.
        const infoboxLinks = new Map();
        for (const x of v.infobox) {
            if (x.type !== 'page' || infoboxLinks.has(x.value)) continue;
            infoboxLinks.set(x.value, await svc.resolveLink(content.parseTarget(x.value, space.slug) || { space: space.slug, slug: '-', title: x.value }, req.actor));
        }
        const [bodyHtml, discussion] = await Promise.all([
            svc.renderRevision(space, v.revision, req.actor),
            v.isPublishedRevision ? await discussionFor(space, page, req.actor) : { state: 'not_public' },
        ]);
        const url = svc.pageUrl(space, page);
        const crumbsLd = [{ name: 'Wiki', url: `${config.baseUrl}/` }, { name: space.name, url: `${config.baseUrl}${svc.spacePath(space)}` }, { name: v.revision.fields.title, url }];
        // The gate decides robots for the published revision; any other revision is noindex.
        const decision = v.isPublishedRevision ? v.decision : { ...v.decision, indexable: false, robots: 'noindex, nofollow', canonical: url };
        const description = v.revision.fields.summary || ssr.markdownToText(v.revision.content, 160);
        const jsonLd = open && v.isPublishedRevision ? [
            seo.structuredData.article({
                headline: v.revision.fields.title, url, description,
                datePublished: page.published_at, dateModified: page.revision_published_at,
                citations: v.citations, wordCount: ssr.wordCount(ssr.markdownToText(v.revision.content)),
            }),
            seo.structuredData.breadcrumbs(crumbsLd),
        ].filter(Boolean) : null;
        const head = seo.metaTags({ decision, title: `${v.revision.fields.title} · OpenVibe.Wiki`, description, siteName: 'OpenVibe.Wiki', type: 'article', jsonLd });
        send(req, res, 200, views.articlePage(v, { html: bodyHtml, discussion, actor: req.actor, mediaUrl: (id) => platform.media.publicUrl(id), resolve: (title) => infoboxLinks.get(title) || { href: null, exists: false }, flash: req.query.saved ? 'Saved.' : null }), {
            head, path: svc.pagePath(space, page), cache,
        });
    }));

    router.get('/w/:space/:slug/history', wrap(async (req, res) => {
        const found = await locate(req, res, '/history');
        if (!found) return;
        const { space, page } = found;
        send(req, res, 200, views.historyPage({ space, page, list: await svc.history(page, { limit: 500, actor: req.actor }), canEdit: svc.access.canEdit(space, req.actor) }), {
            title: `History of ${page.title}`, robots: 'noindex, follow', cache: page.state === 'published' && svc.access.effectiveVisibility(space, page) === 'public' ? 'public' : null,
        });
    }));

    // The citation inspector: one revision's sources (?rev=N; the published one by default), with the
    // same read rules as the article.
    router.get('/w/:space/:slug/sources', wrap(async (req, res) => {
        const found = await locate(req, res, '/sources');
        if (!found) return;
        const { space, page } = found;
        const rev = req.query.rev != null ? Number(req.query.rev) : undefined;
        if (rev !== undefined && !Number.isInteger(rev)) return notFound(req, res);
        let inspected;
        try { inspected = await svc.citationInspector(space, page, req.actor, { revision: rev }); } catch (err) { if (err.status === 404) return notFound(req, res); throw err; }
        send(req, res, 200, views.sourcesPage({ space, page, ...inspected }), {
            title: `Sources of ${inspected.view.revision.fields.title || page.title}`, robots: 'noindex, follow',
            cache: page.state === 'published' && svc.access.effectiveVisibility(space, page) === 'public' ? 'public' : null,
        });
    }));

    router.get('/w/:space/:slug/compare', wrap(async (req, res) => {
        const found = await locate(req, res);
        if (!found) return;
        const a = Number(req.query.a), b = Number(req.query.b);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return errorPage(req, res, 400, 'Pick two revisions', 'Choose a "from" and a "to" revision to compare.');
        res.redirect(303, `${views.wpath(found.space, found.page)}/diff/${Math.min(a, b)}/${Math.max(a, b)}`);
    }));

    router.get('/w/:space/:slug/diff/:a/:b', wrap(async (req, res) => {
        const found = await locate(req, res, `/diff/${req.params.a}/${req.params.b}`);
        if (!found) return;
        const { space, page } = found;
        let diff;
        try { diff = await svc.diff(page, req.params.a, req.params.b, { mode: req.query.mode, actor: req.actor }); } catch (err) { if (err.status === 404 || err.status === 422) return notFound(req, res); throw err; }
        send(req, res, 200, views.diffPage({ space, page, diff }), {
            title: `Changes to ${page.title}`, robots: 'noindex, nofollow', cache: page.state === 'published' && svc.access.effectiveVisibility(space, page) === 'public' ? 'public' : null,
        });
    }));

    // Editing a missing page (a red link) opens the new-page form with the title filled in.
    async function editTarget(req, res) {
        const space = await svc.findSpace(req.params.space);
        if (space && !space.deleted_at && svc.access.canReadSpace(space, req.actor) && !await svc.findPage(space.id, req.params.slug) && !await svc.resolveRedirect(`/w/${req.params.space}/${req.params.slug}`)) {
            res.redirect(303, `/s/${encodeURIComponent(space.slug)}/new?title=${encodeURIComponent(String(req.query.title || req.params.slug))}`);
            return null;
        }
        return await locate(req, res, '/edit');
    }

    router.get('/w/:space/:slug/edit', wrap(async (req, res) => {
        const found = await editTarget(req, res);
        if (!found) return;
        const { space, page } = found;
        if (!editorsOnly(req, res, space)) return;
        // Start from the newest revision that is not an unapproved AI proposal; concurrency is
        // still checked against the head.
        const list = await svc.history(page, { limit: 500 });
        const headNumber = list[0].number;
        const start = list.find((r) => !r.proposal || r.proposal.status === 'approved') || list[0];
        const from = await svc.view(space, page, req.actor, { revision: start.number });
        const note = start.number !== headNumber ? `The newest revision (${headNumber}) is an AI proposal that has not been approved; this form starts from revision ${start.number}.` : null;
        send(req, res, 200, views.editPage({ space, page, values: views.formValuesFromRevision(from.revision, page), citations: from.citations, baseRevision: start.number, expectedRevision: headNumber, error: note }), { title: `Editing ${page.title}`, robots: 'noindex, nofollow' });
    }));

    router.post('/w/:space/:slug/edit', B('wiki.page.edit'), form, wrap(async (req, res) => {
        const found = await locate(req, res, '/edit');
        if (!found) return;
        const { space, page } = found;
        if (!editorsOnly(req, res, space)) return;
        const b = req.body || {};
        const expected = Number(b.expected_revision);
        const base = Number(b.base_revision) || expected;
        const keep = [].concat(b.keep_citation || []).map(String);
        let baseView = null;
        try { baseView = Number.isInteger(base) && base > 0 ? await svc.view(space, page, req.actor, { revision: base }) : null; } catch { baseView = null; }
        const values = { title: b.title, body: b.body, summary: b.summary, infobox: b.infobox, message: b.message, keep };
        const again = (status, error, preview = null) => send(req, res, status, views.editPage({ space, page, values, error, preview, citations: baseView ? baseView.citations : [], baseRevision: base, expectedRevision: expected }), { title: `Editing ${page.title}`, robots: 'noindex, nofollow' });
        try {
            const infobox = content.parseInfoboxText(b.infobox);
            if (b.op === 'preview') return again(200, null, await svc.renderRevision(space, { content: String(b.body || '') }, req.actor));
            const cites = await resolveCitations(citationsFromForm(b), platform);
            const out = await svc.editPage(page.id, { expectedRevision: expected, baseRevision: base, title: b.title, body: String(b.body || ''), summary: b.summary || null, infobox, citations: cites, keepCitations: keep, message: b.message || null }, req.actor);
            if (b.op === 'publish') await svc.publish(page.id, { revision: out.revision.number }, req.actor);
            res.redirect(303, `${views.wpath(space, out.page)}${b.op === 'publish' ? '' : `?rev=${out.revision.number}`}`);
        } catch (err) {
            if (err.code === 'revision.conflict') return again(409, `Someone saved revision ${err.extra ? err.extra.current : ''} while you were editing. Your text is below; open the page in another tab, merge by hand, and save again.`);
            if (!err.status || err.status >= 500 && err.status !== 503) throw err;
            again(err.status, err.message);
        }
    }));

    router.get('/w/:space/:slug/revert', wrap(async (req, res) => {
        const found = await locate(req, res, '/revert');
        if (!found) return;
        const { space, page } = found;
        if (!editorsOnly(req, res, space)) return;
        const to = Number(req.query.to);
        const head = (await svc.history(page, { limit: 1 }))[0].number;
        if (!Number.isInteger(to) || to < 1 || to > head) return notFound(req, res);
        send(req, res, 200, views.revertPage({ space, page, to, head }), { title: `Revert ${page.title}`, robots: 'noindex, nofollow' });
    }));

    router.post('/w/:space/:slug/revert', B('wiki.page.edit'), form, wrap(async (req, res) => {
        const found = await locate(req, res, '/revert');
        if (!found) return;
        const { space, page } = found;
        if (!editorsOnly(req, res, space)) return;
        const b = req.body || {};
        const out = await svc.revert(page.id, { toRevision: Number(b.to), expectedRevision: Number(b.expected_revision), message: b.message || null }, req.actor);
        res.redirect(303, out.published ? views.wpath(space, out.page) : `${views.wpath(space, out.page)}?rev=${out.revision.number}`);
    }));

    router.get('/w/:space/:slug/publish', wrap(async (req, res) => {
        const found = await locate(req, res, '/publish');
        if (!found) return;
        if (!editorsOnly(req, res, found.space)) return;
        const rev = Number(req.query.rev);
        if (!Number.isInteger(rev)) return notFound(req, res);
        send(req, res, 200, views.confirmPublishPage({ ...found, rev }), { title: `Publish ${found.page.title}`, robots: 'noindex, nofollow' });
    }));

    router.get('/w/:space/:slug/settings', wrap(async (req, res) => {
        const found = await locate(req, res, '/settings');
        if (!found) return;
        const { space, page } = found;
        if (!editorsOnly(req, res, space)) return;
        await renderPageSettings(req, res, space, page, 200, { flash: req.query.saved ? (req.query.saved === 'verify' ? `Checked attachments against OpenVibe.Media: ${req.query.summary || ''}` : 'Saved.') : null });
    }));

    async function renderPageSettings(req, res, space, page, status, extra = {}) {
        const [view, list, parents] = await Promise.all([svc.view(space, page, req.actor, {}), svc.history(page, { limit: 1 }), parentsOf(space, req.actor)]);
        const headNumber = list[0].number;
        send(req, res, status, views.pageSettingsPage({ space, page, v: { ...view, headNumber }, parents, canManage: svc.access.canManage(space, req.actor), ...extra }), { title: `Settings of ${page.title}`, robots: 'noindex, nofollow' });
    }

    router.post('/w/:space/:slug/settings', B('wiki.page.update'), form, wrap(async (req, res) => {
        const found = await locate(req, res, '/settings');
        if (!found) return;
        const { space, page } = found;
        if (!editorsOnly(req, res, space)) return;
        const b = req.body || {};
        const back = (p = page, q = 'saved=1') => res.redirect(303, `${views.wpath(space, p)}/settings?${q}`);
        try {
            switch (b.op) {
            case 'publish': await svc.publish(page.id, { revision: Number(b.revision) }, req.actor); return res.redirect(303, views.wpath(space, page));
            case 'schedule': {
                const at = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(String(b.run_at)) ? b.run_at : `${b.run_at}Z`);
                await svc.schedulePublish(page.id, { revision: Number(b.revision), runAt: at }, req.actor);
                return back();
            }
            case 'unpublish': await svc.unpublish(page.id, req.actor); return back();
            case 'move': { const p = await svc.movePage(page.id, { slug: b.slug, parentId: b.parent_id || null }, req.actor); return back(p); }
            case 'attach': await svc.attachMedia(page.id, { mediaId: b.media_id, alt: b.alt || null, caption: b.caption || null }, req.actor, { describe: platform.media.describe }); return back();
            case 'detach': await svc.detachMedia(page.id, Number(b.attachment_id), req.actor); return back();
            case 'verify': {
                const results = await svc.verifyMedia(page.id, platform.media.resolve);
                const count = (k) => results.filter((r) => r.outcome === k).length;
                return back(page, `saved=verify&summary=${encodeURIComponent(`${count('available')} available, ${count('broken')} broken, ${count('check_failed')} not checked (Media did not answer)`)}`);
            }
            case 'visibility': await svc.setPageVisibility(page.id, { visibility: b.visibility, noindex: b.noindex === '1' }, req.actor); return back();
            case 'delete': if (b.confirm !== 'yes') throw new svc.WikiError(422, 'page.confirm', 'Tick the box to confirm'); await svc.deletePage(page.id, req.actor); return res.redirect(303, `/s/${encodeURIComponent(space.slug)}`);
            default: throw new svc.WikiError(400, 'request.invalid', 'Unknown action');
            }
        } catch (err) {
            if (!err.status || (err.status >= 500 && err.status !== 503)) throw err;
            await renderPageSettings(req, res, space, await svc.pageById(page.id), err.status, { error: err.message });
        }
    }));

    router.post('/w/:space/:slug/review', B('wiki.revision.publish'), form, wrap(async (req, res) => {
        const found = await locate(req, res, '/review');
        if (!found) return;
        const { space, page } = found;
        if (!editorsOnly(req, res, space)) return;
        const b = req.body || {};
        await svc.reviewRevision(space.id, page.slug, Number(b.revision), { decision: b.decision, note: b.note ? String(b.note).slice(0, 2000) : null }, req.actor);
        res.redirect(303, `${views.wpath(space, page)}/history`);
    }));

    router.post('/w/:space/:slug/watch', B('wiki.page.watch'), form, wrap(async (req, res) => {
        const found = await locate(req, res, '/watch');
        if (!found) return;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in to watch pages.');
        await svc.watch(found.page.id, req.actor, (req.body || {}).on !== '0');
        res.redirect(303, views.wpath(found.space, found.page));
    }));

    router.post('/w/:space/:slug/discuss', B('wiki.discussion.comment'), form, wrap(async (req, res) => {
        const found = await locate(req, res, '/discuss');
        if (!found) return;
        const { space, page } = found;
        if (!req.actor.subject) return needSignIn(req, res, 'Sign in to comment.');
        const message = String((req.body || {}).message || '').trim();
        if (!message) return res.redirect(303, `${views.wpath(space, page)}#discussion`);
        const d = await discussionFor(space, page, req.actor);
        if (d.state !== 'ok') return errorPage(req, res, 503, 'Discussion unavailable', 'The discussion is held by OpenVibe.Community, which could not take the comment right now. Nothing was posted.');
        await platform.community.addComment(d.threadId, { subject: req.actor.subject, message });
        res.redirect(303, `${views.wpath(space, page)}#discussion`);
    }));

    return { router, notFound, errorPage };
}

module.exports = { createPages };
