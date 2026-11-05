'use strict';
/**
 * GET /api/v1/review-queue: the published pages whose AI-assisted text nobody has reviewed yet,
 * staff only, oldest first, with the gate's reason in words and the review path that clears it.
 * Approving a page through its own review route removes it from the queue.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { seed, SYSTEM } = require('../server/wiki/seed');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'openvibe.json'), 'utf8'));

(async () => {
    const h = await H.boot({ env: { WIKI_GATE_MIN_WORDS: '80' } });
    const staff = H.subject(), person = H.subject();
    const tok = (sub, role = 'user') => H.userToken({ subject: sub, role });
    try {
        await seed(h.svc, data, { log: H.quiet });
        const space = await h.svc.findSpace('openvibe');
        const page = await h.svc.findPage(space.id, 'openvibe-search');

        let r = await H.req(h, 'GET', '/api/v1/review-queue', { token: tok(staff, 'admin') });
        assert.strictEqual(r.status, 200, r.text);
        const item = r.json.items.find((i) => i.id === page.id);
        assert.ok(item, 'the seeded AI-assisted page is waiting');
        assert.deepStrictEqual([item.site, item.kind, item.revision], ['wiki', 'wiki_page', page.published_revision]);
        assert.strictEqual(item.url, `http://wiki.test/w/openvibe/${page.slug}`);
        assert.match(item.title, /Search|search/i);
        assert.ok(item.reasons.some((x) => x.code === 'ai_generated_unreviewed' && /AI-generated/.test(x.text)), 'the gate reason is in words');
        assert.strictEqual(item.review.path, `/api/v1/pages/${page.id}/revisions/${page.published_revision}/review`);
        assert.ok(Date.parse(item.createdAt) > 0);
        assert.deepStrictEqual(r.json.items.map((i) => Date.parse(i.createdAt)), r.json.items.map((i) => Date.parse(i.createdAt)).sort((a, b) => a - b), 'oldest first');

        r = await H.req(h, 'GET', '/api/v1/review-queue', { token: tok(person) });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json.code, 'review.forbidden');
        assert.strictEqual((await H.req(h, 'GET', '/api/v1/review-queue')).status, 403);

        const approve = await H.req(h, 'POST', item.review.path, { token: tok(staff, 'admin'), body: { decision: 'approved', note: 'Checked against the README' } });
        assert.strictEqual(approve.status, 201, approve.text);
        r = await H.req(h, 'GET', '/api/v1/review-queue', { token: tok(staff, 'admin') });
        assert.ok(!r.json.items.some((i) => i.id === page.id), 'a reviewed page leaves the queue');
        assert.strictEqual((await h.stores.reviews.history(page.id)).length, 1, 'the service review log is the audit');
    } finally {
        await h.stop();
    }
    console.log('review-queue.test.js: ok');
})().catch((e) => { console.error(e); process.exit(1); });
