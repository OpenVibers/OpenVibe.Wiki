'use strict';
/**
 * OpenVibe.Wiki configuration. load(env) is pure so tests build their own config; the process
 * entry calls load() with process.env after dotenv.
 */

function list(value, fallback) {
    return String(value == null || value === '' ? fallback : value).split(',').map((s) => s.trim()).filter(Boolean);
}
const trim = (u) => String(u || '').replace(/\/+$/, '');
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4800);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.wiki' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    return {
        serviceId: 'wiki',
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl,
        trustProxy: env.TRUST_PROXY != null && env.TRUST_PROXY !== '' ? Number(env.TRUST_PROXY) : 2,
        dbPath: env.WIKI_DB_PATH || './data/wiki.db',

        // Identity: OpenVibe.Network signs user JWTs (SSO) and service tokens (client credentials).
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? String(env.OV_NETWORK_PUBLIC_KEY).replace(/\\n/g, '\n') : null,
        // A browser's user JWT is accepted when its aud contains one of these.
        userAudiences: list(env.WIKI_USER_AUDIENCES, 'openvibe.wiki,openvibe.network'),
        // Service tokens presented to this API must be minted for this audience.
        audience: 'openvibe.wiki',

        // OAuth client `wiki` (browser sign-in) and service principal `svc:wiki` (same credentials).
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'wiki',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile theme',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // Other services (all optional: each integration degrades to an explicit failure state).
        eventsUrl: trim(env.EVENTS_URL || ''),
        eventsRelayIntervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
        communityUrl: trim(env.OV_COMMUNITY_URL || 'https://openvibe.community'),
        communityInternalUrl: trim(env.OV_COMMUNITY_INTERNAL_URL || ''),
        sourcesInternalUrl: trim(env.OV_SOURCES_INTERNAL_URL || ''),
        mediaInternalUrl: trim(env.OV_MEDIA_INTERNAL_URL || ''),
        mediaPublicUrl: trim(env.OV_MEDIA_URL || 'https://openvibe.media'),
        // Media namespace (app) Wiki's attachments live in, checked with media.object.read.
        mediaApp: env.WIKI_MEDIA_APP || 'wiki',
        mediaVerifyIntervalMs: int(env.WIKI_MEDIA_VERIFY_INTERVAL_MS, 6 * 60 * 60 * 1000),

        // OpenVibe.VIP: who may read a VIP space or page (server/integrations/vip.js, WS-K task 8).
        vip: {
            internalUrl: trim(env.OV_VIP_INTERNAL_URL || 'http://127.0.0.1:4620'),
            publicUrl: trim(env.OV_VIP_URL || 'https://openvibe.vip'),
            timeoutMs: int(env.WIKI_VIP_TIMEOUT_MS, 2000),
            ttlMs: int(env.WIKI_VIP_CACHE_TTL_MS, 30_000),
            denyTtlMs: int(env.WIKI_VIP_CACHE_DENY_TTL_MS, 10_000),
            unavailableTtlMs: int(env.WIKI_VIP_CACHE_UNAVAILABLE_TTL_MS, 2_000),
        },

        // Scheduled publication worker.
        scheduleIntervalMs: int(env.WIKI_SCHEDULE_INTERVAL_MS, 15000),
        workerId: env.WIKI_WORKER_ID || `wiki-${process.pid}`,

        // The indexability gate policy for wiki pages (openvibe-publishing/seo).
        gate: {
            minWords: int(env.WIKI_GATE_MIN_WORDS, 80),
            requireSources: env.WIKI_GATE_REQUIRE_SOURCES ? env.WIKI_GATE_REQUIRE_SOURCES === 'true' : true,
            minSources: int(env.WIKI_GATE_MIN_SOURCES, 1),
        },
    };
}

module.exports = { load };
