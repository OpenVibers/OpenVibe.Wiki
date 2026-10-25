'use strict';
/**
 * Clients for the services Wiki composes (roadmap §29): Events (outbox relay), Community
 * (discussion threads), Sources (citation items), Media (attachment checks, and pictures a generated wiki
 * uploads) and AI (research and writing for "vibe a wiki"). Each call uses a
 * Network client-credentials token for svc:wiki, minted per audience by the SDK token client.
 * Hiding the thread of a page that stopped being public needs community.comment.moderate.
 *
 * Every integration is optional. Missing configuration or an unreachable service is an explicit
 * failure (an error with a stable code, or `configured: false`), never invented data.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createPgOutbox } = require('openvibe-sdk/events');
const { createDiscussionClient } = require('openvibe-publishing/discussion');
const crypto = require('crypto');

class IntegrationError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SUBJECT_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEDIA_VISIBILITIES = ['public', 'unlisted', 'private'];

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
    // The PostgreSQL outbox (openvibe-sdk/events): rows are written in the change's own transaction
    // (outbox.enqueue(db, …) joins the ambient transaction); several processes relay one table safely (leases).
    const outbox = createPgOutbox(db, {
        events, table: 'wiki_event_outbox', intervalMs: config.eventsRelayIntervalMs, now,
        onError: (err) => log.warn(`[Wiki] event relay: ${err && err.message}`),
    });
    // Counts for metrics (read synchronously at scrape time), refreshed by readiness and a timer.
    const outboxCounts = { pending: 0, rejected: 0 };
    outbox.refreshCounts = async () => {
        const [pending, rejected] = await Promise.all([outbox.pending(), outbox.rejected()]);
        Object.assign(outboxCounts, { pending, rejected });
        return { ...outboxCounts };
    };
    outbox.counts = () => ({ ...outboxCounts });

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

    // ── Media: attached objects (media.object.read, namespace = WIKI_MEDIA_APP) ──
    // Wiki reads with its own authority, which sees the whole namespace; who else may read an object
    // is decided from what Media reports (visibility, owner) — see attachMedia in the wiki service.
    const media = {
        configured: !!(tokenClient && config.mediaInternalUrl),
        publicUrl: (mediaId) => `${config.mediaPublicUrl}/o/${encodeURIComponent(mediaId)}`,
        /**
         * { exists: false, reason: 'not_found'|'deleted' }
         * | { exists: true, visibility: 'public'|'unlisted'|'private'|null, owner: 'usr_…'|null, status }
         * | throws (outage: no verdict).
         */
        async describe(mediaId) {
            if (!media.configured) throw new IntegrationError(503, 'media.unavailable', 'OpenVibe.Media is not configured (OV_MEDIA_INTERNAL_URL)');
            const r = await getJson(`${config.mediaInternalUrl}/api/v2/${encodeURIComponent(config.mediaApp)}/objects/${encodeURIComponent(mediaId)}`, 'openvibe.media');
            if (r.status === 404) return { exists: false, reason: 'not_found' };
            // 401/403 is about Wiki's grant, not about the object: no verdict (check_failed).
            if (r.status === 410) return { exists: false, reason: 'deleted' };
            if (r.status !== 200 || !r.body) throw new IntegrationError(503, 'media.unavailable', `Media answered ${r.status}`);
            const obj = r.body.object || r.body;
            if (obj.lifecycle_status === 'deleted') return { exists: false, reason: 'deleted' };
            const owner = obj.owner && typeof obj.owner.subject === 'string' && SUBJECT_RE.test(obj.owner.subject) ? obj.owner.subject : null;
            return { exists: true, visibility: MEDIA_VISIBILITIES.includes(obj.visibility) ? obj.visibility : null, owner, status: obj.lifecycle_status || null };
        },
        /**
         * The periodic and on-demand check: { exists: true } | { exists: false, reason } | throws.
         * Every reader of a page sees its attachments, so an object that became private in Media is
         * withheld (broken, reason 'forbidden') until it is shared again; Media not saying who may
         * read it is no verdict.
         */
        async resolve(mediaId) {
            const d = await media.describe(mediaId);
            if (!d.exists) return d;
            if (d.visibility === 'private') return { exists: false, reason: 'forbidden' };
            if (d.visibility == null) throw new IntegrationError(503, 'media.unavailable', 'Media did not say who may read the object');
            return { exists: true };
        },
    };

    /**
     * A picture into Media for a page (media.object.upload, namespace WIKI_MEDIA_APP): init, bytes, complete (v2 objects),
     * owned by the person it is uploaded for (X-OV-Subject), public, with where it came from in its metadata.
     * → the object id (med_…). Throws IntegrationError on any refusal.
     */
    media.upload = async function upload({ bytes, mime, filename, owner = null, metadata = {}, timeoutMs = 30000 }) {
        if (!media.configured) throw new IntegrationError(503, 'media.unavailable', 'OpenVibe.Media is not configured (OV_MEDIA_INTERNAL_URL)');
        const base = `${config.mediaInternalUrl}/api/v2/${encodeURIComponent(config.mediaApp)}/objects`;
        const auth = await forAudience('openvibe.media').authHeaders();
        const subject = owner && SUBJECT_RE.test(owner) ? { 'X-OV-Subject': owner } : {};
        const call = async (url, init) => {
            let res;
            try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); } catch (err) {
                throw new IntegrationError(503, 'media.unavailable', `Media did not answer: ${err && err.name === 'TimeoutError' ? 'timeout' : err && err.message}`);
            }
            const body = await res.json().catch(() => null);
            if (res.status === 401) forAudience('openvibe.media').invalidate();
            if (res.status < 200 || res.status > 299) throw new IntegrationError(res.status === 413 || res.status === 415 || res.status === 422 ? 422 : 503, 'media.upload_refused', `Media answered ${res.status}${body && (body.code || body.title) ? ` (${body.code || body.title})` : ''}`);
            return body || {};
        };
        const init = await call(base, {
            method: 'POST', headers: { ...auth, ...subject, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ kind: 'asset', visibility: 'public', mime_type: mime, size_bytes: bytes.length, filename: String(filename || 'picture').slice(0, 120), content_hash: crypto.createHash('sha256').update(bytes).digest('hex'), metadata }),
        });
        const id = init.id || (init.object && init.object.id);
        const up = init.upload || {};
        if (!id || !up.url) throw new IntegrationError(503, 'media.upload_refused', 'Media did not give an upload address');
        // The upload and complete addresses may name Media's public origin; Wiki reaches it on the internal one.
        const internal = (u) => { const x = new URL(u, config.mediaInternalUrl); return `${config.mediaInternalUrl}${x.pathname}${x.search}`; };
        await call(internal(up.url), { method: 'PUT', headers: { ...auth, ...subject, 'Content-Type': mime, ...(up.token ? { 'X-Upload-Token': up.token } : {}) }, body: bytes });
        await call(internal(up.complete_url || `${base}/${encodeURIComponent(id)}/complete`), { method: 'POST', headers: { ...auth, ...subject, 'Content-Type': 'application/json', Accept: 'application/json', ...(up.token ? { 'X-Upload-Token': up.token } : {}) }, body: '{}' });
        return id;
    };

    // ── AI: research and writing for generated wikis (ai.run.create / ai.run.read, namespaces research.* and wiki.*) ──
    const ai = {
        configured: !!(tokenClient && config.aiInternalUrl),
        /**
         * Run a workflow and wait for it: → the run's output. Long runs are polled. Throws IntegrationError with the run's
         * own code when it failed, 429 with retryAfter (seconds) when AI's quota or queue is full.
         */
        async run(workflow, input, { subject = null, idempotencyKey = null, waitMs = 55000, totalMs = 300000, signal = null } = {}) {
            if (!ai.configured) throw new IntegrationError(503, 'ai.unavailable', 'OpenVibe.AI is not configured (OV_AI_INTERNAL_URL)');
            const headers = async () => ({ ...(await forAudience('openvibe.ai').authHeaders()), 'Content-Type': 'application/json', Accept: 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) });
            const call = async (url, init) => {
                let res;
                try { res = await fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(waitMs + 15000)]) : AbortSignal.timeout(waitMs + 15000) }); } catch (err) {
                    throw new IntegrationError(503, 'ai.unavailable', `OpenVibe.AI did not answer: ${err && err.name === 'TimeoutError' ? 'timeout' : err && err.message}`);
                }
                const body = await res.json().catch(() => null);
                if (res.status === 401) forAudience('openvibe.ai').invalidate();
                if (res.status === 429) throw Object.assign(new IntegrationError(429, (body && body.code) || 'ai.busy', (body && (body.detail || body.title)) || 'OpenVibe.AI is busy'), { retryAfter: Number(res.headers.get('retry-after')) || 60 });
                if (res.status >= 400) throw new IntegrationError(res.status >= 500 ? 503 : res.status, (body && body.code) || 'ai.refused', (body && (body.detail || body.title)) || `OpenVibe.AI answered ${res.status}`);
                return body && body.run;
            };
            const body = { workflow, input, ...(subject ? { on_behalf_of: { type: 'user', id: subject }, attribution: { service: 'wiki', type: 'user', id: subject } } : {}) };
            let run = await call(`${config.aiInternalUrl}/api/v1/runs?wait=${waitMs}`, { method: 'POST', headers: await headers(), body: JSON.stringify(body) });
            const until = Date.now() + totalMs;
            while (run && !['succeeded', 'cached', 'failed', 'cancelled'].includes(run.status)) {
                if (Date.now() > until) throw new IntegrationError(504, 'ai.timeout', `${workflow} did not finish in ${Math.round(totalMs / 1000)} s`);
                await new Promise((r) => setTimeout(r, 3000));
                run = await call(`${config.aiInternalUrl}/api/v1/runs/${encodeURIComponent(run.id)}`, { method: 'GET', headers: await headers() });
            }
            if (!run) throw new IntegrationError(503, 'ai.unavailable', 'OpenVibe.AI answered without a run');
            if (run.status === 'failed' || run.status === 'cancelled') {
                const e = run.error || {};
                throw new IntegrationError(e.code === 'quota.exceeded' || e.code === 'govern.exceeded' ? 429 : 502, e.code || 'ai.run_failed', e.detail || e.message || `${workflow} ${run.status}`);
            }
            return { output: run.output, runId: run.id, synthetic: Boolean(run.synthetic), provenance: run.provenance || null };
        },
    };

    // ── VIP: VIP spaces and pages (WS-K task 8) ──
    const vip = require('./vip').createVip({ config, tokenClient, fetchImpl, now, log });

    return {
        tokenClient, sdk, events, outbox, community, sources, media, ai, vip,
        eventsConfigured: !!(tokenClient && config.eventsUrl),
    };
}

module.exports = { createPlatform, IntegrationError };
