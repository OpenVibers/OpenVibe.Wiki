'use strict';
// The menu's network card for OpenVibe.Wiki (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
//
// Wiki publishes "New on the wiki": the six pages revised most recently, each linking to its article. The rows
// are the same public recent changes the home page and /recent show (svc.recentChanges), which already keeps
// drafts, members-only wikis and private pages out. The file is CORS *, cached for five minutes; with nothing
// published it is served with no items and Network skips it.
const BASE = 'https://openvibe.wiki';
const CARD_ID = 'new-pages';
const SITE = 'wiki';
const CARD_TTL_S = 300;
const CACHE_MS = CARD_TTL_S * 1000;
const LIMIT = 6;

/** Plain words for a card: no markup, no control characters, one line, within the schema's limit. */
function plain(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** "just now", "12m ago", "3h ago" or "2d ago"; empty when unknown. */
function ago(value, now) {
    const at = typeof value === 'number' ? value : Date.parse(String(value || ''));
    if (!Number.isFinite(at)) return '';
    const mins = Math.max(0, Math.floor((now - at) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/** The article's path, the same /w/<space>/<slug> the site renders. */
const pagePath = (space, page) => `/w/${encodeURIComponent(String(space.slug))}/${encodeURIComponent(String(page.slug))}`;

/** The card itself. `changes` are svc.recentChanges() rows: { space, page, rev, ... }. */
function cardFrom(changes, at = Date.now()) {
    const out = [];
    for (const change of Array.isArray(changes) ? changes : []) {
        const space = change && change.space;
        const page = change && change.page;
        if (!space || !page || page.state === 'deleted') continue;
        if (page.visibility && page.visibility !== 'public') continue;
        const title = plain(page.title, 80);
        if (!title || !space.slug || !page.slug) continue;
        const meta = [plain(space.name, 60), ago(page.revision_published_at || page.published_at, at)].filter(Boolean).join(' · ');
        out.push({ title, ...(meta ? { meta: plain(meta, 120) } : {}), url: `${BASE}${pagePath(space, page)}` });
        if (out.length >= LIMIT) break;
    }
    return {
        id: CARD_ID,
        site: SITE,
        title: 'New on the wiki',
        kind: 'rows',
        items: out,
        more: { label: 'All wikis', url: `${BASE}/` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/** The route. `load` returns svc.recentChanges() rows; `now` is injectable for the test. */
function createMenuCard({ load, now = Date.now } = {}) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function card() {
        const at = now();
        if (cached && at - cachedAt < CACHE_MS) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                cached = cardFrom(await load(), at);
                cachedAt = at;
            } catch {
                // Keep the last good card rather than publish an empty one on a database hiccup.
                if (!cached) { cached = cardFrom([], at); cachedAt = at; }
            }
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    }

    async function handler(_req, res) {
        const body = await card();
        res.set('Cache-Control', 'public, max-age=60')
            .set('Access-Control-Allow-Origin', '*')
            .set('Cross-Origin-Resource-Policy', 'cross-origin')
            .json([body]);
    }

    return { card, handler, cardFrom, cacheMs: CACHE_MS };
}

module.exports = { createMenuCard, cardFrom, ago, pagePath, plain, BASE, CARD_ID, SITE, CARD_TTL_S, LIMIT };
