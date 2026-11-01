'use strict';
/**
 * An article's [[links]] are resolved before it renders (server/wiki/service.js renderRevision): every distinct target
 * once, together, so a well-linked page does not wait on one database round trip per link. The page still links every
 * page that exists, whatever the case or spelling, and still names a page that does not.
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    const h = await H.boot();
    const me = { kind: 'user', subject: H.subject() };
    try {
        const space = await h.svc.createSpace({ name: 'Links', slug: 'links' }, me);
        const make = async (title, body) => {
            const { page } = await h.svc.createPage(space.id, {
                title, body: `${body} ${H.LONG}`, summary: `${title} in one line.`,
                citations: [{ url: 'https://example.org/', title: 'Example', retrievedAt: '2026-10-01' }],
            }, me);
            await h.svc.publish(page.id, {}, me);
            return page;
        };
        const beta = await make('Beta', 'Beta page.');
        const gamma = await make('Gamma', 'Gamma page.');
        await make('Alpha', 'Alpha links to [[Beta]], [[gamma]] and [[Missing page]].');

        const r = await H.req(h, 'GET', '/w/links/alpha');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes(`href="/w/links/${beta.slug}"`), 'the link to Beta resolved');
        assert.ok(r.text.includes(`href="/w/links/${gamma.slug}"`), 'the lower-case link to Gamma resolved to the same page');
        assert.ok(r.text.includes('Missing page'), 'a page that does not exist is still named');
        console.log('article links ok');
    } finally {
        await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
