'use strict';
/**
 * Test helpers: a Wiki instance on a temp database and a random port, a generated Network RSA
 * key, signed user JWTs and service tokens, and a stub fetch for the other services.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');
const { start } = require('../server/index');

const ISSUER = 'https://network.test';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function subject(prefix = 'usr') { let s = ''; for (let i = 0; i < 26; i++) s += ALPHA[crypto.randomInt(32)]; return `${prefix}_${s}`; }

function userToken({ subject: sub = subject(), username = 'someone', role = 'user', aud = ['openvibe.network', 'openvibe.live'], exp = 3600, issuer = ISSUER } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({ iss: issuer, aud, sub: 42, id: 42, subject_id: sub, username, display_name: username, role, iat: now, exp: now + exp }, privateKey);
}

/** A principal token: svc:<client> by default; `sub` + `actorType` for an app:/mod: principal, `extra` for on_behalf_of, env… */
function serviceToken({ client = 'ai', cap = [], aud = 'openvibe.wiki', exp = 300, sub, actorType = 'service', extra = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({ iss: ISSUER, sub: sub || `svc:${client}`, actor_type: actorType, aud: [aud], cap, ns: [], iat: now, exp: now + exp, jti: `tok_${crypto.randomBytes(8).toString('hex')}`, ...extra }, privateKey);
}

const quiet = { log() {}, warn() {}, error() {} };

/**
 * A running Wiki. opts.env overrides env vars; opts.fetch is the stub for outbound calls
 * (Community, Sources, Media, Events, Network token endpoint).
 */
async function boot({ env = {}, fetch: fetchImpl, dbPath, now, workers = false, tokens, rateLimits = false } = {}) {
    const dir = dbPath ? path.dirname(dbPath) : fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-test-'));
    const config = load({
        NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', BASE_URL: 'http://wiki.test',
        WIKI_DB_PATH: dbPath || path.join(dir, 'wiki.db'),
        OV_NETWORK_URL: ISSUER, OV_NETWORK_INTERNAL_URL: '', WIKI_GATE_MIN_WORDS: '20',
        ...env,
    });
    const h = await start({
        config, publicKey, log: quiet, listen: true, workers, rateLimits, now,
        fetchImpl: fetchImpl || (async (url) => { throw new Error(`unexpected outbound fetch ${url}`); }),
        tokens: tokens || { getToken: async () => 'stub-token', authHeaders: async () => ({ Authorization: 'Bearer stub-token' }), invalidate() {} },
    });
    const base = `http://127.0.0.1:${h.server.address().port}`;
    return { ...h, base, dir, dbPath: config.dbPath };
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
function outbox(h) {
    return h.db.prepare('SELECT envelope FROM wiki_event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope));
}

const LONG = 'This page has enough words to pass the thin content rule of the indexability gate, which the tests set to twenty words so that a short paragraph is enough for a published page to be indexable.';

module.exports = { boot, req, userToken, serviceToken, subject, cookieFor, outbox, publicKey, privateKey, ISSUER, quiet, LONG };
