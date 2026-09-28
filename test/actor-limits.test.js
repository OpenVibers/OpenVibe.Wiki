'use strict';
/**
 * Per-actor rate limits (server/http/actor-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. A person is counted as themselves
 * whether they call directly or a service names them; a service relaying signed-out visitors is
 * counted by each forwarded address; a service reading for itself is not counted. Edits have their
 * own budget, shared by the API and the edit form. Health, ready, release.json and metrics are never
 * limited; refusals are logged (no token) and counted.
 */
const assert = require('assert');
const H = require('./helpers');
const { actor, serviceItself } = require('../server/http/actor-limits');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const lines = [];
    const log = { ...H.quiet, warn: (m) => lines.push(String(m)) };
    const h = await H.boot({ rateLimits: true, limitsNow: () => clock, log, env: { WIKI_LIMITS_MINUTE: '3', WIKI_LIMITS_HOUR: '100' } });
    const alice = H.subject();
    const bob = H.subject();
    const aliceTok = H.userToken({ subject: alice, username: 'alice' });
    const bobTok = H.userToken({ subject: bob, username: 'bob' });
    const svc = (extra = {}) => H.serviceToken({ client: 'ai', cap: ['wiki.page.read', 'wiki.page.create'], ...extra });
    try {
        // a read: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes
        for (let i = 0; i < 3; i++) assert.strictEqual((await H.req(h, 'GET', '/api/v1/spaces', { token: aliceTok })).status, 200);
        let r = await H.req(h, 'GET', '/api/v1/spaces', { token: aliceTok });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')), r.headers.get('content-type'));
        assert.deepStrictEqual([r.json.code, r.json.status, r.json.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(r.json.detail.includes('wiki.read'), r.json.detail);
        assert.strictEqual((await H.req(h, 'GET', '/api/v1/spaces', { token: bobTok })).status, 200, 'another person still passes');

        // a service naming the person counts against that person
        r = await H.req(h, 'GET', '/api/v1/spaces', { token: svc(), headers: { 'X-OV-Subject': alice } });
        assert.deepStrictEqual([r.status, r.json.code], [429, 'rate_limited']);

        // a service relaying signed-out visitors: each forwarded address on its own; reading for itself: not counted
        const visitor = (ip) => H.req(h, 'GET', '/api/v1/spaces', { token: svc(), headers: { 'X-Forwarded-For': ip } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await visitor('203.0.113.7')).status, 200);
        assert.strictEqual((await visitor('203.0.113.7')).status, 429);
        assert.strictEqual((await visitor('203.0.113.8')).status, 200, 'another visitor still passes');
        for (let i = 0; i < 6; i++) assert.strictEqual((await H.req(h, 'GET', '/api/v1/spaces', { token: svc() })).status, 200);

        // the next minute opens the window again
        clock += 45 * 1000;
        assert.strictEqual((await H.req(h, 'GET', '/api/v1/spaces', { token: aliceTok })).status, 200);

        // an edit has its own budget (30 a minute), shared by the API and the edit form; nothing is stored past it
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        const owner = { kind: 'user', subject: alice, staff: false };
        const space = h.svc.createSpace({ name: 'Limits', slug: 'limits' }, owner);
        const { page } = h.svc.createPage(space.id, { title: 'Counted', body: H.LONG }, owner);
        h.svc.setRole(space.id, bob, 'editor', owner);
        const head = () => h.db.prepare('SELECT MAX(number) AS n FROM wiki_page_revisions WHERE entity_id = ?').get(page.id).n;
        for (let i = 0; i < 30; i++) {
            r = await H.req(h, 'POST', `/api/v1/pages/${page.id}/revisions`, { token: aliceTok, body: { expected_revision: head(), body: `${H.LONG} Edit ${i}.` } });
            assert.ok(r.status === 200 || r.status === 201, `edit ${i + 1}: ${r.text}`);
        }
        const stored = head();
        r = await H.req(h, 'POST', '/w/limits/counted/edit', { cookie: H.cookieFor(aliceTok), form: { expected_revision: stored, title: 'Counted', body: `${H.LONG} One more.` } });
        assert.deepStrictEqual([r.status, r.json && r.json.code, r.headers.get('retry-after')], [429, 'rate_limited', '60'], 'the form shares the API budget');
        assert.ok(r.json.detail.includes('wiki.page.edit'), r.json.detail);
        assert.strictEqual(head(), stored, 'nothing stored');
        r = await H.req(h, 'POST', `/api/v1/pages/${page.id}/revisions`, { token: bobTok, body: { expected_revision: stored, body: `${H.LONG} From bob.` } });
        assert.ok(r.status === 200 || r.status === 201, `another editor still edits: ${r.text}`);

        // health, ready, release.json and metrics are never limited
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await H.req(h, 'GET', '/api/health')).status, 200);
            assert.notStrictEqual((await H.req(h, 'GET', '/api/ready')).status, 429);
            assert.strictEqual((await H.req(h, 'GET', '/release.json')).status, 200);
            assert.strictEqual((await H.req(h, 'GET', '/metrics')).status, 200);
        }

        // refusals are counted in wiki_rate_limited_total and logged without a token
        const m = (await H.req(h, 'GET', '/metrics')).text;
        const counted = m.split('\n').filter((l) => l.includes('wiki_rate_limited_total')).join('\n');
        assert.ok(/wiki_rate_limited_total\{limit="wiki.read",window="minute"\} 3/.test(m), counted);
        assert.ok(/wiki_rate_limited_total\{limit="wiki.page.edit",window="minute"\} 1/.test(m), counted);
        assert.ok(lines.some((l) => l.includes(`wiki.read: user:${alice} refused`)), lines.join('\n'));
        for (const l of lines) for (const tok of [aliceTok, bobTok]) assert.ok(!l.includes(tok), 'a token in the log');

        // who is counted
        const q = (a, { xff = null, ip = '127.0.0.1' } = {}) => ({ actor: a, ip, get: (n) => (n === 'x-forwarded-for' ? xff : undefined) });
        assert.strictEqual(actor(q({ kind: 'user', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'ip:203.0.113.9');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: null })), 'svc:ai', 'acting as itself (proposals)');
        assert.strictEqual(actor(q({ kind: 'service', service: 'app:app_1', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'app:app_1', 'an app never relays by address');
        assert.strictEqual(actor(q({ kind: 'anonymous', subject: null }, { ip: '198.51.100.4' })), 'ip:198.51.100.4');
        assert.strictEqual(serviceItself(q({ kind: 'service', service: 'svc:ai', subject: null })), true);
        assert.strictEqual(serviceItself(q({ kind: 'service', service: 'app:app_1', subject: null })), false);
        console.log('actor limits: ok');
    } finally {
        await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
