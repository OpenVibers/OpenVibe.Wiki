'use strict';
/**
 * A person reviews an existing AI-assisted revision (the seed's imported pages, including rows
 * seeded before the explicit aiAssisted flag existed): only people with the owner or editor role
 * may; approval flips the page to indexable, re-sends the Search document once (with
 * wiki.page.updated), and puts it in sitemaps and feeds; "needs changes" takes it out again.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const H = require('./helpers');
const { seed, SYSTEM } = require('../server/wiki/seed');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'openvibe.json'), 'utf8'));

(async () => {
    const h = await H.boot({ env: { WIKI_GATE_MIN_WORDS: '80' } });
    const staff = H.subject(), editor = H.subject(), viewer = H.subject(), stranger = H.subject();
    const tok = (sub, role = 'user') => H.userToken({ subject: sub, role });
    try {
        await seed(h.svc, data, { log: H.quiet });
        const space = await h.svc.findSpace('openvibe');
        // A row seeded before the flag existed: recognised by its label alone.
        const legacy = await h.svc.createPage(space.id, {
            title: 'Legacy import', body: `${data.pages[1].body}`, citations: [{ url: data.pages[1].citations[0].url, retrievedAt: '2026-09-22T12:00:00Z' }],
            authorship: { mode: 'imported', importedFrom: { label: 'the READMEs, summarised with AI assistance', originalAuthor: 'OpenVibers' } },
        }, SYSTEM);
        await h.svc.publish(legacy.page.id, {}, SYSTEM);
        assert.strictEqual((await h.stores.revisions.get(legacy.page.id, 1)).meta.authorship.importedFrom.aiAssisted, undefined);
        assert.deepStrictEqual((await h.svc.publishedPublic()).find((x) => x.page.id === legacy.page.id).decision.codes, ['ai_generated_unreviewed']);

        await h.svc.setRole(space.id, editor, 'editor', { kind: 'user', subject: staff, staff: true });
        await h.svc.setRole(space.id, viewer, 'viewer', { kind: 'user', subject: staff, staff: true });
        const page = await h.svc.findPage(space.id, 'openvibe-search');
        const n = page.published_revision;
        const url = `/api/v1/pages/${page.id}/revisions/${n}/review`;
        const indexEvents = async () => (await H.outbox(h)).filter((e) => e.subject.id === page.id && e.event_type.startsWith('wiki.index_document.'));
        const updates = async () => (await H.outbox(h)).filter((e) => e.subject.id === page.id && e.event_type === 'wiki.page.updated');
        const before = { index: (await indexEvents()).length, updates: (await updates()).length };

        // Refused: anonymous, a signed-in stranger, a viewer, a service acting as itself, a service without the capability.
        assert.strictEqual((await H.req(h, 'POST', url, { body: { decision: 'approved' } })).status, 403);
        assert.strictEqual((await H.req(h, 'POST', url, { token: tok(stranger), body: { decision: 'approved' } })).status, 403);
        assert.strictEqual((await H.req(h, 'POST', url, { token: tok(viewer), body: { decision: 'approved' } })).status, 403);
        assert.strictEqual((await H.req(h, 'POST', url, { token: H.serviceToken({ cap: ['wiki.revision.publish'] }), body: { decision: 'approved' } })).status, 403);
        let r = await H.req(h, 'POST', url, { token: H.serviceToken({ cap: ['wiki.page.read'] }), headers: { 'X-OV-Subject': editor }, body: { decision: 'approved' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json.code, 'capability.denied');
        assert.strictEqual((await H.req(h, 'POST', url, { token: tok(editor), body: { decision: 'maybe' } })).status, 422);
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${page.id}/revisions/99/review`, { token: tok(editor), body: { decision: 'approved' } })).status, 404);
        // Nothing changed.
        assert.strictEqual((await h.stores.reviews.history(page.id)).length, 0);
        assert.deepStrictEqual({ index: (await indexEvents()).length, updates: (await updates()).length }, before);
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('openvibe-search'));

        // The history view offers the review form to editors only.
        let hist = await H.req(h, 'GET', '/w/openvibe/openvibe-search/history', { cookie: H.cookieFor(tok(editor)) });
        assert.ok(hist.text.includes('Reviewed — correct') && hist.text.includes('Needs changes'));
        assert.ok(!(await H.req(h, 'GET', '/w/openvibe/openvibe-search/history')).text.includes('Reviewed — correct'));
        assert.ok(!(await H.req(h, 'GET', '/w/openvibe/openvibe-search/history', { cookie: H.cookieFor(tok(viewer)) })).text.includes('Reviewed — correct'));
        // A viewer posting the form is refused.
        r = await H.req(h, 'POST', '/w/openvibe/openvibe-search/review', { cookie: H.cookieFor(tok(viewer)), form: { revision: String(n), decision: 'approved' } });
        assert.strictEqual(r.status, 403);

        // An editor approves through the form (a service acting for the editor would work the same way).
        r = await H.req(h, 'POST', '/w/openvibe/openvibe-search/review', { cookie: H.cookieFor(tok(editor)), form: { revision: String(n), decision: 'approved', note: 'Checked against the README' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), '/w/openvibe/openvibe-search/history');
        const reviews = await h.stores.reviews.history(page.id);
        assert.strictEqual(reviews.length, 1);
        assert.deepStrictEqual([reviews[0].reviewer, reviews[0].decision, reviews[0].note], [editor, 'approved', 'Checked against the README']);

        // Indexable now; the Search document went out exactly once, with wiki.page.updated.
        const idx = (await indexEvents()).slice(before.index);
        assert.strictEqual(idx.length, 1);
        assert.strictEqual(idx[0].event_type, 'wiki.index_document.upserted');
        assert.strictEqual(idx[0].payload.indexability.decision, 'index');
        assert.ok(idx[0].subject.revision > (await indexEvents())[before.index - 1].subject.revision, 'the sequencer bumped the index revision');
        assert.ok(contracts.validate('search.index-document@1', idx[0].payload).valid);
        const upd = (await updates()).slice(before.updates);
        assert.strictEqual(upd.length, 1);
        assert.strictEqual(upd[0].visibility, 'public');
        assert.strictEqual(upd[0].payload.indexability.decision, 'index');
        assert.ok(contracts.validate('events.event-envelope@1', upd[0]).valid);
        r = await H.req(h, 'GET', '/w/openvibe/openvibe-search');
        assert.ok(r.text.includes('<meta name="robots" content="index, follow">'));
        assert.ok(r.text.includes('Reviewed by a person.'));
        assert.ok(!r.text.includes('Not yet reviewed by a person.'));
        assert.ok((await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('http://wiki.test/w/openvibe/openvibe-search'));
        assert.ok((await H.req(h, 'GET', '/feed.atom')).text.includes('http://wiki.test/w/openvibe/openvibe-search'));
        assert.ok((await H.req(h, 'GET', '/feed.json')).json.items.some((i) => i.url === 'http://wiki.test/w/openvibe/openvibe-search'));
        // The form disappears for a reviewed revision; other pages still wait.
        hist = await H.req(h, 'GET', '/w/openvibe/openvibe-search/history', { cookie: H.cookieFor(tok(editor)) });
        assert.ok(!hist.text.includes('Reviewed — correct'));
        assert.ok(hist.text.includes('reviewed by a person'));
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('openvibe-events'));

        // A second identical approval records the review but sends nothing new (same document).
        const count = (await indexEvents()).length;
        r = await H.req(h, 'POST', url, { token: H.serviceToken({ cap: ['wiki.revision.publish'] }), headers: { 'X-OV-Subject': editor }, body: { decision: 'approved' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.indexable, true);
        assert.strictEqual(r.json.action, null);
        assert.strictEqual((await indexEvents()).length, count);

        // "Needs changes" takes it out again: tombstone + wiki.page.updated, gone from the sitemap.
        r = await H.req(h, 'POST', url, { token: tok(staff, 'admin'), body: { decision: 'rejected', note: 'Status is out of date' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.indexable, false);
        assert.deepStrictEqual(r.json.reasons, ['ai_generated_unreviewed']);
        assert.strictEqual((await indexEvents()).pop().event_type, 'wiki.index_document.deleted');
        assert.strictEqual((await updates()).length, before.updates + 2);
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('openvibe-search'));
        assert.ok((await H.req(h, 'GET', '/w/openvibe/openvibe-search')).text.includes('Not yet reviewed by a person.'));

        // The legacy-labelled row is reviewable the same way.
        await h.svc.reviewRevision(space.id, 'legacy-import', 1, { decision: 'approved' }, { kind: 'user', subject: editor });
        assert.strictEqual((await h.svc.publishedPublic()).find((x) => x.page.id === legacy.page.id).decision.indexable, true);

        // Human revisions and AI proposals are unaffected: a pending proposal goes through its own review.
        const prop = await h.svc.propose({ space: 'openvibe', pageId: page.id, body: `${data.pages[6].body} x`, workflow: { id: 'wiki.generate_page', runId: 'run_9' } }, { kind: 'service', service: 'svc:ai', subject: null });
        await assert.rejects(async () => await h.svc.reviewRevision(space.id, page.slug, prop.revision.number, { decision: 'approved' }, { kind: 'user', subject: editor }), (e) => e.code === 'review.proposal_pending');
        console.log('review ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });

// Rows seeded under the old rule (indexed before AI-assisted imports needed review) are corrected at boot.
(async () => {
    const { seed: seedFn } = require('../server/wiki/seed');
    const h1 = await H.boot({ env: { WIKI_GATE_MIN_WORDS: '80' } });
    const shared = h1.db;
    await seedFn(h1.svc, data, { log: H.quiet });
    const page = await h1.svc.findPage((await h1.svc.findSpace('openvibe')).id, 'openvibe-network');
    // Simulate the host: Search was last sent an indexable document for this page.
    const old = (await h1.db.prepare("SELECT revision FROM wiki_index_revisions WHERE id = ?").get(page.id)).revision;
    await h1.db.prepare("UPDATE wiki_index_revisions SET hash = 'sent-under-the-old-rule' WHERE id = ?").run(page.id);
    await h1.stop({ keepDb: true });
    const h2 = await H.boot({ db: shared, env: { WIKI_GATE_MIN_WORDS: '80' } });
    const ev = (await H.outbox(h2)).filter((e) => e.subject.id === page.id && e.event_type.startsWith('wiki.index_document.')).pop();
    assert.strictEqual(ev.event_type, 'wiki.index_document.deleted');
    assert.ok(ev.subject.revision > old);
    const n = (await H.outbox(h2)).length;
    await h2.stop({ keepDb: true });
    const h3 = await H.boot({ db: shared, env: { WIKI_GATE_MIN_WORDS: '80' } });
    assert.strictEqual((await H.outbox(h3)).length, n, 'a second boot sends nothing');
    await h3.stop();
    await h1.closeDb();
    console.log('reconcile ok');
})().catch((err) => { console.error(err); process.exit(1); });
