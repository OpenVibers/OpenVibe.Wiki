'use strict';
/**
 * The citation inspector (/w/:space/:slug/sources) works without JavaScript: a revision's sources
 * with their retrieval times, licenses, where each was first cited and what changed from the
 * previous revision (kept, new, dropped), linked from the article and the history page. It follows
 * the article's read rules exactly: drafts, newer unpublished revisions, members/private pages and
 * deleted pages do not leak through it; renamed pages redirect to it.
 */
const assert = require('assert');
const H = require('./helpers');

const stripScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');

(async () => {
    const h = await H.boot();
    const owner = { kind: 'user', subject: H.subject(), staff: false };
    const cookie = H.cookieFor(H.userToken({ subject: owner.subject }));
    try {
        const space = h.svc.createSpace({ name: 'Bread', slug: 'bread' }, owner);
        const { page } = h.svc.createPage(space.id, {
            title: 'Rye', body: H.LONG,
            citations: [
                { url: 'https://flour.example/rye', title: 'Rye flour', retrievedAt: '2026-09-01T00:00:00Z', licenseNote: 'CC BY 4.0', quote: { text: 'Rye has less gluten.' } },
                { url: 'https://old.example/bread', title: 'Old bread book', retrievedAt: '2026-08-15T00:00:00Z' },
            ],
        }, owner);
        h.svc.publish(page.id, {}, owner);
        const r1 = h.svc.citationsOf(page, 1);
        // Revision 2 keeps the first source, drops the second and adds a third.
        h.svc.editPage(page.id, {
            expectedRevision: 1, body: `${H.LONG} Sourdough helps.`, keepCitations: [r1[0].id],
            citations: [{ url: 'https://sour.example/dough', title: 'Sourdough notes', retrievedAt: '2026-09-10T12:00:00Z' }],
        }, owner);
        h.svc.publish(page.id, {}, owner);
        // Revision 3 is an unpublished draft citing something not public yet.
        h.svc.editPage(page.id, { expectedRevision: 2, body: `${H.LONG} Draft.`, citations: [{ url: 'https://secret.example/draft', title: 'Unpublished source', retrievedAt: '2026-09-20T00:00:00Z' }] }, owner);

        // Linked from the article and the history page.
        let r = await H.req(h, 'GET', '/w/bread/rye');
        assert.ok(r.text.includes('href="/w/bread/rye/sources"'), 'the article links the inspector');
        r = await H.req(h, 'GET', '/w/bread/rye/history');
        assert.ok(r.text.includes('href="/w/bread/rye/sources?rev=1"'), 'each history row links its sources');
        r = await H.req(h, 'GET', '/w/bread/rye?rev=1');
        assert.ok(r.text.includes('href="/w/bread/rye/sources?rev=1"'), 'an older revision links its own sources');

        // The published revision by default, readable without scripts.
        r = await H.req(h, 'GET', '/w/bread/rye/sources');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
        assert.ok(r.text.includes('<meta name="robots" content="noindex, follow">'));
        let page2 = stripScripts(r.text);
        assert.ok(page2.includes('<h1>Sources of Rye, revision 2</h1>'));
        assert.ok(page2.includes('This is the published revision.'));
        assert.ok(page2.includes('href="https://flour.example/rye" rel="noopener nofollow">Rye flour</a>'));
        assert.ok(page2.includes('<time datetime="2026-09-01T00:00:00.000Z">'), 'retrieval time of the kept source');
        assert.ok(page2.includes('<time datetime="2026-09-10T12:00:00.000Z">'), 'retrieval time of the new source');
        assert.ok(page2.includes('CC BY 4.0') && page2.includes('Rye has less gluten.'));
        assert.ok(page2.includes('kept from revision 1') && page2.includes('new in this revision'));
        assert.ok(page2.includes('href="/w/bread/rye/sources?rev=1">revision 1</a>'), 'the kept source was first cited in revision 1');
        assert.ok(/Dropped since revision 1<\/h2><ul><li><a href="https:\/\/old\.example\/bread"/.test(page2), 'the dropped source is listed');
        assert.ok(!page2.includes('secret.example') && !page2.includes('Revision 3'), 'a newer draft does not leak');
        // Any older revision a reader may see.
        r = await H.req(h, 'GET', '/w/bread/rye/sources?rev=1');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Sources of Rye, revision 1') && r.text.includes('old.example/bread') && r.text.includes('This is not the published revision'));
        for (const bad of ['?rev=3', '?rev=99', '?rev=x']) assert.strictEqual((await H.req(h, 'GET', `/w/bread/rye/sources${bad}`)).status, 404, bad);
        // Editors see the draft's sources, privately.
        r = await H.req(h, 'GET', '/w/bread/rye/sources?rev=3', { cookie });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.ok(r.text.includes('secret.example/draft'));

        // A renamed page redirects to its inspector.
        h.svc.movePage(page.id, { slug: 'rye-bread' }, owner);
        r = await H.req(h, 'GET', '/w/bread/rye/sources?rev=1');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.get('location'), '/w/bread/rye-bread/sources?rev=1');

        // Same read rules as the article: private pages, members spaces, drafts and deleted pages.
        h.svc.setPageVisibility(page.id, { visibility: 'private' }, owner);
        r = await H.req(h, 'GET', '/w/bread/rye-bread/sources');
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.ok(!r.text.includes('flour.example'));
        assert.strictEqual((await H.req(h, 'GET', '/w/bread/rye-bread/sources', { cookie })).status, 200, 'the owner still inspects it');
        h.svc.setPageVisibility(page.id, { visibility: 'public' }, owner);
        h.svc.updateSpace(space.id, { visibility: 'members' }, owner);
        assert.strictEqual((await H.req(h, 'GET', '/w/bread/rye-bread/sources')).status, 404, 'anonymous: members space');
        r = await H.req(h, 'GET', '/w/bread/rye-bread/sources', { cookie: H.cookieFor(H.userToken()) });
        assert.strictEqual(r.status, 200, 'any signed-in account reads a members space');
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        h.svc.updateSpace(space.id, { visibility: 'public' }, owner);
        const draft = h.svc.createPage(space.id, { title: 'Spelt', body: H.LONG, citations: [{ url: 'https://spelt.example/', retrievedAt: '2026-09-02' }] }, owner).page;
        assert.strictEqual((await H.req(h, 'GET', '/w/bread/spelt/sources')).status, 404, 'a draft page');
        h.svc.deletePage(draft.id, owner);
        assert.strictEqual((await H.req(h, 'GET', '/w/bread/spelt/sources')).status, 410);
        console.log('citation inspector ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
