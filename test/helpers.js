'use strict';
/**
 * Test helpers: a Wiki instance on a temp database and a random port, a generated Network RSA
 * key, signed user JWTs and service tokens, and a stub fetch for the other services.
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');
const { start } = require('../server/index');
const { testDb } = require('./db-helper');

const ISSUER = 'https://network.test';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function subject(prefix = 'usr') { let s = ''; for (let i = 0; i < 26; i++) s += ALPHA[crypto.randomInt(32)]; return `${prefix}_${s}`; }

function userToken({ subject: sub = subject(), username = 'someone', role = 'user', aud = ['openvibe.network', 'openvibe.live'], exp = 3600, issuer = ISSUER } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({ iss: issuer, aud, sub: 42, id: 42, subject_id: sub, username, display_name: username, role, iat: now, exp: now + exp }, privateKey);
}

/**
 * A principal token: svc:<client> by default; `sub` + `actorType` for an app:/mod: principal, `extra` for on_behalf_of, env…
 * An app token carries its developer project and env, as Network's do (identity.service-token-claims 1.2.0).
 */
function serviceToken({ client = 'ai', cap = [], aud = 'openvibe.wiki', exp = 300, sub, actorType = 'service', extra = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const app = actorType === 'app' ? { project_id: 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', env: 'production' } : {};
    return serviceAuth.signServiceToken({ iss: ISSUER, sub: sub || `svc:${client}`, actor_type: actorType, aud: [aud], cap, ns: [], iat: now, exp: now + exp, jti: `tok_${crypto.randomBytes(8).toString('hex')}`, ...app, ...extra }, privateKey);
}

const quiet = process.env.WIKI_TEST_LOG ? console : { log() {}, warn() {}, error() {} };

/**
 * A running Wiki. opts.env overrides env vars; opts.fetch is the stub for outbound calls
 * (Community, Sources, Media, Events, Network token endpoint).
 */
/**
 * A running Wiki on a database of its own (PGlite by default; WIKI_TEST_STORE=pg: the PostgreSQL + PgBouncer
 * containers). opts.db: boot on an existing handle (a restart keeps the data); h.stop() closes what boot opened.
 */
async function boot({ env = {}, fetch: fetchImpl, db: givenDb = null, now, workers = false, tokens, rateLimits = false, limitsNow = null, log = quiet, indexnow = undefined } = {}) {
    const owned = givenDb ? null : await testDb();
    const db = givenDb || owned.db;
    const config = load({
        NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', BASE_URL: 'http://wiki.test',
        OV_NETWORK_URL: ISSUER, OV_NETWORK_INTERNAL_URL: '', WIKI_GATE_MIN_WORDS: '20',
        ...env,
    });
    const h = await start({
        config, db, publicKey, log, listen: true, workers, rateLimits, now, limitsNow,
        fetchImpl: fetchImpl || (async (url) => { throw new Error(`unexpected outbound fetch ${url}`); }),
        tokens: tokens || { getToken: async () => 'stub-token', authHeaders: async () => ({ Authorization: 'Bearer stub-token' }), invalidate() {} },
        indexnow,
    });
    const base = `http://127.0.0.1:${h.server.address().port}`;
    const stop = async ({ keepDb = false } = {}) => { await h.stop(); if (owned && !keepDb) await owned.close(); };
    return { ...h, stop, base, closeDb: owned ? owned.close : async () => {} };
}

async function req(h, method, p, { token, body, form, headers = {}, cookie } = {}) {
    const hs = { ...headers };
    if (token) hs.Authorization = `Bearer ${token}`;
    if (cookie) hs.Cookie = cookie;
    let payload;
    if (body !== undefined) { hs['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    if (form !== undefined) {
        hs['Content-Type'] = 'application/x-www-form-urlencoded';
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) params.append(k, x == null ? '' : String(x));
        payload = params.toString();
    }
    const res = await fetch(h.base + p, { method, headers: hs, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or text */ }
    return { status: res.status, headers: res.headers, text, json };
}

const cookieFor = (token) => `ov_token=${token}`;

/** Every envelope in the outbox, oldest first. */
async function outbox(h) {
    return (await h.db.prepare('SELECT envelope FROM wiki_event_outbox ORDER BY id').all()).map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
}

const LONG = 'This page has enough words to pass the thin content rule of the indexability gate, which the tests set to twenty words so that a short paragraph is enough for a published page to be indexable.';

module.exports = { boot, req, userToken, serviceToken, subject, cookieFor, outbox, publicKey, privateKey, ISSUER, quiet, LONG };
