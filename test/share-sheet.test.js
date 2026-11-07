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
        // The Ask your agent chip (openvibe-shared 4.135.0): beside Share, the article's title and public address in its text.
        const asks = r.text.match(/<button[^>]*data-ov-ask[^>]*>/g) || [];
        assert.strictEqual(asks.length, 1, 'one Ask your agent chip');
        assert.ok(asks[0].includes('data-ov-ask="About the wiki page “A shareable page” (http://wiki.test/w/share-demo/a-shareable-page): "'), asks[0]);
        assert.ok(asks[0].includes('class="ovk-ask ovk-btn'), 'the shared kit chip');

        // Everything in that text goes through kit.askAgent's escaping, title included.
        const { page: nasty } = await h.svc.createPage(space.id, {
            title: 'Angles <script>alert(1)</script>', body: `The body of the page. ${H.LONG}`,
        }, me);
        await h.svc.publish(nasty.id, {}, me);
        const nr = await H.req(h, 'GET', `/w/share-demo/${nasty.slug}`);
        const nask = (nr.text.match(/<button[^>]*data-ov-ask[^>]*>/g) || [])[0] || '';
        assert.ok(nask.includes(`data-ov-ask="About the wiki page “Angles &lt;script&gt;alert(1)&lt;/script&gt;” (http://wiki.test/w/share-demo/${nasty.slug}): "`), nask);
        assert.ok(!nask.includes('<script>'), 'the title is escaped in the chip');
        console.log('share sheet ok');
    } finally {
        await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
