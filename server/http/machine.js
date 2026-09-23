'use strict';
/**
 * Discovery artifacts (roadmap §32.4). Every list here is built from the indexability gate's
 * decision for each page: only public, published, indexable pages enter sitemaps; only listable
 * ones enter feeds. Members/private/deleted content never appears.
 *
 *   /robots.txt          crawl rules + sitemap location + explicit automated-consumer policy
 *   /sitemap.xml         sitemap index → /sitemaps/spaces.xml, /sitemaps/pages-<n>.xml
 *   /feed.atom           recent changes (Atom), /feed.json (JSON Feed 1.1)
 *   /llms.txt            orientation for language models
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const sharedSeo = require('openvibe-shared/seo');

const PER_SITEMAP = 45000;

function createMachine({ svc, config }) {
    const router = express.Router();
    const origin = config.baseUrl;
    const cache = (res, s = 300) => res.set('Cache-Control', `public, max-age=${s}`);

    router.get('/robots.txt', (_req, res) => {
        cache(res, 3600).type('text/plain').send(seo.robotsTxt({
            sitemaps: [`${origin}/sitemap.xml`],
            disallow: ['/auth/', '/api/', '/new-space', '/search', '/proposals/'],
        }));
    });

    function pageEntries() {
        return svc.publishedPublic().map(({ space, page, decision }) => ({
            loc: svc.pageUrl(space, page), lastmod: page.revision_published_at, decision,
        }));
    }

    function spaceEntries() {
        return svc.listSpaces({ kind: 'anonymous' }).filter((s) => s.visibility === 'public').map((s) => {
            const url = seo.canonicalUrl(origin, svc.spacePath(s));
            // A space index is navigation, not an article: no word or source minimum.
            const decision = seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: url, wordCount: 0 }, { policy: { minWords: 0, requireSources: false }, now: Date.now() });
            return { loc: url, lastmod: s.updated_at, decision };
        });
    }

    router.get('/sitemap.xml', (_req, res) => {
        const pages = seo.sitemap(pageEntries(), { maxUrls: PER_SITEMAP });
        const maps = [{ loc: `${origin}/sitemaps/spaces.xml` }];
        pages.files.forEach((_f, i) => maps.push({ loc: `${origin}/sitemaps/pages-${i + 1}.xml` }));
        cache(res).type('application/xml').send(seo.sitemapIndex(maps));
    });
    router.get('/sitemaps/spaces.xml', (_req, res) => cache(res).type('application/xml').send(seo.sitemap(spaceEntries()).files[0]));
    router.get('/sitemaps/pages-:n.xml', (req, res) => {
        const files = seo.sitemap(pageEntries(), { maxUrls: PER_SITEMAP }).files;
        const n = Number(req.params.n);
        if (!Number.isInteger(n) || n < 1 || n > files.length) return res.status(404).type('text/plain').send('Not found');
        cache(res).type('application/xml').send(files[n - 1]);
    });

    function feedItems() {
        return svc.recentChanges(50).map(({ space, page, rev, decision }) => ({
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
    function emptyFeedUpdated() {
        const times = svc.listSpaces({ kind: 'anonymous' }).filter((s) => s.visibility === 'public').map((s) => s.updated_at);
        return new Date(times.length ? Math.max(...times) : 0).toISOString();
    }

    router.get('/feed.atom', (_req, res) => {
        const items = feedItems();
        const updated = items.some((i) => i.decision.listable) ? null : emptyFeedUpdated();
        cache(res).type('application/atom+xml').send(seo.atomFeed({ title: 'OpenVibe.Wiki: recent changes', link: `${origin}/recent`, feedUrl: `${origin}/feed.atom`, id: `${origin}/feed.atom`, ...(updated ? { updated } : {}) }, items));
    });
    router.get('/feed.json', (_req, res) => {
        cache(res).type('application/feed+json').send(JSON.stringify(seo.jsonFeed({ title: 'OpenVibe.Wiki: recent changes', link: `${origin}/recent`, feedUrl: `${origin}/feed.json`, description: 'Public wiki pages by the time their current revision was published.' }, feedItems())));
    });

    router.get('/llms.txt', (_req, res) => {
        const spaces = svc.listSpaces({ kind: 'anonymous' }).filter((s) => s.visibility === 'public');
        cache(res, 3600).type('text/plain').send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Wiki',
            summary: 'Wiki spaces of the OpenVibe network: page trees, immutable revisions, citations attached to the revision that used them, infoboxes and internal links.',
            details: 'Every public page has a JSON representation at the same address plus ".json" (same content, same visibility rules). Revision history and diffs are public for public pages. AI-generated revisions are labelled and are published only after a person approves them.',
            sections: [
                { title: 'Spaces', links: spaces.map((s) => ({ title: s.name, url: `${origin}${svc.spacePath(s)}`, note: s.description || '' })) },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: `${origin}/sitemap.xml` },
                    { title: 'Recent changes (Atom)', url: `${origin}/feed.atom` },
                    { title: 'Recent changes (JSON Feed)', url: `${origin}/feed.json` },
                ] },
            ],
        }));
    });

    return router;
}

module.exports = { createMachine };
