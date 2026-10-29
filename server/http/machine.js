'use strict';
/**
 * Discovery artifacts (roadmap §32.4). Every list here is built from the indexability gate's
 * decision for each page: only public, published, indexable pages enter sitemaps; only listable
 * ones enter feeds. Members/private/deleted content never appears.
 *
 *   /robots.txt          crawl rules + sitemap location + explicit automated-consumer policy
 *   /sitemap.xml         sitemap index → /sitemaps/spaces.xml (the home and every public wiki), /sitemaps/pages-<n>.xml
 *   /feed.atom           recent changes (Atom), /feed.json (JSON Feed 1.1)
 *   /llms.txt            orientation for language models
 *   /llms-full.txt       the same orientation plus an excerpt of every indexable page, bounded
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const sharedSeo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { AI_SUMMARY } = require('../render/layout');

const PER_SITEMAP = 45000;
// /llms-full.txt is Wiki, so it can be large: the cap must hold, and a page contributes an excerpt
// (its summary, or its opening text), never the whole article.
const LLMS_MAX_BYTES = 512 * 1024;
const LLMS_EXCERPT = 500;

function createMachine({ svc, config }) {
    const router = express.Router();
    const origin = config.baseUrl;
    const setCache = (res, s = 300) => res.set('Cache-Control', cache.htmlHeaders({ maxAge: s }));

    router.get('/robots.txt', (_req, res) => {
        setCache(res, 3600).type('text/plain').send(seo.robotsTxt({
            sitemaps: [`${origin}/sitemap.xml`],
            disallow: ['/auth/', '/api/', '/new-space', '/search', '/proposals/'],
        }));
    });

    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

    async function pageEntries(published = null) {
        published = published || await svc.publishedPublic();
        return published.map(({ space, page, decision }) => ({
            loc: svc.pageUrl(space, page), lastmod: page.revision_published_at, decision,
        }));
    }

    async function spaceEntries(published = null) {
        published = published || await svc.publishedPublic();
        const newestPage = new Map();
        for (const { space, page } of published) {
            if (!page.revision_published_at) continue;
            newestPage.set(space.id, Math.max(newestPage.get(space.id) || 0, page.revision_published_at));
        }
        // A space index is navigation, not an article: no word or source minimum. The same for the home, listed first.
        const navigation = (url) => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: url, wordCount: 0 }, { policy: { minWords: 0, requireSources: false }, now: Date.now() });
        const spaces = (await svc.listSpaces({ kind: 'anonymous' })).filter((s) => s.visibility === 'public').map((s) => {
            const url = seo.canonicalUrl(origin, svc.spacePath(s));
            return { loc: url, lastmod: Math.max(s.updated_at, newestPage.get(s.id) || 0), decision: navigation(url) };
        });
        const home = seo.canonicalUrl(origin, '/');
        const newest = Math.max(0, ...spaces.map((x) => x.lastmod || 0));
        return [{ loc: home, lastmod: newest || undefined, decision: navigation(home) }, ...spaces];
    }

    router.get('/sitemap.xml', wrap(async (_req, res) => {
        const published = await svc.publishedPublic();
        const entries = (await pageEntries(published)).filter((e) => e.decision.indexable);
        const spaces = (await spaceEntries(published)).filter((e) => e.decision.indexable);
        const pages = seo.sitemap(entries, { maxUrls: PER_SITEMAP });
        const newest = (rows) => {
            const times = rows.map((e) => e.lastmod).filter(Boolean);
            return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
        };
        const maps = [{ loc: `${origin}/sitemaps/spaces.xml`, lastmod: newest(spaces) }];
        pages.files.forEach((_f, i) => maps.push({ loc: `${origin}/sitemaps/pages-${i + 1}.xml`, lastmod: newest(entries.slice(i * PER_SITEMAP, (i + 1) * PER_SITEMAP)) }));
        setCache(res).type('application/xml').send(seo.sitemapIndex(maps));
    }));
    router.get('/sitemaps/spaces.xml', wrap(async (_req, res) => setCache(res).type('application/xml').send(seo.sitemap(await spaceEntries()).files[0])));
    router.get('/sitemaps/pages-:n.xml', wrap(async (req, res) => {
        const files = seo.sitemap(await pageEntries(), { maxUrls: PER_SITEMAP }).files;
        const n = Number(req.params.n);
        if (!Number.isInteger(n) || n < 1 || n > files.length) return res.status(404).type('text/plain').send('Not found');
        setCache(res).type('application/xml').send(files[n - 1]);
    }));

    async function feedItems(changes = null) {
        return (changes || await svc.recentChanges(50)).map(({ space, page, rev, decision }) => ({
            id: `tag:openvibe.wiki,2026:page/${page.id}/revision/${page.published_revision}`,
            url: svc.pageUrl(space, page),
            title: rev.fields.title,
            summary: rev.fields.summary || ssr.markdownToText(rev.content, 280),
            published: page.revision_published_at,
            updated: page.revision_published_at,
            tags: [space.name],
            decision,
        }));
    }

    /**
     * Atom needs a feed-level <updated>. With entries it is the newest entry's. With none (nothing
     * listable yet) it is the last change to a public space — never "now", and never the time of a
     * change readers cannot see — or the Unix epoch when there is no public space at all. The feed is
     * linked from every page, so an empty one is a valid feed with zero entries, not a 404.
     */
    async function emptyFeedUpdated() {
        const times = (await svc.listSpaces({ kind: 'anonymous' })).filter((s) => s.visibility === 'public').map((s) => s.updated_at);
        return new Date(times.length ? Math.max(...times) : 0).toISOString();
    }

    router.get('/feed.atom', wrap(async (_req, res) => {
        const items = await feedItems();
        const updated = items.some((i) => i.decision.listable) ? null : await emptyFeedUpdated();
        setCache(res).type('application/atom+xml').send(seo.atomFeed({ title: 'OpenVibe.Wiki: recent changes', link: `${origin}/recent`, feedUrl: `${origin}/feed.atom`, id: `${origin}/feed.atom`, ...(updated ? { updated } : {}) }, items));
    }));
    router.get('/feed.json', wrap(async (_req, res) => {
        setCache(res).type('application/feed+json').send(JSON.stringify(seo.jsonFeed({ title: 'OpenVibe.Wiki: recent changes', link: `${origin}/recent`, feedUrl: `${origin}/feed.json`, description: 'Public wiki pages by the time their current revision was published.' }, await feedItems())));
    }));

    // One space's recent changes (Atom and JSON Feed), for people who follow that space only. A private, deleted or
    // unknown space has no feed (404); an empty public space has a valid feed with no entries.
    async function spaceFeed(req, res) {
        const found = /^[a-z0-9-]{1,64}$/.test(req.params.space) ? await svc.recentChangesIn(req.params.space, 50) : null;
        if (!found) return res.status(404).type('text/plain').send('Not found');
        const { space } = found;
        const items = await feedItems(found.changes);
        const base = `${origin}/s/${encodeURIComponent(space.slug)}`;
        const title = `OpenVibe.Wiki: ${space.name}`;
        if (req.params.format === 'atom') {
            const updated = items.some((i) => i.decision.listable) ? null : new Date(space.updated_at || 0).toISOString();
            return setCache(res).type('application/atom+xml').send(seo.atomFeed({ title, link: base, feedUrl: `${base}/feed.atom`, id: `${base}/feed.atom`, ...(updated ? { updated } : {}) }, items));
        }
        return setCache(res).type('application/feed+json').send(JSON.stringify(seo.jsonFeed({ title, link: base, feedUrl: `${base}/feed.json`, description: `Pages published in the ${space.name} space of OpenVibe.Wiki, newest first.` }, items)));
    }
    router.get('/s/:space/feed.:format(atom|json)', wrap(spaceFeed));

    router.get('/llms.txt', wrap(async (_req, res) => {
        const spaces = (await svc.listSpaces({ kind: 'anonymous' })).filter((s) => s.visibility === 'public');
        setCache(res, 3600).type('text/plain').send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Wiki',
            summary: AI_SUMMARY,
            details: 'Every public page has a JSON representation at the same address plus ".json" (same content, same visibility rules). Revision history and diffs are public for public pages. AI-generated revisions are labelled and are published only after a person approves them.',
            sections: [
                { title: 'Spaces', links: spaces.map((s) => ({ title: s.name, url: `${origin}${svc.spacePath(s)}`, note: s.description || '' })) },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: `${origin}/sitemap.xml` },
                    { title: 'Recent changes (Atom)', url: `${origin}/feed.atom` },
                    { title: 'Recent changes (JSON Feed)', url: `${origin}/feed.json` },
                ] },
                { title: 'API', links: [{ title: 'OpenAPI 3.1 document', url: `${origin}/openapi.json`, note: 'every /api/v1 route, with its fields' }] },
            ],
        }));
    }));

    /**
     * /llms-full.txt: the llms.txt header, then the wikis /llms.txt names and one entry per indexable
     * page. The same gate as the sitemap decides who is here (a public, published page still
     * unreviewed stays out), and each page entry is an excerpt — the page's summary, or its opening
     * text — never the article. The wikis are the site's own navigation pages, so a wiki whose pages
     * are all still unreviewed still answers with what it is and where it is, never with a bare
     * header. The byte cap keeps a large wiki bounded: llmsFull truncates whole entries and says so.
     */
    router.get('/llms-full.txt', wrap(async (_req, res) => {
        const [published, allSpaces] = await Promise.all([svc.publishedPublic(), svc.listSpaces({ kind: 'anonymous' })]);
        const listed = published.filter(({ decision }) => decision.indexable);
        const perSpace = new Map();
        for (const { space } of published) perSpace.set(space.id, (perSpace.get(space.id) || 0) + 1);
        const spaces = allSpaces.filter((s) => s.visibility === 'public').map((s) => ({
            title: s.name,
            url: `${origin}${svc.spacePath(s)}`,
            text: [
                s.description ? s.description.replace(/\.?\s*$/, '.') : `The ${s.name} wiki on OpenVibe.Wiki.`,
                `${perSpace.get(s.id) || 0} published page${(perSpace.get(s.id) || 0) === 1 ? '' : 's'}${s.updated_at ? `, updated ${new Date(Number(s.updated_at)).toISOString().slice(0, 10)}` : ''}.`,
            ].join(' '),
        }));
        const pages = listed.map(({ space, page, rev }) => ({
            title: rev.fields.title,
            url: svc.pageUrl(space, page),
            text: rev.fields.summary || ssr.markdownToText(rev.content, LLMS_EXCERPT),
        }));
        setCache(res, 3600).type('text/plain').send(sharedSeo.llmsFull({
            site: 'OpenVibe.Wiki', summary: AI_SUMMARY, base: origin,
            sections: [{ title: 'Wikis', pages: spaces }, { title: 'Pages', pages }], maxBytes: LLMS_MAX_BYTES,
        }));
    }));

    return router;
}

module.exports = { createMachine };
