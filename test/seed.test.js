'use strict';
/**
 * The official "OpenVibe" seed: idempotent, every page published, cited (GitHub permalinks at a
 * pinned commit, with a retrieval time), internally linked without red links, labelled with its real
 * authorship (imported, written with AI assistance), free of pricing copy, and — being generated
 * text — noindex and out of sitemaps, feeds and Search until a person reviews it; the only gate
 * reason left is that review (the production word and source policy passes).
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
        // Generated (AI-assisted) text: published and readable, but noindex until a person reviews it.
        for (const { page, decision } of published) {
            assert.strictEqual(page.state, 'published');
            assert.strictEqual(decision.indexable, false, page.title);
            assert.strictEqual(decision.listable, false, page.title);
            assert.deepStrictEqual(decision.codes, ['ai_generated_unreviewed'], `${page.title}: only the review is missing (${decision.codes.join(', ')})`);
            assert.strictEqual(h.stores.revisions.get(page.id, page.published_revision).meta.authorship.importedFrom.aiAssisted, true);
        }
        for (const p of data.pages) {
            const r = await H.req(h, 'GET', `/w/openvibe/${content.pageSlug(p.title)}`);
            assert.strictEqual(r.status, 200, p.title);
            assert.ok(!r.text.includes('ov-redlink'), `${p.title}: no red links`);
            assert.ok(r.text.includes('summarised with AI assistance'), `${p.title}: authorship disclosed`);
            assert.ok(r.text.includes('Not yet reviewed by a person.'), `${p.title}: review state disclosed`);
            assert.ok(r.text.includes('<meta name="robots" content="noindex, nofollow">'), `${p.title}: noindex`);
        }
        // Absent from sitemaps, feeds and Search until reviewed.
        assert.strictEqual(((await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.match(/<loc>/g) || []).length, 0);
        const atomFeed = await H.req(h, 'GET', '/feed.atom');
        assert.strictEqual(atomFeed.status, 200, 'an empty feed, not a 404');
        assert.ok(!atomFeed.text.includes('<entry>'));
        assert.deepStrictEqual((await H.req(h, 'GET', '/feed.json')).json.items, []);
        const idx = H.outbox(h).filter((e) => e.event_type.startsWith('wiki.index_document.'));
        assert.ok(idx.length && idx.every((e) => e.event_type === 'wiki.index_document.deleted'), 'Search only ever got tombstones');
        // The official space is not editable by an ordinary signed-in person, but is by staff.
        const person = { kind: 'user', subject: H.subject(), staff: false };
        const staff = { kind: 'user', subject: H.subject(), staff: true };
        assert.throws(() => h.svc.createPage(space.id, { title: 'Spam', body: 'x' }, person), (e) => e.status === 403);
        assert.ok(h.svc.createPage(space.id, { title: 'Staff note', body: 'x' }, staff).page);
        // After a person's review the page is indexable; its Search document records the imported authorship.
        const first1 = published[0].page;
        h.svc.reviewRevision('openvibe', first1.slug, first1.published_revision, { decision: 'approved' }, staff);
        const doc = H.outbox(h).filter((e) => e.event_type === 'wiki.index_document.upserted').pop().payload;
        assert.strictEqual(doc.id, first1.id);
        assert.strictEqual(doc.authorship, 'imported');
        assert.strictEqual(doc.indexability.decision, 'index');
        console.log('seed ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
