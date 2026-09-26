'use strict';
/**
 * OpenVibe.Wiki — Express app factory. server/index.js starts it; tests build their own.
 *
 *   Pages (SSR, useful without JavaScript)      server/http/pages.js
 *   /api/v1 (people and service principals)     server/http/api.js
 *   Discovery: robots, sitemaps, feeds, llms    server/http/machine.js
 *   /auth/* (Network SSO)                       server/auth/session.js
 *   GET /api/health, /api/ready, /release.json, /metrics (loopback only)
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { createReadiness } = require('openvibe-shared/ready');
const { createSessionRoutes } = require('./auth/session');
const { createApi } = require('./http/api');
const { createPages } = require('./http/pages');
const { createMachine } = require('./http/machine');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

function createApp({ config, svc, viewers, platform, keys, db, log = console, rateLimits = true, fetchImpl = globalThis.fetch }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);

    const release = require('openvibe-shared/release').createRelease({ service: 'wiki', root: path.join(__dirname, '..') });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'wiki', release: release.release });
    metrics.registry.gauge({
        name: 'wiki_event_outbox', help: 'Events in the outbox by state', labelNames: ['state'],
        collect: () => [{ labels: { state: 'pending' }, value: platform.outbox.pending() }, { labels: { state: 'rejected' }, value: platform.outbox.rejected() }],
    });

    app.use((req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.set('Content-Security-Policy', [
            "default-src 'self'",
            // Cloudflare Web Analytics: Cloudflare injects its beacon at the edge and the privacy text says it may
            // measure performance; script-src loads the beacon, connect-src is where it reports.
            "script-src 'self' 'unsafe-inline' https://openvibe.network https://static.cloudflareinsights.com",
            "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com https://cdnjs.cloudflare.com",
            "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
            "img-src 'self' data: https:",
            "connect-src 'self' https://openvibe.network https://cloudflareinsights.com",
            "frame-src 'self' https://openvibe.network",
            "frame-ancestors 'self'",
            "form-action 'self' https://openvibe.network",
            "base-uri 'self'",
            "object-src 'none'",
        ].join('; '));
        next();
    });
    app.use(cookieParser());

    const limiter = (windowMs, max) => (rateLimits ? rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false }) : (_q, _s, n) => n());
    app.use('/auth/', limiter(15 * 60000, 60));
    app.use('/auth', createSessionRoutes({ config, viewers, log, fetchImpl }));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'wiki', service: 'wiki', host: 'openvibe.wiki', name: 'OpenVibe.Wiki', profile: 'ugc' })); }

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-wiki', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const ready = createReadiness({
        service: 'wiki', release: release.release,
        checks: [
            { name: 'db', required: true, check: () => db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'wiki_pages'").get().n === 1 || 'wiki tables missing' },
            { name: 'network_jwks', required: false, check: () => { if (keys.loaded()) return true; keys.ensure().catch(() => {}); return 'Network signing key not loaded yet: sign-in and token calls answer 503'; } },
            { name: 'events_relay', required: false, check: () => (platform.eventsConfigured ? true : 'EVENTS_URL or the service principal is not configured: events wait in the outbox') },
            { name: 'community', required: false, check: () => platform.community.configured || 'not configured: discussions show as unavailable' },
            { name: 'sources', required: false, check: () => platform.sources.configured || 'not configured: Sources item citations are refused (URL citations work)' },
            { name: 'media', required: false, check: () => platform.media.configured || 'not configured: attachments are not checked against Media' },
        ],
        details: () => ({ outbox: { pending: platform.outbox.pending(), rejected: platform.outbox.rejected() } }),
    });
    app.get('/api/ready', ready.handler);

    // Imports are the heaviest writes (up to 200 pages in one transaction): a few per hour.
    app.post(['/api/v1/spaces/:space/import', '/s/:space/import'], limiter(60 * 60000, 20));
    // A word diff of two very different 200,000-character revisions costs a few hundred ms of CPU
    // and tens of MB (openvibe-publishing/diff caps the search at 4000 edits): per address, not per crawl.
    app.get(['/w/:space/:slug/diff/:a/:b', '/api/v1/pages/:id/diff'], limiter(60000, 30));
    app.use('/api/', limiter(60000, 300));
    app.use('/api/v1', createApi({ svc, viewers, platform, config, log }));
    app.use('/api', (req, res) => require('openvibe-contracts').http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found' }));

    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res) { res.setHeader('Cache-Control', res.req && res.req.query && res.req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'); },
    }));
    app.use(createMachine({ svc, config }));

    app.post(['/new-space', '/s/*', '/w/*', '/proposals/*'], limiter(10 * 60000, 120));
    // Search scans the text of every published page (LIKE): a person's pace, not a crawler's.
    app.get('/search', limiter(60000, 60));
    const pages = createPages({ svc, viewers, platform, config, log });
    app.use(pages.router);

    app.use((req, res) => pages.errorPage(req, res, 404, 'Page not found', 'Nothing lives at that address.'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Wiki]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) return require('openvibe-contracts').http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error' });
        res.status(500).set('Cache-Control', 'private, no-store').type('text/plain').send('Something went wrong on our side. Please try again.');
    });
    return app;
}

module.exports = { createApp };
