'use strict';
/**
 * Clients for the services Wiki composes (roadmap §29): Events (outbox relay), Community
 * (discussion threads), Sources (citation items) and Media (attachment checks). Each call uses a
 * Network client-credentials token for svc:wiki, minted per audience by the SDK token client.
 * Hiding the thread of a page that stopped being public needs community.comment.moderate.
 *
 * Every integration is optional. Missing configuration or an unreachable service is an explicit
 * failure (an error with a stable code, or `configured: false`), never invented data.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');
const { createDiscussionClient } = require('openvibe-publishing/discussion');

class IntegrationError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SUBJECT_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;

function createPlatform({ config, db, fetchImpl = globalThis.fetch, tokens = null, now = () => Date.now(), log = console } = {}) {
    const tokenClient = tokens || (config.oauth.clientSecret
        ? createServiceTokenClient({ network: config.networkInternalUrl || config.networkUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : null);
    const forAudience = (audience) => ({
        authHeaders: () => {
            if (!tokenClient) throw new IntegrationError(503, 'wiki.principal_unconfigured', 'OV_OAUTH_CLIENT_SECRET is not set: Wiki has no service token');
            return tokenClient.authHeaders({ audience });
        },
        invalidate: () => tokenClient && tokenClient.invalidate({ audience }),
    });

    // ── Events: the outbox always records; the relay runs only with EVENTS_URL ──
    const sdk = createClient({
        fetch: fetchImpl,
        network: config.networkUrl,
        autoDiscover: false,
        ...(tokenClient ? { tokenProvider: tokenClient } : {}),
        baseUrls: config.eventsUrl ? { events: config.eventsUrl } : {},
        onWarning: (msg) => log.warn(`[Wiki] ${msg}`),
    });
    const events = createEventsClient(sdk, { source: 'wiki' });
    const outbox = createOutbox(db, {
        events, table: 'wiki_event_outbox', intervalMs: config.eventsRelayIntervalMs, now,
        onError: (err) => log.warn(`[Wiki] event relay: ${err && err.message}`),
    });
    outbox.ensureSchema();

    async function getJson(url, audience, { headers = {}, timeoutMs = 5000 } = {}) {
        let res;
        try {
            res = await fetchImpl(url, { headers: { Accept: 'application/json', ...(await forAudience(audience).authHeaders()), ...headers }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            if (err instanceof IntegrationError) throw err;
            throw new IntegrationError(503, 'upstream.unavailable', `${new URL(url).host} did not answer: ${err && err.name === 'TimeoutError' ? 'timeout' : err && err.message}`);
        }
        const body = await res.json().catch(() => null);
        if (res.status === 401) forAudience(audience).invalidate();
        return { status: res.status, body };
    }

    // ── Community: comment threads (reference, never copy) ──
    const communityBase = config.communityInternalUrl || config.communityUrl;
    const discussionClient = createDiscussionClient({ communityUrl: communityBase, tokenClient: forAudience('openvibe.community'), fetchImpl });
    const community = {
        configured: !!(tokenClient && communityBase),
        resolveThread: (ref, opts) => discussionClient.resolveThread(ref, opts),
        async getThread(threadId, { subject } = {}) {
            const headers = subject && SUBJECT_RE.test(subject) ? { 'X-OV-Subject': subject } : {};
            const r = await getJson(`${communityBase}/api/v1/comments/threads/${encodeURIComponent(threadId)}?limit=50`, 'openvibe.community', { headers });
            if (r.status === 404) throw new IntegrationError(404, 'thread.not_found', 'The discussion thread no longer exists');
            if (r.status !== 200 || !r.body || !r.body.thread) throw new IntegrationError(503, 'discussion.unavailable', `Community answered ${r.status}`);
            return r.body;
        },
        async addComment(threadId, { subject, message }) {
            if (!SUBJECT_RE.test(String(subject || ''))) throw new IntegrationError(403, 'wiki.person_required', 'Only a signed-in person can comment');
            let res;
            try {
                res = await fetchImpl(`${communityBase}/api/v1/comments/threads/${encodeURIComponent(threadId)}/comments`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-OV-Subject': subject, ...(await forAudience('openvibe.community').authHeaders()) },
                    body: JSON.stringify({ message: String(message || '').slice(0, 5000) }),
                    signal: AbortSignal.timeout(5000),
                });
            } catch (err) {
                if (err instanceof IntegrationError) throw err;
                throw new IntegrationError(503, 'discussion.unavailable', 'Community did not answer');
            }
            const body = await res.json().catch(() => null);
            if (res.status !== 201 && res.status !== 200) {
                throw new IntegrationError(res.status >= 500 ? 503 : res.status, (body && body.code) || 'discussion.unavailable', (body && (body.detail || body.error)) || `Community answered ${res.status}`);
            }
            return body;
        },
        /**
         * Hide a page's thread (the page was unpublished, deleted or stopped being public) or show
         * it again ('public'). Needs community.comment.moderate. Throws on failure; the caller
         * treats it as best effort.
         */
        async setThreadVisibility(threadId, visibility) {
            if (!community.configured) throw new IntegrationError(503, 'discussion.unavailable', 'OpenVibe.Community is not configured');
            if (visibility !== 'public' && visibility !== 'hidden') throw new IntegrationError(422, 'discussion.invalid_visibility', 'visibility is public or hidden');
            let res;
            try {
                res = await fetchImpl(`${communityBase}/api/v1/comments/threads/${encodeURIComponent(threadId)}/visibility`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokenClient.authHeaders({ audience: 'openvibe.community', scope: 'community.comment.moderate' })) },
                    body: JSON.stringify({ visibility }),
                    signal: AbortSignal.timeout(5000),
                });
            } catch (err) {
                throw new IntegrationError(503, 'discussion.unavailable', `Community did not answer: ${err && err.message}`);
            }
            const body = await res.json().catch(() => null);
            if (res.status === 401) forAudience('openvibe.community').invalidate();
            if (!res.ok) throw new IntegrationError(res.status >= 500 ? 503 : res.status, (body && body.code) || 'discussion.unavailable', (body && (body.detail || body.error)) || `Community answered ${res.status}`);
            return true;
        },
    };

    // ── Sources: citation items (sources.item@1) ──
    const sources = {
        configured: !!(tokenClient && config.sourcesInternalUrl),
        async getItem(id) {
            if (!/^itm_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) throw new IntegrationError(422, 'citation.invalid_source_item', 'A Sources item id looks like itm_<ULID>');
            if (!sources.configured) throw new IntegrationError(503, 'sources.unavailable', 'OpenVibe.Sources is not configured (OV_SOURCES_INTERNAL_URL)');
            const r = await getJson(`${config.sourcesInternalUrl}/api/v1/items/${encodeURIComponent(id)}`, 'openvibe.sources');
            if (r.status === 404) throw new IntegrationError(422, 'citation.source_item_not_found', `Sources has no item ${id}`);
            if (r.status !== 200 || !r.body || !r.body.item) throw new IntegrationError(503, 'sources.unavailable', `Sources answered ${r.status}`);
            return r.body.item;
        },
    };

    // ── Media: does an attached object still exist? (media.object.read, namespace = WIKI_MEDIA_APP) ──
    const media = {
        configured: !!(tokenClient && config.mediaInternalUrl),
        publicUrl: (mediaId) => `${config.mediaPublicUrl}/o/${encodeURIComponent(mediaId)}`,
        /** { exists: true } | { exists: false, reason } | throws (outage: no verdict). */
        async resolve(mediaId) {
            if (!media.configured) throw new IntegrationError(503, 'media.unavailable', 'OpenVibe.Media is not configured (OV_MEDIA_INTERNAL_URL)');
            const r = await getJson(`${config.mediaInternalUrl}/api/v2/${encodeURIComponent(config.mediaApp)}/objects/${encodeURIComponent(mediaId)}`, 'openvibe.media');
            if (r.status === 404) return { exists: false, reason: 'not_found' };
            // 401/403 is about Wiki's grant, not about the object: no verdict (check_failed).
            if (r.status === 410) return { exists: false, reason: 'deleted' };
            if (r.status !== 200 || !r.body) throw new IntegrationError(503, 'media.unavailable', `Media answered ${r.status}`);
            const obj = r.body.object || r.body;
            if (obj.lifecycle_status === 'deleted') return { exists: false, reason: 'deleted' };
            return { exists: true };
        },
    };

    return {
        tokenClient, sdk, events, outbox, community, sources, media,
        eventsConfigured: !!(tokenClient && config.eventsUrl),
    };
}

module.exports = { createPlatform, IntegrationError };
