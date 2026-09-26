'use strict';
/**
 * Who may do what in a space. One place, used by the pages, the API and the event fan-out.
 *
 * Actors (server/auth/viewer.js):
 *   { kind: 'anonymous' }
 *   { kind: 'user', subject: 'usr_…'|null, staff }             Network SSO (browser or Bearer)
 *   { kind: 'service', service: 'svc:x', claims, subject }     service token; acts for X-OV-Subject if given
 *   { kind: 'system', service: 'svc:wiki' }                    this service's own workers and seed
 *
 * Space visibility: public (anyone), members (any signed-in OpenVibe account), vip (the space owner's
 * OpenVibe.VIP members, plus anyone with a role in the space), private (only subjects holding a role in
 * the space). A page's own visibility can only narrow its space's.
 *
 * VIP (roadmap WS-K task 8): the decision is VIP's (../integrations/vip.js), made per resource: the page
 * when the page itself is VIP-only, else its space. It is asynchronous, so routes resolve it BEFORE they
 * render: prepareVip(actor, [{ space, page? }]) asks VIP (cached; `sensitive` asks authoritatively) and
 * records the answers on the actor (actor.vipAllowed, actor.vipDenied). The synchronous checks below then
 * read them. Anything not prepared is not readable (fail closed), so VIP content never leaks into a list,
 * a link preview or a feed that did not ask.
 * Roles: owner (everything, incl. roles and settings), editor (write revisions, publish, revert,
 * review AI proposals), viewer (read a private space). Network staff (admin, global_mod) act as
 * owner of official spaces; they get no silent access to user spaces.
 * A service acting for a person gets that person's rights (and must hold the route's capability);
 * a service acting as itself reads public content only and writes nothing that needs a person.
 */
const RANK = { public: 0, members: 1, vip: 2, private: 3 };
const VISIBILITIES = ['public', 'members', 'vip', 'private'];

/** The VIP resource a 'vip' read is decided on: the page when it is VIP-only itself, else its space. */
function vipResource(space, page) {
    return page && page.visibility === 'vip' ? { type: 'page', id: page.id } : { type: 'space', id: space.id };
}
const vipKey = (space, page) => { const r = vipResource(space, page); return `${r.type}:${r.id}`; };

function strictest(a, b) { return RANK[a] >= RANK[b] ? a : b; }

function effectiveVisibility(space, page) {
    return page ? strictest(space.visibility, page.visibility) : space.visibility;
}

function createAccess(db, { vip = null } = {}) {
    const roleOf = db.prepare('SELECT role FROM wiki_permissions WHERE space_id = ? AND subject = ?');

    /** 'owner' | 'editor' | 'viewer' | null */
    function role(space, actor) {
        if (!actor || !space) return null;
        if (actor.kind === 'system') return 'owner';
        const subject = actor.subject || null;
        if (actor.kind === 'user' && actor.staff && space.kind === 'official') return 'owner';
        if (!subject) return null;
        if (space.owner === subject) return 'owner';
        const r = roleOf.get(space.id, subject);
        return r ? r.role : null;
    }

    function isPerson(actor) { return !!(actor && actor.subject && /^usr_/.test(actor.subject)); }

    function canReadVisibility(space, visibility, actor, page = null) {
        if (!actor) return visibility === 'public';
        if (actor.kind === 'system') return true;
        if (visibility === 'public') return true;
        if (visibility === 'members') return !!actor.subject || role(space, actor) != null;
        if (visibility === 'vip') return role(space, actor) != null || !!(actor.vipAllowed && actor.vipAllowed.has(vipKey(space, page)));
        return role(space, actor) != null;
    }

    const api = {
        VISIBILITIES,
        role,
        isPerson,
        effectiveVisibility,
        canReadSpace(space, actor) {
            if (!space || space.deleted_at) return false;
            return canReadVisibility(space, space.visibility, actor);
        },
        /** Published content of a page (drafts and history of unpublished pages need canEdit). */
        canReadPage(space, page, actor) {
            if (!space || space.deleted_at || !page || page.state === 'deleted') return false;
            if (!canReadVisibility(space, effectiveVisibility(space, page), actor, page)) return false;
            if (page.state === 'published') return true;
            return api.canEdit(space, actor);
        },
        canEdit(space, actor) {
            if (!space || space.deleted_at) return false;
            const r = role(space, actor);
            return r === 'owner' || r === 'editor';
        },
        canManage(space, actor) {
            if (!space || space.deleted_at) return false;
            return role(space, actor) === 'owner';
        },
        /**
         * Ask VIP, before rendering, about every VIP space or page in `pairs` ([{ space, page? }]) the actor
         * cannot already read through a role. Answers land on the actor: vipAllowed (Set of 'space:<id>' /
         * 'page:<id>') and vipDenied (Map key → reason, for the join prompt). At most 50 questions per call;
         * the rest stay unreadable. sensitive: VIP asks Billing directly (never cached).
         */
        async prepareVip(actor, pairs, { sensitive = false } = {}) {
            if (!actor || actor.kind === 'system') return;
            const todo = new Map();
            for (const { space, page = null } of pairs || []) {
                if (!space || space.deleted_at || effectiveVisibility(space, page) !== 'vip') continue;
                if (role(space, actor) != null) continue;
                const key = vipKey(space, page);
                if (!sensitive && actor.vipAllowed && actor.vipAllowed.has(key)) continue;
                if (!todo.has(key) && todo.size < 50) todo.set(key, { space, resource: vipResource(space, page) });
            }
            if (!todo.size) return;
            actor.vipAllowed = actor.vipAllowed || new Set();
            actor.vipDenied = actor.vipDenied || new Map();
            await Promise.all([...todo].map(async ([key, { space, resource }]) => {
                const d = vip ? await vip.decide({ subject: actor.subject || null, space, resource, sensitive }) : { allow: false, reason: 'vip_not_configured' };
                if (d.allow) { actor.vipAllowed.add(key); actor.vipDenied.delete(key); } else { actor.vipAllowed.delete(key); actor.vipDenied.set(key, d.reason || 'denied'); }
            }));
        },
        /** Why a VIP read was refused (the join prompt), or null when it was not a VIP refusal. */
        vipRefusal(space, page, actor) {
            if (!space || effectiveVisibility(space, page) !== 'vip' || !actor || role(space, actor) != null) return null;
            if (actor.vipAllowed && actor.vipAllowed.has(vipKey(space, page))) return null;
            return { reason: (actor.vipDenied && actor.vipDenied.get(vipKey(space, page))) || (actor.subject ? 'denied' : 'not_signed_in'),
                owner: space.owner || null, joinUrl: vip ? vip.joinUrl(space.owner || null) : null };
        },
        /** Would this subject (a watcher) be allowed to read the page? Staff status is not known here. */
        subjectCanRead(space, page, subject) {
            return api.canReadPage(space, page, { kind: 'user', subject, staff: false });
        },
    };
    return api;
}

module.exports = { createAccess, effectiveVisibility, strictest, vipResource, VISIBILITIES, RANK };
