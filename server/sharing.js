'use strict';

/**
 * Sharing for Wiki pages and drafts (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; openvibe-sdk/share).
 *
 * The SDK owns the model and the rules: the `shares` row next to each page, the one access check
 * (canView), members, access requests, transfers, the append-only log and the delivery queue. This
 * file is the wiring a service supplies:
 *
 *   - network.json       Network's identity lookups (@name → subject, and a person's card for the sheet)
 *   - events.publish     Wiki's own Events outbox, so share.* envelopes go out with every other wiki.* event
 *   - notify             Network's notification push; a refusal is logged, never allowed to stall the queue
 *   - onAudienceChange   keeps wiki_pages.visibility in step (public→public, link→unlisted, people→private,
 *                        private→private), so an old reader that only knows the column fails closed, and
 *                        re-syncs Search so a page that leaves Everyone is tombstoned at once
 *   - onOwnerChange      moves wiki_pages.created_by to the new owner
 *
 * A draft is registered private (Only me). The sheet on the draft can name people ("look at this
 * before I publish it"); the page at /w/:space/:slug is the link, and it answers with the gate,
 * never the text, to anyone not on the list. `members` (OpenVibe.VIP) is the fifth audience that
 * already existed on Blog; the sheet never offers it, and canReadPost keeps deciding it the old way.
 */
const { createShares } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'wiki';
const KIND = 'page';
const AUDIENCES = ['public', 'link', 'people', 'private'];
/** Wiki's visibility words to the SDK's, and back. `members` and `vip` are not share audiences. */
const TO_SDK = { public: 'public', members: 'private', vip: 'private', private: 'private' };
const FROM_SDK = { public: 'public', link: 'private', people: 'private', private: 'private' };

const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Blog's viewer as the SDK wants it: a subject object, and the staff bit. */
function shareViewer(v) {
    if (!v || !v.subject) return null;
    if (String(v.subject).startsWith('usr_')) return { subject: { type: 'user', id: v.subject }, staff: !!v.staff };
    if (String(v.subject).startsWith('gst_')) return { subject: { type: 'guest', id: v.subject }, staff: !!v.staff };
    return null;
}

