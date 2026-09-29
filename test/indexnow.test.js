'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route,
 * nothing sent). With a key the key file is served at /<key>.txt as text/plain, and a publish,
 * unpublish or delete of an indexable page pings the engines with the page's path and the sitemap.
 * Drafts, noindex pages and pages the gate will not index never ping.
 */
const assert = require('assert');
const H = require('./helpers');

const KEY = 'k'.repeat(32);
const BASE = 'https://openvibe.wiki';
const SITEMAP = `${BASE}/sitemap.xml`;
const PAGE = `${BASE}/w/notes/first-light`;

(async () => {
    // Off: no INDEXNOW_KEY. Nothing is mounted and nothing is sent.
    const off = await H.boot({ env: { BASE_URL: BASE } });
    try {
        assert.strictEqual(off.indexnow.enabled, false, 'IndexNow is off without a key');
        assert.strictEqual((await H.req(off, 'GET', `/${KEY}.txt`)).status, 404, 'no key file is served');
    } finally { await off.stop(); }

    // With a key: the key file is served as text/plain with the key.
    const on = await H.boot({ env: { BASE_URL: BASE, INDEXNOW_KEY: KEY } });
    try {
        assert.strictEqual(on.indexnow.enabled, true, 'IndexNow is on with a key');
        const r = await H.req(on, 'GET', `/${KEY}.txt`);
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(r.text, KEY);
    } finally { await on.stop(); }

    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
        ping: async () => ({ sent: 0, status: 0 }),
        flush: async () => ({ sent: 0, status: 0 }),
    };
    const h = await H.boot({ env: { BASE_URL: BASE }, indexnow: spy });
    const owner = { kind: 'user', subject: H.subject(), staff: false };
    try {
        const space = await h.svc.createSpace({ name: 'Notes', slug: 'notes' }, owner);
        const cite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
        const { page } = await h.svc.createPage(space.id, { title: 'First light', body: H.LONG, citations: cite }, owner);
        assert.deepStrictEqual(pings, [], 'a draft never pings');

        await h.svc.publish(page.id, {}, owner);
        assert.ok(pings.includes(PAGE), `a publish pings the page path: ${JSON.stringify(pings)}`);
        assert.ok(pings.includes(SITEMAP), `a publish pings the sitemap: ${JSON.stringify(pings)}`);

        pings.length = 0;
        await h.svc.unpublish(page.id, owner);
        assert.ok(pings.includes(PAGE), `an unpublish pings the page path: ${JSON.stringify(pings)}`);
        assert.ok(pings.includes(SITEMAP), `an unpublish pings the sitemap: ${JSON.stringify(pings)}`);

        await h.svc.publish(page.id, {}, owner);
        pings.length = 0;
        await h.svc.setPageVisibility(page.id, { noindex: true }, owner);
        assert.deepStrictEqual(pings, [], 'a page the owner keeps noindex never pings');
        await h.svc.setPageVisibility(page.id, { noindex: false }, owner);
        assert.ok(pings.includes(PAGE), `indexable again pings: ${JSON.stringify(pings)}`);

        pings.length = 0;
        await h.svc.deletePage(page.id, owner);
        assert.ok(pings.includes(PAGE), `a delete pings the page path: ${JSON.stringify(pings)}`);
        assert.ok(pings.includes(SITEMAP), `a delete pings the sitemap: ${JSON.stringify(pings)}`);

        // A page the gate keeps out of the index (no source: the test policy requires one) never pings.
        pings.length = 0;
        const thin = (await h.svc.createPage(space.id, { title: 'No sources', body: H.LONG }, owner)).page;
        await h.svc.publish(thin.id, {}, owner);
        assert.deepStrictEqual(pings, [], 'a page the gate will not index never pings');
    } finally {
        await h.stop();
    }

    // The real module: a boot with a key batches what the service queued and POSTs it through this
    // process's fetch, with the page's canonical URL and the sitemap (the module drops anything that
    // is not an absolute https URL on its own host).
    const sent = [];
    const outbound = async (url, opts) => {
        if (!String(url).includes('api.indexnow.org')) throw new Error(`unexpected outbound fetch ${url}`);
        sent.push(JSON.parse(opts.body));
        return { status: 200 };
    };
    const m = await H.boot({ env: { BASE_URL: BASE, INDEXNOW_KEY: KEY }, fetch: outbound });
    const mOwner = { kind: 'user', subject: H.subject(), staff: false };
    try {
        const mSpace = await m.svc.createSpace({ name: 'Notes', slug: 'notes' }, mOwner);
        const mCite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
        const mPage = (await m.svc.createPage(mSpace.id, { title: 'First light', body: H.LONG, citations: mCite }, mOwner)).page;
        await m.svc.publish(mPage.id, {}, mOwner);
        assert.deepStrictEqual(sent, [], 'nothing is sent before the batch is flushed');
        const out = await m.indexnow.flush();
        assert.deepStrictEqual(sent.length, 1, 'one POST for the batch');
        assert.strictEqual(sent[0].host, 'openvibe.wiki');
        assert.strictEqual(sent[0].key, KEY);
        assert.deepStrictEqual(sent[0].urlList.slice().sort(), [PAGE, SITEMAP].sort(), JSON.stringify(sent[0].urlList));
        assert.strictEqual(out.sent, 2, JSON.stringify(out));
    } finally {
        await m.stop();
    }
    console.log('indexnow ok');
})().catch((err) => { console.error(err); process.exit(1); });
