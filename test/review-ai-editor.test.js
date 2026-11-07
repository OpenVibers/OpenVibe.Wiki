'use strict';
/**
 * The AI editor (plan 2026-10-22 §"The editorial queue"): a second reviewer kind, `ai_editor`,
 * recorded on the review by the orchestrator's service principal. Its approval publishes and
 * indexes AI-written text exactly as a person's approval does, but the page says
 * "Checked by OpenVibe's AI editor" (with the date) — never "Reviewed by a person". A person's
 * review path and label do not change, and a page can show both.
 *
 * Only a service token whose principal holds wiki.review.ai_editor may record one; a token
 * without it is refused and writes nothing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { seed, SYSTEM } = require('../server/wiki/seed');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'openvibe.json'), 'utf8'));
const AI_LABEL = "Checked by OpenVibe's AI editor";

(async () => {
    const h = await H.boot({ env: { WIKI_GATE_MIN_WORDS: '80' } });
    const staff = H.subject(), editor = H.subject();
    const tok = (sub, role = 'user') => H.userToken({ subject: sub, role });
    const aiEditor = H.serviceToken({ client: 'orchestrator', sub: 'svc:orchestrator', cap: ['wiki.review.ai_editor'] });
    try {
        await seed(h.svc, data, { log: H.quiet });
        const space = await h.svc.findSpace('openvibe');
        await h.svc.setRole(space.id, editor, 'editor', { kind: 'user', subject: staff, staff: true });

        const page = await h.svc.findPage(space.id, 'openvibe-search');
        const n = page.published_revision;
        const url = `/api/v1/pages/${page.id}/revisions/${n}/review`;

        // Refused: a service token without the capability writes nothing; a person-shaped service
        // (X-OV-Subject) is judged as that person, not as the AI editor.
        let r = await H.req(h, 'POST', url, { token: H.serviceToken({ client: 'orchestrator', sub: 'svc:orchestrator', cap: ['wiki.revision.publish'] }), body: { decision: 'approved' } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'capability.denied');
        assert.strictEqual((await h.stores.reviews.history(page.id)).length, 0, 'nothing was recorded');

        // The AI editor approves: the page publishes (it already was) and becomes indexable, labelled as checked.
        r = await H.req(h, 'POST', url, { token: aiEditor, body: { decision: 'approved', note: 'Checked against the sources' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual([r.json.review.reviewerKind, r.json.review.reviewer, r.json.review.decision], ['ai_editor', 'svc:orchestrator', 'approved']);
        assert.strictEqual(r.json.indexable, true);
        assert.deepStrictEqual(r.json.reasons, []);
        let revs = await h.stores.reviews.history(page.id);
        assert.deepStrictEqual([revs[0].reviewerKind, revs[0].reviewer, revs[0].note], ['ai_editor', 'svc:orchestrator', 'Checked against the sources']);

        let html = await H.req(h, 'GET', '/w/openvibe/openvibe-search');
        assert.ok(html.text.includes('<meta name="robots" content="index, follow">'), 'the AI editor\'s approval indexes the page');
        assert.ok(html.text.includes(AI_LABEL), 'the page says who checked it');
        assert.ok(html.text.includes('wk-review--ai'), 'in its own badge');
        assert.ok(!html.text.includes('Reviewed by a person'), 'never as a person\'s review');
        assert.ok(!html.text.includes('Not yet reviewed by a person'), 'and not as unreviewed');
        assert.ok((await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('openvibe-search'));

        // The JSON twin carries the same label and the review kinds.
        const json = await H.req(h, 'GET', '/w/openvibe/openvibe-search.json');
        assert.strictEqual(json.status, 200, json.text);
        assert.strictEqual(json.json.authorship.reviewed, true);
        assert.ok(json.json.authorship.labels.some((l) => l.startsWith(AI_LABEL)), JSON.stringify(json.json.authorship));
        assert.deepStrictEqual([json.json.authorship.reviews.ai_editor.decision, json.json.authorship.reviews.person], ['approved', null]);

        // A person reviews the same page after the AI editor: both labels show, the person's path unchanged.
        r = await H.req(h, 'POST', url, { token: tok(editor), body: { decision: 'approved', note: 'I checked it too' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.review.reviewerKind, 'person');
        html = await H.req(h, 'GET', '/w/openvibe/openvibe-search');
        assert.ok(html.text.includes('Reviewed by a person'), 'the person\'s label is unchanged');
        assert.ok(html.text.includes(AI_LABEL), 'and both are shown');
        assert.ok(html.text.indexOf('Reviewed by a person') < html.text.indexOf(AI_LABEL) || html.text.includes('wk-review--ai'), 'both badges are in the markup');

        // A rejection by the AI editor keeps a page hidden and stays in the staff queue, which names the kind.
        const other = await h.svc.findPage(space.id, 'openvibe-network');
        const otherUrl = `/api/v1/pages/${other.id}/revisions/${other.published_revision}/review`;
        r = await H.req(h, 'POST', otherUrl, { token: aiEditor, body: { decision: 'rejected', note: 'Numbers out of date' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.indexable, false);
        const staffTok = tok(staff, 'admin');
        const q = await H.req(h, 'GET', '/api/v1/review-queue', { token: staffTok });
        const item = q.json.items.find((i) => i.id === other.id);
        assert.ok(item, 'the AI editor\'s rejection leaves the page in the person\'s queue');
        assert.deepStrictEqual([item.reviewed.kind, item.reviewed.decision, item.reviewed.by], ['ai_editor', 'rejected', 'svc:orchestrator']);
        assert.ok(item.reviewed.label.startsWith('Kept hidden by OpenVibe\'s AI editor'), item.reviewed.label);

        // A person's rejection clears it, as before.
        r = await H.req(h, 'POST', otherUrl, { token: tok(editor), body: { decision: 'rejected' } });
        assert.strictEqual(r.status, 201, r.text);
        const after = await H.req(h, 'GET', '/api/v1/review-queue', { token: staffTok });
        assert.ok(!after.json.items.some((i) => i.id === other.id), 'a person\'s decision clears the queue');

        // The AI editor cannot publish a page never reviewed... and a person still can (unchanged path).
        const legacy = await h.svc.createPage(space.id, {
            title: 'Legacy import', body: data.pages[1].body,
            authorship: { mode: 'imported', importedFrom: { label: 'the READMEs, summarised with AI assistance', originalAuthor: 'OpenVibers' } },
        }, SYSTEM);
        await h.svc.publish(legacy.page.id, {}, SYSTEM);
        assert.strictEqual((await H.req(h, 'GET', '/w/openvibe/legacy-import')).text.includes(AI_LABEL), false);
        await h.svc.reviewRevision(space.id, 'legacy-import', 1, { decision: 'approved' }, { kind: 'user', subject: editor });
        const legacyHtml = await H.req(h, 'GET', '/w/openvibe/legacy-import');
        assert.ok(legacyHtml.text.includes('Reviewed by a person'));
        assert.ok(!legacyHtml.text.includes(AI_LABEL));
        // A plain AI-generated page (not an import) is gated the same way: the AI editor's approval
        // is what lets it publish, and the page names the AI editor.
        const gen = await h.svc.createPage(space.id, {
            title: 'Generated page', body: `${data.pages[2].body} ${'more words '.repeat(30)}`,
            authorship: { mode: 'ai', workflow: { id: 'wiki.generate_page', runId: 'run_ai_1' } },
        }, SYSTEM);
        const aiActor = { kind: 'service', service: 'svc:orchestrator', subject: null, claims: { cap: ['wiki.review.ai_editor'] } };
        await assert.rejects(async () => await h.svc.publish(gen.page.id, {}, SYSTEM), (e) => e.code === 'ai_generated_unreviewed');
        await h.svc.reviewRevision(space.id, 'generated-page', 1, { decision: 'approved' }, aiActor);
        await h.svc.publish(gen.page.id, {}, SYSTEM);
        const genHtml = await H.req(h, 'GET', '/w/openvibe/generated-page');
        assert.ok(genHtml.text.includes(AI_LABEL), 'an AI-generated page carries the AI editor label');
        assert.ok(!genHtml.text.includes('Reviewed by a person'));

        console.log('ai editor ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
