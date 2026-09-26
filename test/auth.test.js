'use strict';
/**
 * Network SSO session layer (same shape as OpenVibe.Community): the authorize redirect, state
 * checking on the callback, the code exchange, open-redirect protection, /auth/me.
 */
const assert = require('assert');
const H = require('./helpers');
const { sanitizeNext } = require('../server/auth/session');

(async () => {
    const tokenCalls = [];
    const token = H.userToken({ username: 'ana' });
    const fetchStub = async (url, init = {}) => {
        if (String(url).endsWith('/oauth/token')) {
            tokenCalls.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ access_token: token, refresh_token: 'r1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`unexpected ${url}`);
    };
    const h = await H.boot({ fetch: fetchStub, env: { OV_OAUTH_CLIENT_SECRET: 'x' } });
    try {
        const cfg = { baseUrl: 'https://openvibe.wiki', networkUrl: 'https://openvibe.network' };
        assert.strictEqual(sanitizeNext('/w/a/b', cfg), '/w/a/b');
        assert.strictEqual(sanitizeNext('//evil.example/x', cfg), '/');
        assert.strictEqual(sanitizeNext('https://evil.example/', cfg), '/');
        assert.strictEqual(sanitizeNext('https://openvibe.network/sso', cfg), 'https://openvibe.network/sso');

        let r = await H.req(h, 'GET', '/auth/login?next=%2Fw%2Fx%2Fy');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, 'https://network.test/oauth/authorize');
        assert.strictEqual(loc.searchParams.get('client_id'), 'wiki');
        assert.strictEqual(loc.searchParams.get('redirect_uri'), 'http://wiki.test/auth/callback');
        const state = loc.searchParams.get('state');
        const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        assert.ok(cookies.includes(`ov_oauth_state=${state}`));

        // A callback without the matching state cookie is refused.
        r = await H.req(h, 'GET', `/auth/callback?code=abc&state=${state}`);
        assert.strictEqual(r.status, 400);
        r = await H.req(h, 'GET', '/auth/callback?code=abc&state=wrong', { cookie: cookies });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(tokenCalls.length, 0);

        // With it: code exchange, session cookies, back to next.
        r = await H.req(h, 'GET', `/auth/callback?code=abc&state=${state}`, { cookie: cookies });
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.get('location'), '/w/x/y');
        assert.strictEqual(tokenCalls[0].grant_type, 'authorization_code');
        assert.strictEqual(tokenCalls[0].client_id, 'wiki');
        const set = r.headers.getSetCookie();
        assert.ok(set.some((c) => c.startsWith(`ov_token=${token}`)));
        assert.ok(set.some((c) => c.startsWith('ov_refresh=r1') && /HttpOnly/i.test(c) && /Path=\/auth/.test(c)));

        r = await H.req(h, 'GET', '/auth/me', { cookie: `ov_token=${token}` });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.user.username, 'ana');
        // A guest (no cookie, no token at all) is signed out, not an error; a bad credential is still 401.
        r = await H.req(h, 'GET', '/auth/me');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json, { user: null });
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await H.req(h, 'GET', '/auth/me', { cookie: 'ov_token=expired.or.forged' })).status, 401);
        assert.strictEqual((await H.req(h, 'GET', '/auth/me', { cookie: `ov_token=${H.userToken({ exp: -120 })}` })).status, 401, 'an expired cookie');
        // An expired cookie is simply signed out on pages.
        r = await H.req(h, 'GET', '/', { cookie: `ov_token=${H.userToken({ exp: -120 })}` });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Sign in with OpenVibe'));
        // Silent login goes out with prompt=none.
        r = await H.req(h, 'GET', '/auth/login?silent=1');
        assert.strictEqual(new URL(r.headers.get('location')).searchParams.get('prompt'), 'none');
        // Health and readiness.
        assert.strictEqual((await H.req(h, 'GET', '/api/health')).json.service, 'openvibe-wiki');
        const ready = await H.req(h, 'GET', '/api/ready');
        assert.strictEqual(ready.status, 200);
        assert.strictEqual(ready.json.checks.db.status, 'ok');
        // The release manifest (registry.release-manifest@1) names where open tabs report updates.
        const rel = await H.req(h, 'GET', '/release.json');
        assert.strictEqual(rel.json.service, 'wiki');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json).errors, []);
        assert.strictEqual(rel.json.metrics_url, '/release-metrics');
        console.log('auth ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
