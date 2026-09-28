'use strict';
/**
 * Per-actor rate limits on /api/v1 and on the editing forms (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The per-address limits in app.js (every /api/ call, imports, diffs, form posts, search) stay. These
 * count requests by who makes them, once req.actor is resolved (auth/viewer.js):
 *
 *   a person                        user:usr_… (their own token or cookie, or named by a service in
 *                                   X-OV-Subject, or an app's on_behalf_of)
 *   a first-party service relaying ip:<address> of the signed-out visitor it forwards (X-Forwarded-For)
 *     a signed-out visitor
 *   a service or app acting as      its principal (svc:ai, app:app_…): an AI workflow's proposals
 *     itself
 *   a signed-out caller             ip:<address>
 *
 * A first-party service reading for itself (no person, no visitor) is not counted on reads: its
 * pages speak for all its visitors, and the per-address /api/ limit already bounds it. Past a limit
 * the route answers 429 problem+json `rate_limited` with Retry-After before it does any work (before
 * the body is parsed for a form); the refusal is logged once and counted in
 * wiki_rate_limited_total{limit,window}. API reads get WIKI_LIMITS_MINUTE / WIKI_LIMITS_HOUR (120 and
 * 3000); every edit, publish and settings change has its own number below, shared by the API route
 * and the form that does the same thing. Counters live in this process: a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, sign-in, and the pages people read
 * (the per-address limits bound those).
 */
const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;
const LOOPBACK = /^(::1$|127\.|::ffff:127\.)/;

/** A first-party service that forwards the address of the signed-out visitor it acts for. */
function relaysVisitor(req) {
    const a = req.actor;
    return !!(a && a.kind === 'service' && !a.subject && FIRST_PARTY.test(String(a.service)) && req.get('x-forwarded-for') && req.ip && !LOOPBACK.test(req.ip));
}

function actor(req) {
    const a = req.actor;
    if (!a || a.kind === 'anonymous') return defaultActor(req);
    if (a.subject) return `user:${a.subject}`;
    if (a.kind === 'service') return relaysVisitor(req) ? `ip:${req.ip}` : a.service;
    return defaultActor(req);
}

/** A first-party service reading for itself: no person, no visitor. */
function serviceItself(req) {
    const a = req.actor;
    return !!(a && a.kind === 'service' && !a.subject && FIRST_PARTY.test(String(a.service)) && !relaysVisitor(req));
}

/**
 * The writes and expensive reads, each with its numbers per caller (a minute, an hour). A form and the
 * API route that do the same thing share one budget.
 */
const BUDGETS = {
    // A space is a new tree with its own roles: people start a few.
    'wiki.space.create': { minute: 10, hour: 60 },
    // Space settings, roles, and moves, visibility, media and deletes of a page: a person saves a form
    // now and then.
    'wiki.space.update': { minute: 30, hour: 300 },
    'wiki.page.update': { minute: 30, hour: 300 },
    // A new page or a new revision stores the whole text again and asks Sources about each cited item:
    // an editor saves (or previews) every few seconds at most, so 30 a minute, and 300 new pages or 600
    // revisions an hour. A revert writes a revision too.
    'wiki.page.create': { minute: 30, hour: 300 },
    'wiki.page.edit': { minute: 30, hour: 600 },
    // Citations on an unpublished revision: each item is looked up in Sources.
    'wiki.citation.attach': { minute: 30, hour: 300 },
    // Publishing, scheduling, unpublishing and reviews change what readers, feeds, sitemaps and
    // search see, and emit an event each.
    'wiki.revision.publish': { minute: 30, hour: 300 },
    // An AI workflow proposes one revision per page it worked on: one a second at most.
    'wiki.revision.propose': { minute: 60, hour: 1200 },
    // Imports are the heaviest writes (up to 200 pages in one transaction); the per-address limit
    // allows 20 an hour.
    'wiki.page.import': { minute: 5, hour: 20 },
    // Attaching or checking media asks OpenVibe.Media about each object.
    'wiki.media.attach': { minute: 20, hour: 200 },
    // Watching a page is one toggle.
    'wiki.page.watch': { minute: 60, hour: 600 },
    // A discussion comment goes to OpenVibe.Community in the person's name (Community allows 20 a minute).
    'wiki.discussion.comment': { minute: 20, hour: 300 },
    // Search scans the text of every published page (LIKE); a word diff of two long revisions costs
    // hundreds of ms of CPU. A person's pace, not a crawler's.
    'wiki.search.query': { minute: 30, hour: 600 },
    'wiki.page.diff': { minute: 30, hour: 600 },
};

/**
 * limits(name, own) middleware for one app, plus limits.reads(name) (the defaults on every GET/HEAD,
 * a first-party service reading for itself not counted) and limits.budget(name) (one of BUDGETS).
 * enabled=false (createApp's rateLimits=false, tests only) counts nobody, as it turns off the
 * per-address limits.
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console, enabled = true, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'wiki_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor: enabled ? actor : () => null,
        now,
        // Shared across processes and hosts on Valkey (ADR-035) when VALKEY_URL is set; in-process otherwise.
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The actor is a subject id, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && !serviceItself(req) ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createActorLimits, actor, serviceItself, BUDGETS };
