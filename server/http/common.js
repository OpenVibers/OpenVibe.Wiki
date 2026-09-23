'use strict';
/**
 * Shared HTTP helpers: the actor middleware, capability guards, error mapping and citation input.
 */
const contracts = require('openvibe-contracts');
const { checkCapability } = require('../auth/capabilities');
const { AuthError } = require('../auth/viewer');

const { http } = contracts;

/** Resolves req.actor. Pages pass { services: false }: pages are for browsers. */
function actorMiddleware(viewers, opts = {}) {
    return async (req, res, next) => {
        try {
            req.actor = await viewers.resolve(req, opts);
            next();
        } catch (err) {
            if (!(err instanceof AuthError)) return next(err);
            http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
        }
    };
}

/**
 * One capability per route for service tokens. People (user JWTs) and anonymous callers pass here
 * and are judged by the space rules in the service.
 */
function guard(capabilityId) {
    return function wikiCapabilityGuard(req, res, next) {
        const a = req.actor;
        if (!a || a.kind !== 'service') return next();
        const c = checkCapability(a.claims, capabilityId);
        if (c.allowed) return next();
        return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx: req.ov });
    };
}

/** Service errors → problem+json. */
function sendError(res, req, err, log = console) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500 && status !== 503) log.error('[Wiki]', err && err.stack ? err.stack : err);
    const code = (err && err.code) || (status === 500 ? 'internal.error' : 'request.invalid');
    const detail = status === 500 ? 'Internal error' : (err && err.message) || undefined;
    return http.sendProblem(res, status, code, { detail, ctx: req.ov, extra: err && err.extra ? err.extra : undefined });
}

function run(fn, status = 200, log = console) {
    return async (req, res) => {
        try {
            const out = await fn(req, res);
            if (res.headersSent) return;
            res.status(typeof status === 'function' ? status(out) : status).set('Cache-Control', 'private, no-store').json(out);
        } catch (err) {
            sendError(res, req, err, log);
        }
    };
}

/**
 * API/form citation input → the citations store's shape. Sources item ids are looked up in
 * OpenVibe.Sources (url, title, retrieval time and license come from the item's provenance);
 * nothing is filled in for a URL citation that the caller did not give.
 */
async function resolveCitations(list, platform) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw Object.assign(new Error('citations must be a list'), { status: 422, code: 'citation.invalid' });
    if (list.length > 50) throw Object.assign(new Error('at most 50 citations per request'), { status: 422, code: 'citation.too_many' });
    const out = [];
    for (const c of list) {
        if (!c || typeof c !== 'object') throw Object.assign(new Error('a citation is an object'), { status: 422, code: 'citation.invalid' });
        const itemId = c.source_item_id || c.sourceItemId || null;
        const quoteText = typeof c.quote === 'string' ? c.quote : (c.quote && c.quote.text) || null;
        const base = {
            url: c.url || null, title: c.title || null,
            retrievedAt: c.retrieved_at || c.retrievedAt || null,
            quote: quoteText ? { text: String(quoteText).slice(0, 5000) } : null,
            licenseNote: c.license_note || c.licenseNote || null,
            anchor: c.anchor || null,
        };
        if (itemId) {
            const item = await platform.sources.getItem(itemId);
            const prov = item.provenance || {};
            out.push({
                ...base, sourceItemId: item.id,
                url: base.url || item.canonical_url || null,
                title: base.title || item.title || null,
                retrievedAt: prov.retrieved_at || null,
                licenseNote: base.licenseNote || prov.license_note || null,
            });
        } else {
            out.push(base);
        }
    }
    return out;
}

/** Every page's citations of an import bundle, resolved before the import's transaction. */
async function resolveBundleCitations(bundle, platform) {
    for (const p of bundle.pages) {
        try {
            p.citations = await resolveCitations(p.citations, platform);
        } catch (err) {
            if (err && err.status && err.status < 500) err.message = `"${p.title}": ${err.message}`;
            throw err;
        }
    }
    return bundle;
}

/** The no-JS form's citation rows (cite_url_N, cite_title_N, cite_retrieved_N, cite_quote_N, cite_item_N). */
function citationsFromForm(body) {
    const out = [];
    for (let i = 0; i < 10; i++) {
        const url = String(body[`cite_url_${i}`] || '').trim();
        const item = String(body[`cite_item_${i}`] || '').trim();
        if (!url && !item) continue;
        const day = String(body[`cite_retrieved_${i}`] || '').trim();
        out.push({
            url: url || null, source_item_id: item || null,
            title: String(body[`cite_title_${i}`] || '').trim() || null,
            retrieved_at: day ? (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : day) : null,
            quote: String(body[`cite_quote_${i}`] || '').trim() || null,
        });
    }
    return out;
}

module.exports = { actorMiddleware, guard, sendError, run, resolveCitations, resolveBundleCitations, citationsFromForm };
