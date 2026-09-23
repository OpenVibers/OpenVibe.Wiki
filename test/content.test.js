'use strict';
/**
 * Content safety and parsing: [[links]] (code is left alone, cross-space prefixes), typed infobox
 * values (nothing coerced silently), and escaping of everything a person can type — titles,
 * link labels, infobox values, Markdown links with dangerous schemes.
 */
const assert = require('assert');
const c = require('../server/wiki/content');
const H = require('./helpers');

// Links
assert.deepStrictEqual(c.extractLinks('See [[Rye bread]], [[Rye bread|again]] and [[other-space:Wheat|wheat]].', 'bread').map((l) => [l.space, l.slug, l.label]),
    [['bread', 'rye-bread', null], ['other-space', 'wheat', 'wheat']]);
assert.deepStrictEqual(c.extractLinks('`[[Not a link]]`\n```\n[[Nor this]]\n```\n[[Yes]]', 's').map((l) => l.slug), ['yes']);
assert.deepStrictEqual(c.extractLinks('[[Note: colon titles]]', 's').map((l) => [l.space, l.slug]), [['s', 'note-colon-titles']], 'Uppercase before a colon is part of the title');
assert.deepStrictEqual(c.extractLinks('[[media:med_x]] [[!!!]]', 's'), [{ space: 's', slug: 'media-med-x', title: 'media:med_x', label: null }]);

// Rendering escapes labels and never produces script or javascript: links.
const html = c.renderContent('[[Page|<img src=x onerror=alert(1)>]] [x](javascript:alert(1)) <script>alert(1)</script>', {
    currentSpace: 's', resolve: () => ({ href: '/w/s/page', exists: true }),
});
assert.ok(!/<script|<img|href="javascript/i.test(html), html);
assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));

// Infobox
assert.deepStrictEqual(c.parseInfoboxText('Founded | date | 2026-09-20\nPlayers | number | 2\nOpen | boolean | no\nSite | url | https://example.org\nName | Chess'), [
    { key: 'founded', label: 'Founded', type: 'date', value: '2026-09-20' },
    { key: 'players', label: 'Players', type: 'number', value: 2 },
    { key: 'open', label: 'Open', type: 'boolean', value: false },
    { key: 'site', label: 'Site', type: 'url', value: 'https://example.org/' },
    { key: 'name', label: 'Name', type: 'text', value: 'Chess' },
]);
for (const bad of ['Site | url | javascript:alert(1)', 'N | number | lots', 'D | date | yesterday', 'B | boolean | maybe', 'M | media | https://x', 'A | text | x\nA | text | y', 'T | tensor | 1']) {
    assert.throws(() => c.parseInfoboxText(bad), (e) => e instanceof c.ContentError, bad);
}

(async () => {
    const h = await H.boot();
    const me = { kind: 'user', subject: H.subject() };
    try {
        const s = h.svc.createSpace({ name: '<b>Space</b>', slug: 'xss' }, me);
        const { page } = h.svc.createPage(s.id, {
            title: '<script>alert(1)</script> title', body: `Body ${H.LONG}`, summary: '"><script>alert(2)</script>',
            infobox: [{ label: '<i>L</i>', type: 'text', value: '<img src=x onerror=alert(3)>' }],
            citations: [{ url: 'https://example.org/"><script>', title: '<script>alert(4)</script>', retrievedAt: '2026-09-01' }],
        }, me);
        h.svc.publish(page.id, {}, me);
        const r = await H.req(h, 'GET', `/w/xss/${page.slug}`);
        assert.strictEqual(r.status, 200);
        const body = r.text.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '').replace(/<script>\s*window\.__OV_PAGE[\s\S]*?<\/script>/, '').replace(/<script>\(function\(\)\{try\{var r=localStorage[\s\S]*?<\/script>/, '');
        assert.ok(!/<script>alert|<img src=x|<i>L<\/i>|<b>Space<\/b>/.test(body), 'user text is escaped everywhere');
        // JSON-LD cannot be broken out of.
        for (const m of r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) assert.ok(!m[1].includes('</script'), 'no </script> inside JSON-LD');
        console.log('content ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