function createSharing({ db, config, outbox, now = Date.now, fetchImpl = globalThis.fetch, log = console } = {}) {
    let reindex = null;
    const base = String(config.networkInternalUrl || config.networkUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(`${base}${path}`);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}: ${(body && (body.detail || body.error)) || 'failed'}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification, addressed by canonical subject. It never carries a page's title or text. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A wiki page was shared with you', 'Open it on OpenVibe.Wiki.'],
            'share.access_requested': ['Someone asked for access to your page', 'Review the request on OpenVibe.Wiki.'],
            'share.transfer.requested': ['Someone wants to give you a page', 'Accept or decline it on OpenVibe.Wiki.'],
            'share.transfer.answered': ['A page transfer was answered', 'See what happened on OpenVibe.Wiki.'],
        }[n.kind] || ['Sharing on OpenVibe.Wiki', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'wiki', url: config.baseUrl,
                    category: 'social',
                },
            });
        } catch (err) {
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }

    /** The row's audience change keeps the old column in step and re-indexes (a no-op when already there). */
    async function onAudienceChange(ref, audience, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const row = await tx.maybe('SELECT state, visibility FROM wiki_pages WHERE id = $1', [ref.id]);
        if (!row) return;
        const visibility = FROM_SDK[audience] || 'private';
        // `members` and `vip` have no share audience: leave those columns alone (canReadPage keeps deciding them).
        if (!(row.visibility === 'members' || row.visibility === 'vip')) {
            await tx.exec('UPDATE wiki_pages SET visibility = $1, updated_at = $3 WHERE id = $2', [visibility, ref.id, now()]);
        }
        tx.afterCommit(async () => {
            try { if (reindex) await reindex(ref.id); }
            catch (err) { log.warn('[Sharing] search sync:', err.message); }
        });
    }

    async function onOwnerChange(ref, from, to, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const owner = to && to.type === 'user' ? to.id : null;
        await tx.exec('UPDATE wiki_pages SET created_by = $1, updated_at = $3 WHERE id = $2', [owner, ref.id, now()]);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish: async (envelope) => await outbox.emit(envelope) },
        notify,
        onAudienceChange,
        onOwnerChange,
    });

    const sv = (viewer) => shareViewer(viewer);
    const at = (id) => refOf(id);

    return {
        shares,
        SERVICE,
        KIND,
        AUDIENCES,
        refOf,
        shareViewer,
        /** Wiki's own indexer, attached by the wiki service once it exists (onAudienceChange calls it after the commit). */
        attach: (fn) => { reindex = fn; },
        /** Register a page with the sharing system (inside the page's own transaction). */
        register: async (viewer, id, audience = 'private') => await shares.register(at(id), {
            owner_subject: viewer && viewer.subject ? { type: String(viewer.subject).startsWith('gst_') ? 'guest' : 'user', id: viewer.subject } : { type: 'service', id: SERVICE },
            audience: TO_SDK[audience] || 'private',
        }),
        /**
         * The service's own audience move (a create form, the editor's select, a publish). The caller
         * has already passed access.canWrite and owns the column and the Search sync; this only keeps
         * the share row in step. The SDK's owner check is for people using the sheet.
         */
        syncAudience: async (id, audience) => {
            const next = TO_SDK[audience] || 'private';
            await db.tx(async (t) => {
                const row = await t.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3 FOR UPDATE', [SERVICE, KIND, String(id)]);
                if (!row || row.audience === next) return;
                await t.exec('UPDATE shares SET audience = $1, revision = revision + 1 WHERE service = $2 AND kind = $3 AND resource_id = $4', [next, SERVICE, KIND, String(id)]);
            });
        },
        shareOf: async (id) => await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(id)]),
        canView: async (viewer, id) => await shares.canView(sv(viewer), at(id)),
        canEdit: async (viewer, id) => await shares.canEdit(sv(viewer), at(id)),
        get: async (viewer, id) => await shares.get(sv(viewer), at(id)),
        getWithRevision: async (viewer, id) => await shares.getWithRevision(sv(viewer), at(id)),
        setAudience: async (viewer, id, audience) => await shares.setAudience(sv(viewer), at(id), TO_SDK[audience] || 'private'),
        addMembers: async (viewer, id, list) => await shares.addMembers(sv(viewer), at(id), list),
        removeMember: async (viewer, id, subject) => await shares.removeMember(sv(viewer), at(id), subject),
        update: async (viewer, id, body, opts) => await shares.update(sv(viewer), at(id), body, opts),
        requestAccess: async (viewer, id) => await shares.requestAccess(sv(viewer), at(id)),
        dismiss: async (viewer, id, requestId) => await shares.dismiss(sv(viewer), at(id), requestId),
        transfer: async (viewer, id, input) => await shares.transfer(sv(viewer), at(id), input),
        accept: async (viewer, id, transferId) => await shares.accept(sv(viewer), at(id), transferId),
        decline: async (viewer, id, transferId) => await shares.decline(sv(viewer), at(id), transferId),
        cancel: async (viewer, id, transferId) => await shares.cancel(sv(viewer), at(id), transferId),
        lookup: async (viewer, name) => await shares.lookup(sv(viewer), name),
        sharedWithMe: async (viewer, opts) => await shares.sharedWithMe(sv(viewer), { service: SERVICE, ...(opts || {}) }),
        /** Expire members and transfers, then send queued events and notifications. */
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

/** The uniform API's describe(ref): the sheet shows the page's title and link to its owner. */
function describeRef(db, config) {
    return async (ref) => {
        if (ref.service !== SERVICE || ref.kind !== KIND) return {};
        const page = await db.maybe(`SELECT p.id, p.slug, p.title, p.state, s.slug AS space_slug
            FROM wiki_pages p JOIN wiki_spaces s ON s.id = p.space_id WHERE p.id = $1 AND p.state <> 'deleted'`, [ref.id]);
        if (!page) return {};
        const link = `/w/${page.space_slug}/${page.slug}`;
        return {
            title: page.title || 'Untitled',
            link: `${String(config.baseUrl || '').replace(/\/+$/, '')}${link}`,
            roles: ['viewer'],
            audiences: AUDIENCES,
            transferable: true,
        };
    };
}

module.exports = { createSharing, describeRef, shareViewer, refOf, AUDIENCES, TO_SDK, FROM_SDK, SERVICE, KIND };
