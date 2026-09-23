'use strict';
/**
 * A private, members-only or deleted page leaves sitemaps, feeds and the Search index (tombstone
 * event) and is never publicly cacheable; renames answer 301 from every old address, deletions 410.
 * Every event is a valid events.event-envelope@1 and every Search document a valid
 * search.index-document@1 (openvibe-contracts).
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const H = require('./helpers');

function lastIndexEvent(h, pageId) {
    return H.outbox(h).filter((e) => e.event_type.startsWith('wiki.index_document.') && e.subject.id === pageId).pop();
}

(async () => {
    const h = await H.boot();
    const owner = { kind: 'user', subject: H.subject(), staff: false };
    try {
        const space = h.svc.createSpace({ name: 'Notes', slug: 'notes' }, owner);
        const cite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
        const { page } = h.svc.createPage(space.id, { title: 'Open page', body: H.LONG, citations: cite }, owner);
        const other = h.svc.createPage(space.id, { title: 'Second page', body: H.LONG, citations: cite }, owner).page;

        // Draft: not in sitemap, feed or index; direct URL is 404 for anonymous visitors.
        let r = await H.req(h, 'GET', '/sitemaps/pages-1.xml');
        assert.ok(!r.text.includes('/w/notes/open-page'));
        assert.strictEqual((await H.req(h, 'GET', '/w/notes/open-page')).status, 404);
        assert.strictEqual(lastIndexEvent(h, page.id), undefined, 'a draft never reaches Search');

        // Published: sitemap, feeds, index upsert, public cache.
        h.svc.publish(page.id, {}, owner);
        h.svc.publish(other.id, {}, owner);
        r = await H.req(h, 'GET', '/sitemaps/pages-1.xml');
        assert.ok(r.text.includes('http://wiki.test/w/notes/open-page'));
        assert.ok((await H.req(h, 'GET', '/feed.atom')).text.includes('http://wiki.test/w/notes/open-page'));
        assert.ok((await H.req(h, 'GET', '/feed.json')).json.items.some((i) => i.url === 'http://wiki.test/w/notes/open-page'));
        let ev = lastIndexEvent(h, page.id);
        assert.strictEqual(ev.event_type, 'wiki.index_document.upserted');
        assert.strictEqual(ev.payload.visibility, 'public');
        assert.strictEqual(ev.payload.indexability.decision, 'index');
        r = await H.req(h, 'GET', '/w/notes/open-page');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
        assert.ok(r.text.includes('<meta name="robots" content="index, follow">'));
        // A signed-in view is personalised: never publicly cacheable.
        r = await H.req(h, 'GET', '/w/notes/open-page', { cookie: H.cookieFor(H.userToken({ subject: owner.subject })) });
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');

        // Private page: leaves sitemap, feeds and Search (tombstone at a higher revision), 404 + private for anonymous.
        const before = lastIndexEvent(h, page.id).payload.revision;
        h.svc.setPageVisibility(page.id, { visibility: 'private' }, owner);
        ev = lastIndexEvent(h, page.id);
        assert.strictEqual(ev.event_type, 'wiki.index_document.deleted');
        assert.ok(ev.payload.revision > before, 'the tombstone outranks the last document');
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('open-page'));
        assert.ok(!(await H.req(h, 'GET', '/feed.atom')).text.includes('open-page'));
        assert.ok(!(await H.req(h, 'GET', '/feed.json')).text.includes('open-page'));
        assert.ok(!(await H.req(h, 'GET', '/llms.txt')).text.includes('open-page'));
        r = await H.req(h, 'GET', '/w/notes/open-page');
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        r = await H.req(h, 'GET', '/w/notes/open-page.json');
        assert.strictEqual(r.status, 404);
        // The owner still reads it, privately.
        r = await H.req(h, 'GET', '/w/notes/open-page', { cookie: H.cookieFor(H.userToken({ subject: owner.subject })) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.ok(r.text.includes('noindex'));
        // Search (the wiki's own) does not return it to anonymous callers.
        assert.ok(!(await H.req(h, 'GET', '/api/v1/search?q=Open')).json.results.some((x) => x.id === page.id));
        // The product event for a non-public change is internal.
        const upd = H.outbox(h).filter((e) => e.event_type === 'wiki.page.updated' && e.subject.id === page.id).pop();
        assert.strictEqual(upd.visibility, 'internal');

        // Space goes members-only: its public pages leave the index too.
        h.svc.updateSpace(space.id, { visibility: 'members' }, owner);
        assert.strictEqual(lastIndexEvent(h, other.id).event_type, 'wiki.index_document.deleted');
        assert.strictEqual((await H.req(h, 'GET', '/w/notes/second-page')).status, 404, 'anonymous cannot read a members page');
        r = await H.req(h, 'GET', '/w/notes/second-page', { cookie: H.cookieFor(H.userToken()) });
        assert.strictEqual(r.status, 200, 'any signed-in account reads a members page');
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/spaces.xml')).text.includes('/s/notes'));
        h.svc.updateSpace(space.id, { visibility: 'public' }, owner);
        assert.strictEqual(lastIndexEvent(h, other.id).event_type, 'wiki.index_document.upserted', 'back in the index when public again');

        // Rename: every old address 301s to the current one (chains collapse).
        h.svc.movePage(other.id, { slug: 'second' }, owner);
        h.svc.movePage(other.id, { slug: 'third' }, owner);
        r = await H.req(h, 'GET', '/w/notes/second-page/history');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.get('location'), '/w/notes/third/history');
        r = await H.req(h, 'GET', '/w/notes/second');
        assert.strictEqual(r.headers.get('location'), '/w/notes/third');
        ev = lastIndexEvent(h, other.id);
        assert.strictEqual(ev.payload.canonical_url, 'http://wiki.test/w/notes/third');
        // A renamed space redirects its pages as well.
        h.svc.updateSpace(space.id, { slug: 'jottings' }, owner);
        r = await H.req(h, 'GET', '/w/notes/third');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.get('location'), '/w/jottings/third');
        assert.strictEqual((await H.req(h, 'GET', '/s/notes')).headers.get('location'), '/s/jottings');

        // Delete: 410 at the current and the old addresses, tombstone, gone from sitemap.
        h.svc.deletePage(other.id, owner);
        assert.strictEqual((await H.req(h, 'GET', '/w/jottings/third')).status, 410);
        assert.strictEqual((await H.req(h, 'GET', '/w/notes/second-page')).status, 410);
        assert.strictEqual(lastIndexEvent(h, other.id).event_type, 'wiki.index_document.deleted');
        assert.ok(H.outbox(h).some((e) => e.event_type === 'wiki.page.deleted' && e.subject.id === other.id));
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('third'));

        // Contracts: every envelope and every Search document validates.
        const all = H.outbox(h);
        for (const env of all) {
            const v = contracts.validate('events.event-envelope@1', env);
            assert.ok(v.valid, `${env.event_type}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(env.source, 'wiki');
            assert.ok(env.event_type.startsWith('wiki.'));
            if (env.event_type === 'wiki.index_document.upserted') {
                const d = contracts.validate('search.index-document@1', env.payload);
                assert.ok(d.valid, JSON.stringify(d.errors));
            }
        }
        const types = new Set(all.map((e) => e.event_type));
        for (const t of ['wiki.space.updated', 'wiki.revision.created', 'wiki.page.published', 'wiki.page.updated', 'wiki.page.deleted', 'wiki.index_document.upserted', 'wiki.index_document.deleted']) assert.ok(types.has(t), `emits ${t}`);
        // Index revisions only grow per page.
        for (const id of [page.id, other.id]) {
            const revs = all.filter((e) => e.event_type.startsWith('wiki.index_document.') && e.subject.id === id).map((e) => e.subject.revision);
            assert.deepStrictEqual(revs, [...revs].sort((a, b) => a - b));
            assert.strictEqual(new Set(revs).size, revs.length);
        }

        // robots.txt names the sitemap and states the automated-consumer policy.
        r = await H.req(h, 'GET', '/robots.txt');
        assert.ok(r.text.includes('Sitemap: http://wiki.test/sitemap.xml'));
        assert.ok(r.text.includes('Disallow: /api/'));
        console.log('visibility ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
