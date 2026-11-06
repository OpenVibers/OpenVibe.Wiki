'use strict';
/**
 * Sharing on Wiki pages and drafts (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; the pilot is
 * Community's pastes, the same openvibe-sdk/share). A new page is Only me; the four audiences are
 * enforced by canView on the page; a page that leaves Everyone leaves the sitemap and the feeds at
 * once; publishing a draft widens it to the visibility its author chose.
 */
const assert = require('assert');
const H = require('./helpers');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
    const people = new Map();
    /** Network's two identity routes plus the notification push, without a socket. */
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
    const cookies = (u) => ({ cookie: H.cookieFor(tok(u)) });

    await H.req(h, 'POST', '/api/v1/spaces', { token: tok(alice), body: { slug: 'handbook', name: 'Handbook', kind: 'user', visibility: 'public' } });
    const make = async (title = 'Draft notes') => {
        const r = await H.req(h, 'POST', '/api/v1/spaces/handbook/pages', { token: tok(alice), body: { title, body: `${H.LONG} [1]`, visibility: 'public', citations: [{ url: 'https://example.com/source', title: 'A source', retrievedAt: '2026-11-06T00:00:00Z' }] } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json.page;
    };
    const share = (id, opts = {}) => H.req(h, opts.method || 'GET', `/api/v1/page/${id}/share`, { headers: { 'x-requested-with': 'ov-share' }, ...opts });
    const putShare = (id, body, u = alice) => share(id, { method: 'PUT', token: tok(u), body });
    const row = async (id) => await h.db.prepare('SELECT * FROM shares WHERE service = ? AND kind = ? AND resource_id = ?').get('wiki', 'page', id);

    await check('a new page is registered Only me, owned by its author; only its author reads the draft', async () => {
        const p = await make();
        const s = await row(p.id);
        assert.strictEqual(s.audience, 'private');
        assert.deepStrictEqual(s.owner_subject, { type: 'user', id: alice.subject });
        const url = `/w/handbook/${p.slug}`;
        assert.strictEqual((await H.req(h, 'GET', url, { token: tok(alice) })).status, 200);
        assert.strictEqual((await H.req(h, 'GET', url, { token: tok(bob) })).status, 404);
        assert.strictEqual((await H.req(h, 'GET', url)).status, 404);
    });

    await check('Specific people: the named person reads the draft; a stranger gets the gate and no title', async () => {
        const p = await make('Board pack');
        const put = await putShare(p.id, { audience: 'people', members: [{ subject: { type: 'user', id: bob.subject }, role: 'viewer' }] });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual(put.json.audience, 'people');
        assert.strictEqual((await h.db.prepare('SELECT visibility FROM wiki_pages WHERE id = ?').get(p.id)).visibility, 'private');
        const url = `/w/handbook/${p.slug}`;
        const member = await H.req(h, 'GET', url, { token: tok(bob) });
        assert.strictEqual(member.status, 200);
        assert.ok(member.text.includes(H.LONG.slice(0, 40)), 'the body');
        const stranger = await H.req(h, 'GET', url, { token: tok(sam) });
        assert.strictEqual(stranger.status, 404);
        assert.ok(stranger.text.includes('shared with specific people'), 'OVShare.gate');
        assert.ok(stranger.text.includes('ov-share.js') && stranger.text.includes('OVShare.gate'));
        assert.ok(!stranger.text.includes('Board pack'), 'no title');
        const anon = await H.req(h, 'GET', url);
        assert.strictEqual(anon.status, 404);
        assert.ok(anon.text.includes('/auth/login?next='), 'sign in');
        assert.strictEqual((await H.req(h, 'GET', `/api/v1/page/${p.id}/share`, { token: tok(sam) })).status, 404, 'the sheet is the owner’s');
    });

    await check('Everyone and the link: a shared draft opens by its address, still not listed', async () => {
        const p = await make('Everyone draft');
        assert.strictEqual((await putShare(p.id, { audience: 'public' })).status, 200);
        assert.strictEqual((await H.req(h, 'GET', `/w/handbook/${p.slug}`)).status, 200);
        assert.strictEqual((await putShare(p.id, { audience: 'link' })).status, 200);
        assert.strictEqual((await H.req(h, 'GET', `/w/handbook/${p.slug}`)).status, 200, 'the link is the key');
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes(`/w/handbook/${p.slug}`), 'a draft is never in the sitemap');
    });

    await check('publishing widens a draft to its author’s chosen visibility; leaving Everyone removes it at once', async () => {
        const p = await make('Ready to ship');
        assert.strictEqual((await row(p.id)).audience, 'private');
        const pub = await H.req(h, 'POST', `/api/v1/pages/${p.id}/publish`, { token: tok(alice), body: {} });
        assert.strictEqual(pub.status, 200, pub.text);
        assert.strictEqual((await row(p.id)).audience, 'public');
        const url = `/w/handbook/${p.slug}`;
        assert.strictEqual((await H.req(h, 'GET', url)).status, 200);
        assert.ok((await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes(url), 'a public page is in the sitemap');
        const put = await putShare(p.id, { audience: 'private' });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual((await H.req(h, 'GET', url)).status, 404);
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes(url), 'and out of the sitemap');
        assert.strictEqual((await H.req(h, 'GET', url, { token: tok(alice) })).status, 200, 'the owner still reads it');
        const events = await H.outbox(h);
        const tombstones = events.filter((e) => /^wiki\.index_document\.deleted$/.test(e.event_type));
        assert.ok(tombstones.some((e) => JSON.stringify(e.payload || {}).includes(p.id)), 'a search tombstone went out');
    });

    await check('the members list is shown to the owner and the sheet refuses a non-owner', async () => {
        const p = await make('Two readers');
        await putShare(p.id, { audience: 'people', members: [{ subject: { type: 'user', id: sam.subject }, role: 'viewer' }] });
        const mine = await share(p.id, { token: tok(alice) });
        assert.strictEqual(mine.status, 200);
        assert.strictEqual(mine.json.members[0].subject.id, sam.subject);
        assert.strictEqual(mine.json.you.role, 'owner');
        const theirs = await share(p.id, { token: tok(bob) });
        assert.strictEqual(theirs.status, 404);
    });

    console.log(failures ? `\n${failures} failed` : '\nall passed');
    await h.stop();
    process.exit(failures ? 1 : 0);
})();
