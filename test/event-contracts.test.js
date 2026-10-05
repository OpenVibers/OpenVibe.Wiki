'use strict';
/**
 * The wiki.* event payload schemas and capability manifests are released in openvibe-contracts (v0.96.0
 * or later; the earlier pin had neither). Every event this service emits must validate against its
 * released payload schema, and every capability the code enforces must be a released, active id owned
 * by wiki — a pin that moved backwards or a payload that drifted fails here.
 */
const assert = require('assert');
const H = require('./helpers');
const contracts = require('openvibe-contracts');
const { CAPS } = require('../server/auth/capabilities');

(async () => {
    // The capabilities the routes enforce are the released ones, so capabilities.check() decides them.
    for (const id of Object.values(CAPS)) {
        const cap = contracts.capabilities.get(id);
        assert.ok(cap, `${id} is released by openvibe-contracts`);
        assert.strictEqual(cap.owner, 'wiki', `${id} is owned by wiki`);
        assert.notStrictEqual(cap.status, 'retired', `${id} is not retired`);
    }
    assert.deepStrictEqual(
        contracts.capabilities.check({ cap: ['wiki.*'] }, CAPS.PAGE_READ),
        { allowed: true, code: null, reason: null },
        'the library grants wiki.page.read from a wiki.* grant',
    );

    const h = await H.boot();
    const owner = H.subject(), editor = H.subject(), watcher = H.subject();
    const tok = (sub, role = 'user') => H.userToken({ subject: sub, role });
    try {
        // One flow over the public routes: create a public space and page, publish, watch, revise,
        // republish, unpublish, republish and delete; then a members page (the tombstone path).
        let r = await H.req(h, 'POST', '/api/v1/spaces', { token: tok(owner), body: { name: 'Garden', slug: 'garden', visibility: 'public' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual((await H.req(h, 'PUT', `/api/v1/spaces/garden/roles/${editor}`, { token: tok(owner), body: { role: 'editor' } })).status, 200);
        const page = { title: 'Tomatoes', body: H.LONG, citations: [{ url: 'https://example.org/t', retrieved_at: '2026-09-01T00:00:00Z' }] };
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: tok(owner), body: page });
        assert.strictEqual(r.status, 201, r.text);
        const pageId = r.json.page.id;
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok(owner), body: {} })).status, 200);
        await h.svc.watch(pageId, { kind: 'user', subject: watcher }, true);
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${pageId}/revisions`, { token: tok(editor), body: { expected_revision: 1, body: `${H.LONG} More.` } })).status, 201);
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok(owner), body: {} })).status, 200);
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${pageId}/unpublish`, { token: tok(owner), body: {} })).status, 200);
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok(owner), body: {} })).status, 200);
        assert.strictEqual((await H.req(h, 'DELETE', `/api/v1/pages/${pageId}`, { token: tok(owner) })).status, 200);
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: tok(owner), body: { ...page, title: 'Secret', visibility: 'members' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${r.json.page.id}/publish`, { token: tok(owner), body: {} })).status, 200);

        const wikiEvents = (await H.outbox(h)).filter((e) => typeof e.event_type === 'string' && e.event_type.startsWith('wiki.'));
        const types = new Set(wikiEvents.map((e) => e.event_type));
        // The flow must actually exercise the range, or this proves little.
        for (const need of ['wiki.space.updated', 'wiki.revision.created', 'wiki.watch.triggered',
            'wiki.page.published', 'wiki.page.updated', 'wiki.page.unpublished', 'wiki.page.deleted',
            'wiki.index_document.upserted', 'wiki.index_document.deleted']) {
            assert.ok(types.has(need), `${need} was emitted`);
        }
        for (const e of wikiEvents) {
            const v = contracts.validate(`${e.event_type}@1`, e.payload);
            assert.ok(v.valid, `${e.event_type}: ${JSON.stringify(v.errors)}`);
        }
        console.log(`event contracts: ${wikiEvents.length} events, ${types.size} types, all valid`);
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
