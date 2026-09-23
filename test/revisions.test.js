'use strict';
/**
 * create → edit → publish → revise → diff → revert keeps an immutable lineage; citations and
 * infobox values stay attached to the exact revision that used them.
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    const h = await H.boot();
    const alice = { kind: 'user', subject: H.subject(), staff: false };
    try {
        const space = h.svc.createSpace({ name: 'Bread', slug: 'bread' }, alice);
        const src1 = { url: 'https://example.org/rye', title: 'Rye notes', retrievedAt: '2026-09-20T10:00:00Z', quote: { text: 'Rye is a grass.' } };
        const src2 = { url: 'https://example.org/wheat', title: 'Wheat notes', retrievedAt: '2026-09-21T10:00:00Z' };

        // r1: created with a citation and a typed infobox
        const { page, revision: r1 } = h.svc.createPage(space.id, {
            title: 'Rye bread', body: `# Rye bread\n\n${H.LONG}`, citations: [src1],
            infobox: [{ label: 'Flour', type: 'text', value: 'rye' }, { label: 'Hydration', type: 'number', value: '78' }, { label: 'Sourdough', type: 'boolean', value: 'yes' }],
        }, alice);
        assert.strictEqual(r1.number, 1);
        assert.strictEqual(page.state, 'draft');

        // publish r1
        h.svc.publish(page.id, { revision: 1 }, alice);
        assert.strictEqual(h.svc.pageById(page.id).published_revision, 1);

        // r2: edit drops src1, adds src2, changes the infobox
        const e2 = h.svc.editPage(page.id, {
            expectedRevision: 1, body: `# Rye bread\n\nA different text. ${H.LONG}`, citations: [src2], keepCitations: 'none',
            infobox: [{ label: 'Flour', type: 'text', value: 'rye and wheat' }],
        }, alice);
        assert.strictEqual(e2.revision.number, 2);
        assert.strictEqual(e2.created, true);

        // Optimistic concurrency: an edit based on r1 is a 412 conflict.
        assert.throws(() => h.svc.editPage(page.id, { expectedRevision: 1, body: 'stale edit' }, alice), (err) => err.status === 412 && err.code === 'revision.conflict');
        // An identical edit creates nothing.
        const same = h.svc.editPage(page.id, { expectedRevision: 2 }, alice);
        assert.strictEqual(same.created, false);

        // Citations stay with their revision.
        const c1 = h.svc.citationsOf(page, 1);
        const c2 = h.svc.citationsOf(page, 2);
        assert.deepStrictEqual(c1.map((c) => c.url), ['https://example.org/rye']);
        assert.deepStrictEqual(c2.map((c) => c.url), ['https://example.org/wheat']);
        assert.strictEqual(c1[0].retrievedAt, '2026-09-20T10:00:00.000Z');
        assert.deepStrictEqual(c1[0].quote, { text: 'Rye is a grass.', start: null, end: null });
        // The published page (still r1) shows r1's sources, not r2's.
        const pub = h.svc.view(space, h.svc.pageById(page.id), alice, {});
        assert.strictEqual(pub.revision.number, 1);
        assert.deepStrictEqual(pub.citations.map((c) => c.url), ['https://example.org/rye']);
        assert.deepStrictEqual(pub.infobox, [
            { key: 'flour', label: 'Flour', type: 'text', value: 'rye' },
            { key: 'hydration', label: 'Hydration', type: 'number', value: 78 },
            { key: 'sourdough', label: 'Sourdough', type: 'boolean', value: true },
        ]);

        // Citations cannot be attached to the published revision after the fact.
        assert.throws(() => h.svc.attachCitations(page.id, 1, [src2], alice), (err) => err.status === 409);
        // ...but can be to the unpublished head.
        h.svc.attachCitations(page.id, 2, [{ url: 'https://example.org/extra', retrievedAt: '2026-09-22T00:00:00Z' }], alice);
        assert.strictEqual(h.svc.citationsOf(page, 2).length, 2);
        // A URL citation without a retrieval time is refused (never invented).
        assert.throws(() => h.svc.attachCitations(page.id, 2, [{ url: 'https://example.org/no-date' }], alice), (err) => err.code === 'citation.retrieved_at_required');

        // Publish r2, then diff r1 → r2
        h.svc.publish(page.id, { revision: 2 }, alice);
        const d = h.svc.diff(h.svc.pageById(page.id), 1, 2);
        assert.ok(d.content.ops.some((o) => o.op === 'insert' && /different/.test(o.text)));
        assert.ok(d.fields.some((f) => f.field === 'infobox'));

        // Revert to r1 = r3, a copy of r1 with r1's citations carried forward; history is untouched.
        const rv = h.svc.revert(page.id, { toRevision: 1, expectedRevision: 2, message: 'back to rye' }, alice);
        assert.strictEqual(rv.revision.number, 3);
        assert.strictEqual(rv.revision.kind, 'revert');
        assert.strictEqual(rv.revision.revertedTo, 1);
        assert.strictEqual(rv.revision.content, h.stores.revisions.get(page.id, 1).content);
        assert.strictEqual(rv.published, true, 'a revert of a published page is published');
        const c3 = h.svc.citationsOf(page, 3);
        assert.deepStrictEqual(c3.map((c) => c.url), ['https://example.org/rye']);
        assert.strictEqual(c3[0].carriedFrom, c1[0].id);
        assert.strictEqual(h.svc.citationsOf(page, 2).length, 2, 'r2 keeps its own citations');
        assert.deepStrictEqual(h.svc.view(space, h.svc.pageById(page.id), alice, {}).infobox.map((x) => x.key), ['flour', 'hydration', 'sourdough']);

        // Lineage: r3 → r2 → r1 by parent pointers.
        assert.deepStrictEqual(h.stores.revisions.lineage(page.id).map((r) => r.number), [3, 2, 1]);
        // Immutability is enforced by the database, not by convention.
        assert.throws(() => h.db.prepare('UPDATE wiki_page_revisions SET content = ? WHERE entity_id = ?').run('rewritten', page.id), /immutable/);
        assert.throws(() => h.db.prepare('DELETE FROM wiki_page_revisions WHERE entity_id = ?').run(page.id), /never deleted/);
        assert.throws(() => h.db.prepare('UPDATE wiki_citations SET url = ? WHERE entity_id = ?').run('https://evil.example', page.id), /immutable/);
        assert.throws(() => h.db.prepare('UPDATE wiki_infobox_values SET value_text = ? WHERE page_id = ?').run('x', page.id), /immutable/);
        assert.throws(() => h.db.prepare('DELETE FROM wiki_infobox_values WHERE page_id = ?').run(page.id), /never deleted/);

        // The same flow over HTTP: history lists every revision, the diff page renders.
        const hist = await H.req(h, 'GET', `/w/bread/rye-bread/history`);
        assert.strictEqual(hist.status, 200);
        for (const n of [1, 2, 3]) assert.ok(hist.text.includes(`?rev=${n}"`), `history lists r${n}`);
        const diff = await H.req(h, 'GET', '/w/bread/rye-bread/diff/1/2');
        assert.strictEqual(diff.status, 200);
        assert.ok(/<ins>|<del>/.test(diff.text));
        assert.ok(diff.text.includes('<meta name="robots" content="noindex, nofollow">'));
        // An old revision is viewable and marked noindex.
        const old = await H.req(h, 'GET', '/w/bread/rye-bread?rev=2');
        assert.strictEqual(old.status, 200);
        assert.ok(old.text.includes('not the published revision 3'));
        assert.ok(old.text.includes('content="noindex, nofollow"'));

        // Every revision produced a wiki.revision.created event.
        const created = H.outbox(h).filter((e) => e.event_type === 'wiki.revision.created' && e.subject.id === page.id).map((e) => e.subject.revision);
        assert.deepStrictEqual(created, [1, 2, 3]);
        console.log('revisions ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
