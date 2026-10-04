'use strict';
/**
 * Page shell: every page is server-rendered through this, as openvibe-publishing/layout's document
 * (openvibe-shared/shell page()). The <head> SEO block has robots always explicit: the indexability
 * gate's decision for articles, an explicit string for the rest (noindex for editing surfaces). The
 * OpenVibe Frame (app icon, SSR footer, a <noscript> navigation) comes with the shell, plus the
 * Network's navbar.js/footer.js as progressive enhancement. Nothing on the page needs JavaScript
 * to be read, navigated, edited or submitted.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const layout = require('openvibe-publishing/layout');
const { escapeHtml: esc } = require('openvibe-publishing/ssr');

const SITE_NAME = 'OpenVibe.Wiki';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'OpenVibe.Wiki: wiki spaces with page trees, revision history, citations and discussion, part of the OpenVibe network.';
const NAV_LINKS = [
    { label: 'Spaces', href: '/' },
    { label: 'Recent changes', href: '/recent' },
    { label: 'Search', href: '/search' },
];
const FOOTER = { service: 'wiki', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
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
/** The ?v= this process renders for a public/ file (the static route caches only that one as immutable). */
function assetVersion(rel) { asset(rel); return hashes.get(rel); }

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

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
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
}

/**
 * o: title, description, path (canonical path), robots or decision (one is required: the gate's
 * decision for an article, an explicit string for every other page), head (extra head HTML, added
 * after the shared tags), jsonLd, ogType, body, active, actor, config, feeds, styles, query
 */
function renderPage(o) {
    const { config } = o;
    if (!o.robots && !o.decision) throw new TypeError('renderPage needs explicit robots (or the gate decision)');
    const feeds = o.feeds === false ? [] : [
        { type: 'atom', title: `${SITE_NAME}: recent changes (Atom)`, href: '/feed.atom' },
        { type: 'json', title: `${SITE_NAME}: recent changes (JSON Feed)`, href: '/feed.json' },
    ];
    const actor = o.actor || { kind: 'anonymous' };
    const who = actor.kind === 'user'
        ? `<span class="wk-who">Signed in as ${esc((actor.user && (actor.user.display_name || actor.user.username)) || 'you')}</span> <a href="/auth/logout?next=${encodeURIComponent(o.path || '/')}">Sign out</a>`
        : `<a href="/auth/login?next=${encodeURIComponent(o.path || '/')}">Sign in with OpenVibe</a>`;
    return layout.renderDocument({
        site: 'wiki',
        siteName: SITE_NAME,
        lang: 'en',
        title: o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME,
        description: o.description || DEFAULT_DESCRIPTION,
        canonical: `${config.baseUrl}${o.path || '/'}`,
        decision: o.decision,
        robots: o.robots,
        type: o.ogType || 'website',
        jsonLd: [].concat(o.jsonLd || []),
        feeds,
        navbar: navConfig(o, config),
        footer: FOOTER,
        navLinks: NAV_LINKS,
        home: '/',
        iconSite: 'network',
        css: asset('css/wiki.css'),
        styles: o.styles,
        release: RELEASE,
        mainClass: 'wk-main',
        header: `<header class="wk-bar"><a class="wk-brand" href="/">${SITE_NAME}</a><form class="wk-search" action="/search" method="get" role="search"><label for="wk-q" class="wk-sr">Search the wiki</label><input id="wk-q" name="q" type="search" placeholder="Search the wiki" value="${esc(o.query || '')}"><button type="submit">Search</button></form><noscript><span class="wk-account">${who}</span></noscript></header>`,
        body: o.body,
        head: o.head,
    });
}

module.exports = { renderPage, asset, setRelease, SITE_NAME, DEFAULT_DESCRIPTION, NETWORK_URL, assetVersion };
