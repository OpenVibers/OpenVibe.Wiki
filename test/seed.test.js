'use strict';
/**
 * The official "OpenVibe" seed: idempotent, every page published, cited (GitHub permalinks at a
 * pinned commit, with a retrieval time), indexable under the production gate policy, internally
 * linked without red links, labelled with its real authorship, and free of pricing copy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { seed } = require('../server/wiki/seed');
const content = require('../server/wiki/content');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'openvibe.json'), 'utf8'));

(async () => {
    // Static checks on the seed file itself.
    assert.strictEqual(data.space.slug, 'openvibe');
    assert.strictEqual(data.space.kind, 'official');
    assert.ok(data.pages.length >= 5);
    const titles = new Set(data.pages.map((p) => p.title));
    for (const p of data.pages) {
        const text = [p.title, p.summary || '', p.body, JSON.stringify(p.infobox || [])].join('\n');
        assert.ok(!/\bfree\b|\$0|no cost|pricing/i.test(text), `${p.title}: no pricing copy`);
        assert.ok(p.citations && p.citations.length, `${p.title}: cited`);
        for (const c of p.citations) {
            assert.ok(/^https:\/\/github\.com\/OpenVibers\/[A-Za-z.]+\/blob\/[0-9a-f]{40}\/(README\.md|STATUS\.json)$/.test(c.url), `${p.title}: permalink ${c.url}`);
            assert.ok(!Number.isNaN(Date.parse(c.retrievedAt)), `${p.title}: retrieval time`);
        }
        for (const l of content.extractLinks(p.body, 'openvibe')) assert.ok([...titles].some((t) => content.pageSlug(t) === l.slug), `${p.title}: [[${l.title}]] has a page`);
        content.normalizeInfobox(p.infobox);
    }

    const h = await H.boot({ env: { WIKI_GATE_MIN_WORDS: '80' } });
    try {
        const first = seed(h.svc, data, { log: H.quiet });
        assert.strictEqual(first.created.length, data.pages.length);
        const again = seed(h.svc, data, { log: H.quiet });
        assert.strictEqual(again.created.length, 0, 'idempotent');
        assert.strictEqual(again.skipped.length, data.pages.length);
        const space = h.svc.findSpace('openvibe');
        assert.strictEqual(space.kind, 'official');

        const published = h.svc.publishedPublic();
        assert.strictEqual(published.length, data.pages.length);
        for (const { page, decision } of published) {
            assert.ok(decision.indexable, `${page.title}: indexable (${decision.codes.join(', ')})`);
        }
        // The pages as a reader sees them: no red links, imported authorship disclosed, sitemap lists them all.
        for (const p of data.pages) {
            const r = await H.req(h, 'GET', `/w/openvibe/${content.pageSlug(p.title)}`);
            assert.strictEqual(r.status, 200, p.title);
            assert.ok(!r.text.includes('ov-redlink'), `${p.title}: no red links`);
            assert.ok(r.text.includes('summarised with AI assistance'), `${p.title}: authorship disclosed`);
            assert.ok(r.text.includes('<meta name="robots" content="index, follow">'));
        }
        const sm = await H.req(h, 'GET', '/sitemaps/pages-1.xml');
        assert.strictEqual((sm.text.match(/<loc>/g) || []).length, data.pages.length);
        // The official space is not editable by an ordinary signed-in person, but is by staff.
        const person = { kind: 'user', subject: H.subject(), staff: false };
        const staff = { kind: 'user', subject: H.subject(), staff: true };
        assert.throws(() => h.svc.createPage(space.id, { title: 'Spam', body: 'x' }, person), (e) => e.status === 403);
        assert.ok(h.svc.createPage(space.id, { title: 'Staff note', body: 'x' }, staff).page);
        // Search index documents record the imported authorship.
        const doc = H.outbox(h).find((e) => e.event_type === 'wiki.index_document.upserted').payload;
        assert.strictEqual(doc.authorship, 'imported');
        console.log('seed ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
