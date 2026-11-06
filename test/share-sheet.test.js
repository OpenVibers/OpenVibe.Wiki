'use strict';
/**
 * A wiki article carries the network's one Share button (openvibe-shared 4.114.0): one [data-ov-share-sheet] in the
 * page's own actions, with the article's canonical public address, its title and its summary. The navbar loads the
 * sheet on the first press, so the page itself loads nothing more.
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    const h = await H.boot();
    const me = { kind: 'user', subject: H.subject() };
    try {
        const space = await h.svc.createSpace({ name: 'Share demo', slug: 'share-demo' }, me);
        const { page } = await h.svc.createPage(space.id, {
            title: 'A shareable page', body: `The body of the page. ${H.LONG}`, summary: 'One line about the page.',
        }, me);
        await h.svc.publish(page.id, {}, me);
        const r = await H.req(h, 'GET', `/w/share-demo/${page.slug}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual((r.text.match(/data-ov-share-sheet/g) || []).length, 1, 'one Share button');
        assert.ok(r.text.includes('data-url="http://wiki.test/w/share-demo/a-shareable-page"'), 'the article address');
        assert.ok(r.text.includes('data-title="A shareable page"'), 'its title');
        assert.ok(r.text.includes('data-text="One line about the page."'), 'its summary');
        assert.ok(r.text.includes('class="ovk-btn ovk-btn--quiet"') && r.text.includes('<span>Share</span>'), 'the shared kit button');
        console.log('share sheet ok');
    } finally {
        await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
