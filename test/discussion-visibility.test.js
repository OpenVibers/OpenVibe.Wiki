'use strict';
/**
 * A page's Community discussion thread follows the page: hidden when the page is unpublished,
 * deleted or stops being public (page or space visibility), shown again when it is public again.
 * The call (PUT /api/v1/comments/threads/:id/visibility, community.comment.moderate) runs after the
 * write commits, is best effort, and a Community failure never fails the write.
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    const calls = [];
    let threadIds = 0;
    let communityDown = false;
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    let h;
    const fetchStub = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method || 'GET';
        if (u.host !== 'community.internal') return json(404, { error: 'stub: no route' });
        if (u.pathname === '/api/v1/comments/threads/resolve') {
            threadIds += 1;
            return json(201, { thread: { id: threadIds, visibility: 'public', comment_count: 0 }, created: true });
        }
        const vis = u.pathname.match(/^\/api\/v1\/comments\/threads\/(\d+)\/visibility$/);
        if (vis && method === 'PUT') {
            const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
            calls.push({ thread: vis[1], body: JSON.parse(init.body), headers, inTransaction: h.db.inTransaction });
            if (communityDown) return json(503, { code: 'unavailable' });
            return json(200, { thread: { id: Number(vis[1]), visibility: JSON.parse(init.body).visibility } });
        }
        const th = u.pathname.match(/^\/api\/v1\/comments\/threads\/(\d+)$/);
        if (th && method === 'GET') return json(200, { thread: { id: Number(th[1]), visibility: 'public', comment_count: 0 }, comments: [], next_cursor: null });
        return json(404, { error: 'stub: no route' });
    };
    const scopes = [];
    const tokens = {
        getToken: async () => 'stub-token',
        authHeaders: async (ctx = {}) => { scopes.push(ctx); return { Authorization: 'Bearer stub-token' }; },
        invalidate() {},
    };
    h = await H.boot({ fetch: fetchStub, tokens, env: { OV_COMMUNITY_INTERNAL_URL: 'http://community.internal' } });
    const tok = H.userToken({ subject: H.subject() });
    const settle = async (n) => { for (let i = 0; i < 50 && calls.length < n; i++) await new Promise((r) => setTimeout(r, 10)); await new Promise((r) => setTimeout(r, 20)); };
    const last = () => calls[calls.length - 1];

    try {
        let r = await H.req(h, 'POST', '/api/v1/spaces', { token: tok, body: { name: 'Talk', slug: 'talk' } });
        assert.strictEqual(r.status, 201, r.text);
        r = await H.req(h, 'POST', '/api/v1/spaces/talk/pages', { token: tok, body: { title: 'Discussed', body: H.LONG } });
        assert.strictEqual(r.status, 201, r.text);
        const pageId = r.json.page.id;
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok, body: {} });
        assert.strictEqual(r.status, 200, r.text);
        await settle(0);
        assert.strictEqual(calls.length, 0, 'publishing a page that has no thread yet calls nothing');

        // Rendering the public page resolves its thread (id 1).
        r = await H.req(h, 'GET', '/w/talk/discussed');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(h.db.prepare('SELECT thread_id FROM wiki_discussion_refs WHERE entity_id = ?').get(pageId).thread_id, '1');

        // Unpublished: hidden. After the commit, with a moderate token.
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/unpublish`, { token: tok, body: {} });
        assert.strictEqual(r.status, 200, r.text);
        await settle(1);
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual({ thread: last().thread, body: last().body }, { thread: '1', body: { visibility: 'hidden' } });
        assert.strictEqual(last().headers.authorization, 'Bearer stub-token');
        assert.strictEqual(last().inTransaction, false, 'called after the write committed, never inside the transaction');
        assert.ok(scopes.some((s) => s.audience === 'openvibe.community' && s.scope === 'community.comment.moderate'));

        // Published again: shown.
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok, body: {} });
        assert.strictEqual(r.status, 200, r.text);
        await settle(2);
        assert.strictEqual(calls.length, 2);
        assert.deepStrictEqual(last().body, { visibility: 'public' });

        // A change that keeps the page public (a move) calls nothing.
        r = await H.req(h, 'PATCH', `/api/v1/pages/${pageId}`, { token: tok, body: { slug: 'discussed-page' } });
        assert.strictEqual(r.status, 200, r.text);
        await settle(3);
        assert.strictEqual(calls.length, 2);

        // Made members-only, then private (still not public: one call), then public again.
        r = await H.req(h, 'PATCH', `/api/v1/pages/${pageId}`, { token: tok, body: { visibility: 'members' } });
        assert.strictEqual(r.status, 200, r.text);
        await settle(3);
        assert.strictEqual(calls.length, 3);
        assert.deepStrictEqual(last().body, { visibility: 'hidden' });
        r = await H.req(h, 'PATCH', `/api/v1/pages/${pageId}`, { token: tok, body: { visibility: 'private' } });
        assert.strictEqual(r.status, 200, r.text);
        await settle(4);
        assert.strictEqual(calls.length, 3, 'members → private is not a change of public-ness');
        r = await H.req(h, 'PATCH', `/api/v1/pages/${pageId}`, { token: tok, body: { visibility: 'public' } });
        await settle(4);
        assert.strictEqual(calls.length, 4);
        assert.deepStrictEqual(last().body, { visibility: 'public' });

        // The space stops being public: every public page's thread is hidden; public again: shown.
        r = await H.req(h, 'PATCH', '/api/v1/spaces/talk', { token: tok, body: { visibility: 'members' } });
        assert.strictEqual(r.status, 200, r.text);
        await settle(5);
        assert.strictEqual(calls.length, 5);
        assert.deepStrictEqual(last().body, { visibility: 'hidden' });
        r = await H.req(h, 'PATCH', '/api/v1/spaces/talk', { token: tok, body: { visibility: 'public' } });
        await settle(6);
        assert.strictEqual(calls.length, 6);
        assert.deepStrictEqual(last().body, { visibility: 'public' });

        // Community is down: the write still succeeds (best effort).
        communityDown = true;
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/unpublish`, { token: tok, body: {} });
        assert.strictEqual(r.status, 200, r.text);
        await settle(7);
        assert.strictEqual(calls.length, 7);
        assert.strictEqual(h.svc.pageById(pageId).state, 'unpublished');
        communityDown = false;
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok, body: {} });
        await settle(8);
        assert.deepStrictEqual(last().body, { visibility: 'public' });

        // Deleted: hidden.
        r = await H.req(h, 'DELETE', `/api/v1/pages/${pageId}`, { token: tok });
        assert.strictEqual(r.status, 200, r.text);
        await settle(9);
        assert.strictEqual(calls.length, 9);
        assert.deepStrictEqual(last().body, { visibility: 'hidden' });
        assert.ok(calls.every((c) => c.thread === '1' && c.inTransaction === false));

        // A failed write calls nothing.
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/unpublish`, { token: tok, body: {} });
        assert.ok(r.status >= 400);
        await settle(10);
        assert.strictEqual(calls.length, 9);
        console.log('discussion visibility ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
