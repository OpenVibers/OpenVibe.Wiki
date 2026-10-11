'use strict';
/**
 * The seed's --revise path: an existing page that differs from the seed gets exactly one new
 * published revision through the editor's own path, a page that matches is left alone, a second
 * run creates nothing, and the seed's imported / AI-assisted authorship marking is preserved.
 */
const assert = require('assert');
const H = require('./helpers');
const { seed } = require('../server/wiki/seed');

const SHA = 'cc7a8fc09705bfc69ee24aeb43e29c2d4453ec6b';
const cite = (quote) => ({
    url: `https://github.com/OpenVibers/OpenVibe.Wiki/blob/${SHA}/README.md`,
    title: 'OpenVibe.Wiki README (commit cc7a8fc)',
    retrievedAt: '2026-10-11T12:00:00.000Z',
    quote,
});

const data = {
    space: { slug: 'tests', name: 'Tests', description: 'Seed revise fixture', kind: 'official', visibility: 'public' },
    pages: [
        {
            title: 'Alpha',
            parent: null,
            body: `**Alpha** is the first fixture page.\n\n## What it does\n\nAlpha records what the seed says about itself. ${H.LONG}\n`,
            summary: 'The first fixture page.',
            infobox: [{ key: 'runtime', label: 'Runtime', type: 'text', value: 'Node/Express, PostgreSQL' }],
            citations: [cite('Alpha is the first fixture page.')],
        },
        {
            title: 'Beta',
            parent: 'Alpha',
            body: `**Beta** is the second fixture page and a child of [[Alpha]].\n\n## What it does\n\nBeta is here to be revised. ${H.LONG}\n`,
            summary: 'The second fixture page.',
            infobox: [{ key: 'runtime', label: 'Runtime', type: 'text', value: 'Node/Express, PostgreSQL' }],
            citations: [cite('Beta is the second fixture page.')],
        },
    ],
};

const clone = (x) => JSON.parse(JSON.stringify(x));

(async () => {
    const h = await H.boot();
    try {
        const first = await seed(h.svc, data, { log: H.quiet });
        assert.strictEqual(first.created.length, 2);
        const space = await h.svc.findSpace('tests');
        const beta = await h.svc.findPage(space.id, 'beta');
        assert.strictEqual(beta.published_revision, 1);

        // A second plain seed run creates nothing and leaves the pages alone.
        const again = await seed(h.svc, data, { log: H.quiet });
        assert.strictEqual(again.created.length, 0);
        assert.strictEqual(again.skipped.length, 2);

        // Only Beta changes: one new revision, published; Alpha is untouched.
        const changed = clone(data);
        changed.pages[1].body = `**Beta** is the second fixture page and a child of [[Alpha]].\n\n## What it does\n\nBeta now says something new. ${H.LONG}\n`;
        changed.pages[1].citations = [cite('Beta now says something new.')];
        const out = await seed(h.svc, changed, { revise: true, log: H.quiet });
        assert.strictEqual(out.created.length, 0, 'nothing new is created');
        assert.deepStrictEqual(out.revised, ['Beta'], 'only the changed page is revised');
        assert.deepStrictEqual(out.unchanged, ['Alpha'], 'the matching page is left alone');
        assert.deepStrictEqual(out.skipped.sort(), ['Alpha', 'Beta']);

        // Beta: revision 2, published, with the seed's own authorship marking.
        const beta2 = await h.svc.pageById(beta.id);
        assert.strictEqual(beta2.published_revision, 2);
        assert.strictEqual(beta2.state, 'published');
        const r2 = await h.stores.revisions.get(beta.id, 2);
        assert.strictEqual(r2.content, changed.pages[1].body, 'the new body is stored');
        assert.strictEqual(r2.meta.authorship.mode, 'imported');
        assert.strictEqual(r2.meta.authorship.importedFrom.aiAssisted, true, 'still AI-assisted');
        assert.strictEqual(r2.meta.authorship.importedFrom.originalAuthor, 'OpenVibers');
        assert.match(r2.meta.authorship.importedFrom.label, /AI assistance/);
        // The seed's citations replaced the old ones on that revision.
        assert.deepStrictEqual((await h.svc.citationsOf(beta2, 2)).map((c) => c.quote.text), ['Beta now says something new.']);

        // Alpha got no revision at all.
        const alpha = await h.svc.findPage(space.id, 'alpha');
        assert.strictEqual(alpha.published_revision, 1);
        assert.strictEqual(await h.stores.revisions.headNumber(alpha.id), 1);

        // Idempotent: a second revise run creates nothing.
        const noop = await seed(h.svc, changed, { revise: true, log: H.quiet });
        assert.strictEqual(noop.created.length, 0);
        assert.strictEqual(noop.revised.length, 0, 'no revision on the second run');
        assert.strictEqual(noop.unchanged.length, 2);
        assert.strictEqual(await h.stores.revisions.headNumber(beta.id), 2, 'still exactly one new revision');
        assert.strictEqual(await h.stores.revisions.headNumber(alpha.id), 1);

        // Without --revise the changed page is left alone (unchanged semantics).
        const plain = await seed(h.svc, changed, { log: H.quiet });
        assert.strictEqual(plain.created.length, 0);
        assert.strictEqual(plain.skipped.length, 2);
        assert.strictEqual(await h.stores.revisions.headNumber(beta.id), 2);

        console.log('seed-revise ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
