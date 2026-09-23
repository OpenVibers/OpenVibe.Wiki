'use strict';
/**
 * Space import (POST /api/v1/spaces/:space/import and the /s/:space/import form): an owner imports a
 * JSON bundle of pages in one transaction. Pages are created exactly like hand-made ones (drafts by
 * default, imported authorship with the importer accountable, links, citations, events, escaping);
 * only owners import; oversized, malformed, unknown-field, duplicate-slug and colliding bundles are
 * refused; any failure imports nothing at all.
 */
const assert = require('assert');
const H = require('./helpers');

const count = (h, table) => h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

(async () => {
    const h = await H.boot();
    const owner = H.subject();
    const editor = H.subject();
    const tokOwner = H.userToken({ subject: owner });
    const tokEditor = H.userToken({ subject: editor });
    const imp = (token, body, space = 'bakery') => H.req(h, 'POST', `/api/v1/spaces/${space}/import`, { token, body });
    const bundle = {
        source: 'the old bakery wiki',
        pages: [
            { title: 'Rye', parent: 'Bread', body: `Rye is dense. Back to [[Bread]]. [click](javascript:alert(1)) <script>alert(1)</script> ${H.LONG}`, summary: 'Dense bread.', infobox: [{ label: 'Gluten', type: 'text', value: 'low' }], citations: [{ url: 'https://flour.example/rye', title: 'Rye flour', retrievedAt: '2026-09-01' }] },
            { title: 'Bread', body: `All about bread; see [[Rye]] and [[Spelt]]. ${H.LONG}` },
            { title: 'Private notes', body: 'Only for us.', visibility: 'private' },
        ],
    };
    try {
        let r = await H.req(h, 'POST', '/api/v1/spaces', { token: tokOwner, body: { name: 'Bakery', slug: 'bakery' } });
        assert.strictEqual(r.status, 201);
        await H.req(h, 'PUT', `/api/v1/spaces/bakery/roles/${editor}`, { token: tokOwner, body: { role: 'editor' } });
        await H.req(h, 'POST', '/api/v1/spaces', { token: tokEditor, body: { name: 'Secret', slug: 'secret', visibility: 'private' } });

        // Only an owner, acting as a person, imports.
        const pagesBefore = count(h, 'wiki_pages');
        r = await imp(tokEditor, bundle);
        assert.strictEqual(r.status, 403, 'an editor is not an owner');
        assert.strictEqual(r.json.code, 'import.forbidden');
        assert.strictEqual((await imp(null, bundle)).status, 403, 'anonymous');
        assert.strictEqual((await imp(tokOwner, bundle, 'secret')).status, 404, 'a private space someone else owns is not found');
        r = await imp(H.serviceToken({ client: 'ai', cap: ['wiki.page.create'] }), bundle);
        assert.strictEqual(r.status, 403, 'a service acting as itself is no owner');
        r = await imp(H.serviceToken({ client: 'ai', cap: ['wiki.page.read'] }), bundle);
        assert.strictEqual(r.status, 403, 'the route needs wiki.page.create');
        assert.strictEqual(count(h, 'wiki_pages'), pagesBefore);

        // Invalid and oversized bundles are refused before anything is written.
        const refusals = [
            [{ pages: [] }, 422, 'import.invalid'],
            [{ pages: 'x' }, 422, 'import.invalid'],
            [{ pages: [{ title: 'A', body: 'x', colour: 'red' }] }, 422, 'import.unknown_field'],
            [{ pages: [{ title: 'A', body: 'x' }], overwrite: true }, 422, 'import.unknown_field'],
            [{ pages: [{ body: 'no title' }] }, 422, 'import.invalid'],
            [{ pages: [{ title: 'A', body: 42 }] }, 422, 'import.invalid'],
            [{ pages: [{ title: 'A', body: 'x', visibility: 'world' }] }, 422, 'import.invalid'],
            [{ pages: [{ title: 'A', body: 'x' }], publish: 'yes' }, 422, 'import.invalid'],
            [{ pages: [{ title: 'A', body: 'x' }], on_existing: 'overwrite' }, 422, 'import.invalid'],
            [{ pages: [{ title: 'Rye bread', body: 'x' }, { title: 'rye  BREAD', body: 'y' }] }, 422, 'import.duplicate_slug'],
            [{ pages: Array.from({ length: 201 }, (_x, i) => ({ title: `P${i}`, body: 'x' })) }, 422, 'import.too_many_pages'],
            [{ pages: [{ title: 'Big', body: 'x'.repeat(200001) }] }, 413, 'import.page_too_large'],
            [{ pages: [{ title: 'A', body: 'x', summary: 's'.repeat(301) }] }, 422, 'import.invalid'],
        ];
        for (const [body, status, code] of refusals) {
            r = await imp(tokOwner, body);
            assert.strictEqual(r.status, status, `${JSON.stringify(body).slice(0, 80)} → ${r.text.slice(0, 200)}`);
            assert.strictEqual(r.json.code, code, JSON.stringify(body).slice(0, 80));
        }
        r = await H.req(h, 'POST', '/api/v1/spaces/bakery/import', { token: tokOwner, headers: { 'Content-Type': 'application/json' } });
        assert.strictEqual(r.status, 422, 'no body');
        r = await fetch(`${h.base}/api/v1/spaces/bakery/import`, { method: 'POST', headers: { Authorization: `Bearer ${tokOwner}`, 'Content-Type': 'application/json' }, body: '{"pages": [' });
        assert.strictEqual(r.status, 400, 'malformed JSON');
        r = await imp(tokOwner, { pages: Array.from({ length: 150 }, (_x, i) => ({ title: `Page ${i}`, body: 'y'.repeat(15000) })) });
        assert.strictEqual(r.status, 413, 'a bundle over 2 MB');
        assert.strictEqual(r.json.code, 'request.too_large');
        assert.strictEqual(count(h, 'wiki_pages'), pagesBefore, 'nothing was written by a refused bundle');

        // Atomicity: the third page is invalid (an infobox value that is not a number; a parent that
        // is nowhere) → none of the pages, revisions, citations or events exist afterwards.
        const snapshot = () => ['wiki_pages', 'wiki_page_revisions', 'wiki_citations', 'wiki_page_links', 'wiki_event_outbox', 'wiki_watchers'].map((t) => count(h, t));
        const before = snapshot();
        for (const broken of [
            { pages: [...bundle.pages.slice(0, 2), { title: 'Spelt', body: 'x', infobox: [{ label: 'Weight', type: 'number', value: 'heavy' }] }] },
            { pages: [...bundle.pages.slice(0, 2), { title: 'Spelt', body: 'x', parent: 'Nowhere' }] },
            { pages: [...bundle.pages.slice(0, 2), { title: 'Spelt', body: 'x', citations: [{ url: 'ftp://files.example/spelt' }] }] },
            { pages: [{ title: 'Egg', parent: 'Hen', body: 'x' }, { title: 'Hen', parent: 'Egg', body: 'y' }] },
        ]) {
            r = await imp(tokOwner, broken);
            assert.ok(r.status === 422, `${r.status} ${r.text.slice(0, 200)}`);
            assert.deepStrictEqual(snapshot(), before, `all or nothing: ${r.json.code}`);
        }

        // Success: drafts, attributed to the importer, links and citations recorded, events emitted.
        r = await imp(tokOwner, bundle);
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(r.json.created.map((p) => [p.slug, p.state, p.revision]), [['bread', 'draft', 1], ['private-notes', 'draft', 1], ['rye', 'draft', 1]], 'parents first');
        assert.strictEqual(r.json.published, false);
        const space = h.svc.findSpace('bakery');
        const rye = h.svc.findPage(space.id, 'rye');
        const bread = h.svc.findPage(space.id, 'bread');
        assert.strictEqual(rye.parent_id, bread.id, 'the parent came from the bundle');
        assert.strictEqual(h.svc.findPage(space.id, 'private-notes').visibility, 'private');
        const rev = h.stores.revisions.get(rye.id, 1);
        assert.strictEqual(rev.author, owner);
        assert.deepStrictEqual(rev.meta.authorship, { mode: 'imported', authors: [owner], importedFrom: { label: 'the old bakery wiki', originalAuthor: null } });
        assert.strictEqual(h.svc.citationsOf(rye, 1)[0].url, 'https://flour.example/rye');
        assert.ok(h.db.prepare('SELECT 1 FROM wiki_page_links WHERE from_page_id = ? AND target_slug = ?').get(bread.id, 'spelt'), 'links recorded (red link to Spelt)');
        const created = H.outbox(h).filter((e) => e.event_type === 'wiki.revision.created' && [rye.id, bread.id].includes(e.subject.id));
        assert.strictEqual(created.length, 2);
        assert.ok(h.db.prepare('SELECT 1 FROM wiki_watchers WHERE page_id = ? AND subject = ?').get(rye.id, owner), 'the importer watches the pages');
        // Drafts: invisible to readers, visible to editors; the markdown is rendered by the usual sanitiser.
        assert.strictEqual((await H.req(h, 'GET', '/w/bakery/rye')).status, 404);
        r = await H.req(h, 'GET', '/w/bakery/rye', { cookie: H.cookieFor(tokEditor) });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Imported from the old bakery wiki'));
        assert.ok(!/<script>alert|href="javascript/.test(r.text), 'escaped, no javascript: link');
        assert.ok(!r.text.includes('<a class="ov-wikilink" href="/w/bakery/bread">'), 'links go through the usual resolver: a draft target is not a blue link');

        // Existing pages: "fail" imports nothing, "skip" leaves them alone and imports the rest.
        const again = { pages: [{ title: 'Rye', body: 'replaced?' }, { title: 'Spelt', body: `Spelt is old. ${H.LONG}`, parent: 'Bread', citations: [{ url: 'https://spelt.example/', retrievedAt: '2026-09-03' }] }] };
        r = await imp(tokOwner, again);
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.code, 'import.pages_exist');
        assert.strictEqual(h.svc.findPage(space.id, 'spelt'), null);
        r = await imp(tokOwner, { ...again, on_existing: 'skip', publish: true });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(r.json.skipped, [{ slug: 'rye', title: 'Rye', reason: 'exists' }]);
        assert.deepStrictEqual(r.json.created.map((p) => [p.slug, p.state]), [['spelt', 'published']]);
        assert.strictEqual(h.stores.revisions.headNumber(rye.id), 1, 'the existing page was left alone');
        // Published through the import: readable, indexed like any page (upsert event).
        assert.strictEqual((await H.req(h, 'GET', '/w/bakery/spelt')).status, 200);
        const spelt = h.svc.findPage(space.id, 'spelt');
        assert.strictEqual(spelt.parent_id, bread.id, 'a parent that already exists in the space');
        assert.ok(H.outbox(h).some((e) => e.event_type === 'wiki.page.published' && e.subject.id === spelt.id));
        assert.ok(H.outbox(h).some((e) => e.event_type === 'wiki.index_document.upserted' && e.subject.id === spelt.id));

        // AI-assisted bundles stay noindex until a person reviews each page.
        r = await imp(tokOwner, { ai_assisted: true, publish: true, source: 'a model', pages: [{ title: 'Barley', body: `Barley bread. ${H.LONG}`, citations: [{ url: 'https://barley.example/', retrievedAt: '2026-09-04' }] }] });
        assert.strictEqual(r.status, 201);
        r = await H.req(h, 'GET', '/w/bakery/barley');
        assert.ok(r.text.includes('<meta name="robots" content="noindex, nofollow">'));
        assert.ok(r.text.includes('Not yet reviewed by a person.'));

        // The form (no JavaScript): owners only, same validation, same all-or-nothing.
        const cookie = H.cookieFor(tokOwner);
        assert.strictEqual((await H.req(h, 'GET', '/s/bakery/import', { cookie: H.cookieFor(tokEditor) })).status, 403);
        assert.strictEqual((await H.req(h, 'GET', '/s/bakery/import')).status, 401);
        r = await H.req(h, 'GET', '/s/bakery/import', { cookie });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('name="bundle"') && r.text.includes('action="/s/bakery/import"'));
        assert.ok((await H.req(h, 'GET', '/s/bakery', { cookie })).text.includes('href="/s/bakery/import"'), 'linked from the space page for owners');
        r = await H.req(h, 'POST', '/s/bakery/import', { cookie, form: { bundle: '{"pages": [', on_existing: 'fail' } });
        assert.strictEqual(r.status, 400);
        assert.ok(r.text.includes('The bundle is not valid JSON') && r.text.includes('Nothing was imported.'));
        r = await H.req(h, 'POST', '/s/bakery/import', { cookie, form: { bundle: JSON.stringify([{ title: 'Oats', body: `Oat bread. ${H.LONG}` }]), on_existing: 'fail', publish: '1', source: 'my notes' } });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(r.text.includes('Imported 1 page(s) and published them.') && r.text.includes('href="/w/bakery/oats"'));
        assert.strictEqual((await H.req(h, 'GET', '/w/bakery/oats')).status, 200);
        r = await H.req(h, 'POST', '/s/bakery/import', { cookie: H.cookieFor(tokEditor), form: { bundle: JSON.stringify([{ title: 'Nope', body: 'x' }]) } });
        assert.strictEqual(r.status, 403);
        r = await H.req(h, 'POST', '/s/bakery/import', { cookie, headers: { Origin: 'https://evil.example' }, form: { bundle: JSON.stringify([{ title: 'Csrf', body: 'x' }]) } });
        assert.strictEqual(r.status, 403, 'cross-site form posts are refused');
        assert.strictEqual(h.svc.findPage(space.id, 'nope'), null);
        assert.strictEqual(h.svc.findPage(space.id, 'csrf'), null);
        console.log('import ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
