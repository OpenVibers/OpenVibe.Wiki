'use strict';
/**
 * OpenVibe.VIP — who may read a VIP space or page (roadmap WS-K task 8). Wiki asks VIP's gated-resource
 * policy (POST /api/v1/policies/evaluate, capability vip.resource.policy.evaluate, a client-credentials
 * token for audience openvibe.vip) with:
 *
 *   resource  { service: 'wiki', type: 'page' | 'space', id }   the page when the page itself is VIP-only,
 *                                                               else its space (access.js vipResource)
 *   owner     the space's owner subject: the creator whose members may read. An official space has no
 *             owner in VIP, so its VIP content admits only the space's roles and staff.
 *   fallback  { requirement: 'member', binding: 'wiki:gated_page' }: any active member of the owner, or,
 *             when the owner defines a perk bound to `wiki gated_page`, a member whose plan version includes
 *             it. A rule the owner sets in VIP for the page or space wins.
 *
 * Answers go through openvibe-sdk/vip's createVipCache: a "yes" lives at most vip.ttlMs (never past the
 * entitlement's expiry), a "no" denyTtlMs, a failure unavailableTtlMs. `sensitive` asks VIP in
 * authoritative mode (VIP asks Billing directly; never cached): exports and attachment downloads. Every
 * failure is a refusal.
 */
const { createVipClient, createVipCache } = require('openvibe-sdk/vip');

const FALLBACK = Object.freeze({ requirement: 'member', binding: 'wiki:gated_page' });
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createVip({ config, tokenClient = null, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const v = config.vip;
    const tokens = tokenClient ? {
        authHeaders: () => tokenClient.authHeaders({ audience: 'openvibe.vip' }),
        invalidate: () => tokenClient.invalidate && tokenClient.invalidate({ audience: 'openvibe.vip' }),
    } : null;
    const client = tokens ? createVipClient({ baseUrl: v.internalUrl, tokenClient: tokens, fetch: fetchImpl, timeoutMs: v.timeoutMs, log }) : null;
    const cache = client ? createVipCache({ vip: client, ttlMs: v.ttlMs, denyTtlMs: v.denyTtlMs, unavailableTtlMs: v.unavailableTtlMs, now }) : null;

    /** May `subject` read `resource` of `space`? → { allow, reason } (never throws). */
    async function decide({ subject, space, resource, sensitive = false }) {
        if (!cache) return { allow: false, reason: 'vip_not_configured' };
        if (!space || !SUBJECT_RE.test(String(space.owner || ''))) return { allow: false, reason: 'no_owner' };
        if (!subject) return { allow: false, reason: 'not_signed_in' };
        try {
            const d = await cache.evaluate({ subject, resource: { service: 'wiki', type: resource.type, id: String(resource.id) }, owner: space.owner, fallback: FALLBACK, ...(sensitive ? { mode: 'authoritative' } : {}) });
            return { allow: d.allow === true, reason: d.reason || (d.allow === true ? 'member' : 'denied') };
        } catch (err) {
            return { allow: false, reason: 'vip_unavailable', error: err.message };
        }
    }

    /** Where a reader joins the owner's plans. */
    const joinUrl = (ownerSubject) => (ownerSubject ? `${v.publicUrl}/${encodeURIComponent(ownerSubject)}` : v.publicUrl);

    return { configured: !!cache, decide, joinUrl, FALLBACK, cache };
}

module.exports = { createVip, FALLBACK };
