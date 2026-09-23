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
 * Space visibility: public (anyone), members (any signed-in OpenVibe account), private (only
 * subjects holding a role in the space). A page's own visibility can only narrow its space's.
 * Roles: owner (everything, incl. roles and settings), editor (write revisions, publish, revert,
 * review AI proposals), viewer (read a private space). Network staff (admin, global_mod) act as
 * owner of official spaces; they get no silent access to user spaces.
 * A service acting for a person gets that person's rights (and must hold the route's capability);
 * a service acting as itself reads public content only and writes nothing that needs a person.
 */
const RANK = { public: 0, members: 1, private: 2 };
const VISIBILITIES = ['public', 'members', 'private'];

function strictest(a, b) { return RANK[a] >= RANK[b] ? a : b; }

function effectiveVisibility(space, page) {
    return page ? strictest(space.visibility, page.visibility) : space.visibility;
}

function createAccess(db) {
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

    function canReadVisibility(space, visibility, actor) {
        if (!actor) return visibility === 'public';
        if (actor.kind === 'system') return true;
        if (visibility === 'public') return true;
        if (visibility === 'members') return !!actor.subject || role(space, actor) != null;
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
            if (!canReadVisibility(space, effectiveVisibility(space, page), actor)) return false;
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
        /** Would this subject (a watcher) be allowed to read the page? Staff status is not known here. */
        subjectCanRead(space, page, subject) {
            return api.canReadPage(space, page, { kind: 'user', subject, staff: false });
        },
    };
    return api;
}

module.exports = { createAccess, effectiveVisibility, strictest, VISIBILITIES, RANK };
