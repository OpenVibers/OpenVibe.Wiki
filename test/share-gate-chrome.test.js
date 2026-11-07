'use strict';
/**
 * The "not on the list" gate in a real headless Chrome (openvibe-shared 4.123.0's [data-ov-share-gate]):
 * the page carries markup only, ov-share.js draws the gate, signed out it offers Sign in, and a
 * signed-in stranger is offered Ask for access — no console error and no CSP refusal.
 * Skipped (exit 0) without Chrome, or with OV_SKIP_BROWSER=1.
 */
const assert = require('assert');
const fs = require('fs');
const H = require('./helpers');

let playwright = null;
try { playwright = require('playwright'); } catch {
    try { playwright = require(process.env.PLAYWRIGHT_MODULE || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'); } catch { playwright = null; }
}
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
if (process.env.OV_SKIP_BROWSER === '1' || !playwright || !fs.existsSync(CHROME)) {
    console.log('share-gate-chrome: skipped (no Chrome; set CHROME_BIN)');
    process.exit(0);
}
const REFUSED = /Content Security Policy|Refused to (?:load|execute|apply)|Uncaught SyntaxError/i;
let failures = 0;
async function check(fn, name) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
    const people = new Map();
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(String(url));
        const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
        if (u.pathname === '/oauth/token') return json(200, { access_token: 'stub-token', token_type: 'Bearer', expires_in: 300 });
        if (u.pathname === '/internal/identity/resolve-batch') {
            const b = JSON.parse(opts.body || '{}');
            const results = {};
            for (const id of b.subject_ids || []) results[id] = people.get(id) || null;
            return json(200, { results });
        }
        if (u.pathname === '/internal/identity/resolve') {
            const name = (u.searchParams.get('username') || '').toLowerCase();
            for (const p of people.values()) if (p.username.toLowerCase() === name) return json(200, p);
            return json(404, { error: 'no such person' });
        }
        if (u.pathname === '/internal/notifications/push') return json(202, { queued: true });
        throw new Error(`unexpected outbound fetch ${url}`);
    };
    const h = await H.boot({ env: { OV_NETWORK_INTERNAL_URL: 'https://network.test', OV_OAUTH_CLIENT_SECRET: 'shh' }, fetch: fetchImpl });
    const alice = { subject: H.subject(), username: 'alice' };
    const bob = { subject: H.subject(), username: 'bob' };
    const sam = { subject: H.subject(), username: 'sam' };
    for (const p of [alice, bob, sam]) people.set(p.subject, { subject: { type: 'user', id: p.subject }, username: p.username, display_name: p.username, avatar_url: null, banned: false });
    const tok = (u) => H.userToken({ subject: u.subject, username: u.username, aud: ['openvibe.network', 'openvibe.wiki'] });

    await H.req(h, 'POST', '/api/v1/spaces', { token: tok(alice), body: { slug: 'handbook', name: 'Handbook', kind: 'user', visibility: 'public' } });
    const made = await H.req(h, 'POST', '/api/v1/spaces/handbook/pages', { token: tok(alice), body: { title: 'Board pack', body: `${H.LONG} [1]`, visibility: 'public', citations: [{ url: 'https://example.com/source', title: 'A source', retrievedAt: '2026-11-06T00:00:00Z' }] } });
    assert.strictEqual(made.status, 201, made.text);
    const page = made.json.page;
    const put = await H.req(h, 'PUT', `/api/v1/page/${page.id}/share`, { headers: { 'x-requested-with': 'ov-share' }, token: tok(alice), body: { audience: 'people', members: [{ subject: { type: 'user', id: bob.subject }, role: 'viewer' }] } });
    assert.strictEqual(put.status, 200, put.text);
    const url = `${h.base}/w/handbook/${page.slug}`;

    let browser;
    const errors = [];
    const watch = (p) => {
        p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        p.on('pageerror', (e) => errors.push(String(e)));
    };
    const settled = async (p) => {
        await p.waitForSelector('#share-gate .ov-share-gate', { timeout: 8000 });
        return await p.$eval('#share-gate', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    };

    try {
        await check(async () => {
            browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
            const ctx = await browser.newContext();
            const p = await ctx.newPage();
            watch(p);
            const res = await p.goto(url, { waitUntil: 'load', timeout: 15000 });
            assert.strictEqual(res.status(), 404, 'the gate answers 404, never the page');
            const text = await settled(p);
            assert.ok(/Sign in/.test(text), `signed out the gate offers Sign in, got: ${text}`);
            const href = await p.$eval('#share-gate .ov-share-gate a', (a) => a.getAttribute('href'));
            assert.match(href, /^\/auth\/login\?next=/);
            await ctx.close();
        }, 'headless Chrome: the gate draws itself, signed out, with Sign in');

        await check(async () => {
            const ctx = await browser.newContext();
            await ctx.addCookies([{ name: 'ov_token', value: tok(sam), url: h.base }]);
            const p = await ctx.newPage();
            watch(p);
            await p.goto(url, { waitUntil: 'load', timeout: 15000 });
            const text = await settled(p);
            assert.ok(/Ask for access/.test(text), `a stranger is offered Ask for access, got: ${text}`);
            assert.ok(/@sam/.test(text), 'the gate names the account it is signed in as');
            await ctx.close();
        }, 'headless Chrome: a stranger is offered Ask for access');

        await check(async () => {
            assert.deepStrictEqual(errors.filter((e) => REFUSED.test(e)), []);
        }, 'headless Chrome: no console error and no CSP refusal');
    } finally {
        if (browser) await browser.close().catch(() => {});
        await h.stop(); await h.closeDb();
        process.exit(failures ? 1 : 0);
    }
})();
