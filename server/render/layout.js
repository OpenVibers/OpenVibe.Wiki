'use strict';
/**
 * Page shell: every page is server-rendered through this. The <head> SEO block comes from
 * openvibe-shared/seo (robots always explicit: from the indexability gate for articles, noindex for
 * editing surfaces), the OpenVibe Frame from openvibe-shared (app icon, SSR footer, a <noscript>
 * navigation) plus the Network's navbar.js/footer.js as progressive enhancement. Nothing on the
 * page needs JavaScript to be read, navigated, edited or submitted.
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const sharedSeo = require('openvibe-shared/seo');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const { escapeHtml: esc } = require('openvibe-publishing/ssr');

const SITE_NAME = 'OpenVibe.Wiki';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'OpenVibe.Wiki: wiki spaces with page trees, revision history, citations and discussion, part of the OpenVibe network.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const hashes = new Map();
function asset(rel) {
    if (!hashes.has(rel)) {
        let v = 'dev';
        try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
        hashes.set(rel, v);
    }
    return `/${rel}?v=${hashes.get(rel)}`;
}

function navConfig(o, config) {
    return {
        service: 'wiki',
        apiBase: NETWORK_URL,
        links: [
            { label: 'Spaces', href: '/', active: o.active === 'home' },
            { label: 'Recent changes', href: '/recent', active: o.active === 'recent' },
            { label: 'Search', href: '/search', active: o.active === 'search' },
        ],
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: `/auth/login?next=${encodeURIComponent(o.path || '/')}`,
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
    };
}

/**
 * o: title, description, path (canonical path), robots (required), head (extra head HTML, e.g. the
 * gate's metaTags), jsonLd, body, active, actor, config, feeds
 */
function renderPage(o) {
    const { config } = o;
    if (!o.robots && !o.head) throw new TypeError('renderPage needs explicit robots (or a head block built from the gate)');
    const title = o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME;
    const head = o.head || sharedSeo.headTags({
        title, description: o.description || DEFAULT_DESCRIPTION, canonical: `${config.baseUrl}${o.path || '/'}`,
        robots: o.robots, siteName: SITE_NAME, type: o.ogType || 'website', jsonLd: o.jsonLd || null,
    });
    const feeds = o.feeds === false ? [] : [
        { type: 'application/atom+xml', title: `${SITE_NAME}: recent changes (Atom)`, href: '/feed.atom' },
        { type: 'application/feed+json', title: `${SITE_NAME}: recent changes (JSON Feed)`, href: '/feed.json' },
    ];
    const actor = o.actor || { kind: 'anonymous' };
    const who = actor.kind === 'user'
        ? `<span class="wk-who">Signed in as ${esc((actor.user && (actor.user.display_name || actor.user.username)) || 'you')}</span> <a href="/auth/logout?next=${encodeURIComponent(o.path || '/')}">Sign out</a>`
        : `<a href="/auth/login?next=${encodeURIComponent(o.path || '/')}">Sign in with OpenVibe</a>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
${appIcon.headTags({ site: 'network' })}
${feeds.map((f) => `<link rel="alternate" type="${f.type}" title="${esc(f.title)}" href="${f.href}">`).join('\n')}
<link rel="stylesheet" href="${asset('css/wiki.css')}">
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<script src="${ovServe.url('navbar.js')}" defer></script>
<script src="${ovServe.url('footer.js')}" defer></script>
</head>
<body>
<a class="wk-skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
${frame.noscriptNav({ name: SITE_NAME, home: '/', links: [{ label: 'Spaces', href: '/' }, { label: 'Recent changes', href: '/recent' }, { label: 'Search', href: '/search' }] })}
<header class="wk-bar"><a class="wk-brand" href="/">${SITE_NAME}</a><form class="wk-search" action="/search" method="get" role="search"><label for="wk-q" class="wk-sr">Search the wiki</label><input id="wk-q" name="q" type="search" placeholder="Search the wiki" value="${esc(o.query || '')}"><button type="submit">Search</button></form><noscript><span class="wk-account">${who}</span></noscript></header>
<main id="main" class="wk-main">
${o.body || ''}
</main>
${frame.footer({ service: 'wiki', variant: 'full', updates: '/updates' })}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: navConfig(o, config), footer: { service: 'wiki', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' } }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) OpenVibeNavbar.init(window.__OV_PAGE.navbar); } catch (e) { /* the Frame is optional */ }
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* */ }
});
</script>
</body>
</html>`;
}

module.exports = { renderPage, asset, SITE_NAME, DEFAULT_DESCRIPTION, NETWORK_URL };
