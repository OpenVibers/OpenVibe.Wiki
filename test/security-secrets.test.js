'use strict';
/**
 * Wiki's secrets never leave in a response or an event (roadmap WS-R task 5, the internal-secret
 * class). The Wiki boots with a sentinel as its Network OAuth client secret and as the service token
 * it presents to Community, Sources, Media, VIP and Events; every outbound call it makes carries the
 * token (the stub records them). Then every route the booted app has (listed from Express's router
 * stack, test/security-crawl.js) is requested as anonymous, a user, the owner of a space and
 * Network staff, with real and nonsense ids, plus the probes (/api/health, /api/ready), unknown
 * paths, every write route with a broken body, and the sign-in callback with a forged code (it
 * posts the client secret to Network: the error it answers with must not echo it). No body or
 * header may contain either sentinel, nor may any event in the outbox.
 *
 *   node test/security-secrets.test.js
 */
const assert = require('assert');
const H = require('./helpers');
const { getPaths, crawl, listRoutes, expand, leaks } = require('./security-crawl');

const SECRETS = {
    OV_OAUTH_CLIENT_SECRET: 'sentinel-not-a-secret-wiki-oauth-client',
    serviceToken: 'sentinel-not-a-secret-wiki-service-token',
};

(async () => {
    const outbound = [];
    // Every other service answers, badly: the error paths are what is being read.
    const fetchStub = async (url, opts = {}) => {
        outbound.push({ url: String(url), headers: opts.headers || {}, body: String(opts.body || '') });
        return new Response(JSON.stringify({ error: 'upstream says no', detail: 'nope' }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
    const tokens = { getToken: async () => SECRETS.serviceToken, authHeaders: async () => ({ Authorization: `Bearer ${SECRETS.serviceToken}` }), invalidate() {} };
    const h = await H.boot({
        env: { OV_OAUTH_CLIENT_SECRET: SECRETS.OV_OAUTH_CLIENT_SECRET, OV_OAUTH_CLIENT_ID: 'wiki', OV_NETWORK_INTERNAL_URL: 'http://network.test', OV_COMMUNITY_INTERNAL_URL: 'http://community.test', OV_SOURCES_INTERNAL_URL: 'http://sources.test', OV_MEDIA_INTERNAL_URL: 'http://media.test', OV_VIP_INTERNAL_URL: 'http://vip.test' },
        fetch: fetchStub, tokens,
    });
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 10).join('\n    ')}`); } };
    try {
        const owner = { kind: 'user', subject: H.subject(), staff: false };
        const space = await h.svc.createSpace({ name: 'Notes', slug: 'notes' }, owner);
        const cite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
        const page = (await h.svc.createPage(space.id, { title: 'Open page', body: H.LONG, citations: cite }, owner)).page;
        await h.svc.publish(page.id, {}, owner);
        const people = {
            anonymous: null,
            user: H.userToken({ subject: H.subject(), username: 'someone' }),
            owner: H.userToken({ subject: owner.subject, username: 'owner' }),
            staff: H.userToken({ subject: H.subject(), username: 'staffer', role: 'admin' }),
        };

        await check('every GET route, page and probe, as four people: neither secret appears', async () => {
            const nonsense = ['-1', 'pg_00000000000000000000000000', "'\"<x>", 'x'.repeat(300)];
            const values = (name) => (name === 'space' ? ['notes', ...nonsense] : name === 'slug' ? ['open-page', ...nonsense] : [page.id, 1, ...nonsense]);
            const paths = getPaths(h.app, values, {
                query: 'q=x&next=%2F&revision=-1&from=a&to=b',
                extra: ['/api/health', '/api/ready', '/api/nope', '/nope/nope', '/.env', '/api/%', '/auth/callback?code=forged&state=forged', '/auth/login?next=/',
                    '/auth/logout', '/w/notes/open-page/discuss', `/api/v1/pages/${page.id}/revisions/1/citations`],
            });
            const r = await crawl(h, H.req, paths, people, () => SECRETS);
            console.log(`    (${paths.length} paths × 4 people; answers ${JSON.stringify(r.statuses)})`);
            assert.ok(r.answered >= paths.length * 3);
            assert.deepStrictEqual(r.found, []);
        });

        await check('every write route with a broken body, and with a body that makes the Wiki call another service: the answer names no secret', async () => {
            const found = [];
            const values = (name) => (name === 'space' ? ['notes'] : name === 'slug' ? ['open-page'] : [page.id]);
            for (const route of listRoutes(h.app)) {
                const methods = route.methods.filter((m) => ['post', 'put', 'patch', 'delete'].includes(m));
                for (const method of methods) {
                    for (const p of expand(route.path, values)) {
                        for (const token of [null, people.owner]) {
                            for (const raw of ['{"broken": ', JSON.stringify({ title: 'x', body: H.LONG, media_id: 'med_x', citations: cite, decision: 'approve', visibility: 'public' })]) {
                                const res = await fetch(h.base + p, { method: method.toUpperCase(), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}`, cookie: `ov_token=${token}` } : {}), origin: 'http://wiki.test' }, body: raw, redirect: 'manual' });
                                const text = await res.text();
                                for (const l of leaks({ text, headers: res.headers }, SECRETS)) found.push(`${method} ${p} → ${res.status} carries ${l.label}`);
                            }
                        }
                    }
                }
            }
            assert.deepStrictEqual(found, []);
        });

        await check('the sentinels are live: the Wiki really sent them to the services it called', async () => {
            const sent = JSON.stringify(outbound);
            assert.ok(outbound.length > 0, 'the crawl made the Wiki call out');
            assert.ok(sent.includes(SECRETS.serviceToken) || sent.includes(SECRETS.OV_OAUTH_CLIENT_SECRET), 'a credential went where it belongs');
        });

        await check('the events outbox carries neither', async () => {
            const text = JSON.stringify(await H.outbox(h));
            for (const [k, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `outbox carries ${k}`);
        });
    } finally {
        await h.stop();
    }
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nsecurity-secrets: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
