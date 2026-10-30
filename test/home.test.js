'use strict';
/**
 * The home page: real numbers (public pages only), the most linked pages, recent revisions, the questions it answers
 * (also as FAQPage), WebSite and ItemList structured data, the home in the sitemap, sections with nothing to show left
 * out, and the official wiki's pages shelved by the Frame's site groups when the Network has told us them.
 */
const assert = require('assert');
const H = require('./helpers');
const { seed } = require('../server/wiki/seed');
const views = require('../server/render/views');
const { createFrameGroups } = require('../server/http/frame-groups');

const cite = (quote) => ({ url: 'https://github.com/OpenVibers/OpenVibe.Wiki/blob/cc7a8fc09705bfc69ee24aeb43e29c2d4453ec6b/README.md', title: 'README', retrievedAt: '2026-10-11T12:00:00.000Z', quote });
const page = (title, parent, links, domain) => ({
    title, parent,
    body: `**${title}** is a fixture page. ${links.map((l) => `It links to [[${l}]].`).join(' ')} ${H.LONG}\n`,
    summary: `${title} in one line.`,
    infobox: domain ? [{ key: 'domain', label: 'Domain', type: 'text', value: domain }] : [],
    citations: [cite(`${title} is a fixture page.`)],
});
const data = {
    space: { slug: 'openvibe', name: 'OpenVibe', description: 'The official fixture wiki.', kind: 'official', visibility: 'public' },
    pages: [
        page('OpenVibe', null, ['OpenVibe.Live', 'OpenVibe.Network', 'OpenVibe.Publishing']),
        page('OpenVibe.Network', 'OpenVibe', [], 'openvibe.network'),
        page('OpenVibe.Live', 'OpenVibe', ['OpenVibe.Network'], 'openvibe.live'),
        page('OpenVibe.Publishing', 'OpenVibe', ['OpenVibe.Network', 'OpenVibe.Live'], null),
    ],
};
const ld = (text) => [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

(async () => {
    const h = await H.boot();
    try {
        await seed(h.svc, data, { log: H.quiet });
        const r = await H.req(h, 'GET', '/');
        assert.strictEqual(r.status, 200);
        const text = r.text;

        // Search results: a title and a description that say what the site does.
        assert.match(text, /<title>OpenVibe\.Wiki: wikis with full history and cited sources<\/title>/);
        const desc = /<meta name="description" content="([^"]*)"/.exec(text)[1];
        assert.ok(desc.length <= 160 && /revision history/.test(desc), desc);
        assert.strictEqual((text.match(/<h1\b/g) || []).length, 1, 'one h1');

        // The numbers: public published pages, their revisions, citations and links between them (all real).
        const stats = await h.svc.homeStats();
        assert.deepStrictEqual({ pages: stats.pages, revisions: stats.revisions, citations: stats.citations, links: stats.links }, { pages: 4, revisions: 4, citations: 4, links: 6 });
        assert.match(text, /<dt>Published pages<\/dt><dd>4<\/dd>/);
        assert.match(text, /<dt>Links between pages<\/dt><dd>6<\/dd>/);
        assert.ok(!text.includes('<dt>Public wikis</dt>'), 'one wiki: no "1 wiki" tile');

        // Most linked: Network (from three pages), then Live (two), then Publishing (one).
        const linked = await h.svc.mostLinked(6);
        assert.deepStrictEqual(linked.map((x) => [x.page.title, x.links]), [['OpenVibe.Network', 3], ['OpenVibe.Live', 2], ['OpenVibe.Publishing', 1]]);
        assert.match(text, /OpenVibe\.Network<\/a><span class="wk-h-count">Linked from 3 pages<\/span>/);

        // Recently revised, the questions, the links around the site, the start-here link.
        assert.ok(text.includes('>Recently revised<') && text.includes('revision 1'));
        assert.ok(text.includes('<summary>Who can start a wiki?</summary>'));
        assert.ok(text.includes('href="/recent"') && text.includes('href="/updates"') && text.includes('href="/s/openvibe"'));
        assert.ok(text.includes('Start with OpenVibe'));
        assert.ok(!text.includes('>Community wikis<'), 'no public community wiki: no section');

        // Structured data: WebSite with its search, the ItemList of the shelf, FAQPage of exactly the questions shown.
        const blocks = ld(text);
        const site = blocks.find((b) => b['@type'] === 'WebSite');
        assert.ok(site && /\/search\?q=\{search_term_string\}$/.test(site.potentialAction.target.urlTemplate));
        const list = blocks.find((b) => b['@type'] === 'ItemList');
        assert.deepStrictEqual(list.itemListElement.map((x) => x.name).sort(), ['OpenVibe.Live', 'OpenVibe.Network', 'OpenVibe.Publishing']);
        const faq = blocks.find((b) => b['@type'] === 'FAQPage');
        for (const q of faq.mainEntity) assert.ok(text.includes(`<summary>${q.name.replace(/'/g, '&#39;')}</summary>`), q.name);

        // The home is in the sitemap, first.
        const map = (await H.req(h, 'GET', '/sitemaps/spaces.xml')).text;
        assert.ok(map.indexOf('<loc>http://wiki.test/</loc>') > 0 && map.indexOf('<loc>http://wiki.test/</loc>') < map.indexOf('/s/openvibe'));

        // Shelves by the Frame's groups: a page's domain picks its launcher group; the rest go under the platform.
        const spaces = await h.svc.listSpaces({ kind: 'anonymous' });
        const shelf = await h.svc.shelf(spaces[0], { kind: 'anonymous' }, 60);
        const groups = { groups: [{ id: 'watch', name: 'Watch & stream' }, { id: 'you', name: 'Your OpenVibe' }, { id: 'talk', name: 'Talk & learn' }],
            hosts: new Map([['openvibe.live', 'watch'], ['openvibe.network', 'you']]) };
        const grouped = String(views.home({ spaces, recent: [], shelves: new Map([[spaces[0].id, shelf]]), groups, actor: { kind: 'anonymous' } }));
        // The groups are one pick block: the chips name them in order, and each group's pages follow in its pane.
        const chips = ['Watch &amp; stream', 'Your OpenVibe', 'Platform and libraries'].map((s) => grouped.indexOf(s));
        assert.ok(chips.every((i, n) => i > 0 && (n === 0 || i > chips[n - 1])), `the groups are in order: ${chips}`);
        const inOrder = (list, what) => assert.ok(list.every((i, n) => i > 0 && (n === 0 || i > list[n - 1])), `${what} in order: ${list}`);
        inOrder(['OpenVibe.<wbr>Live', 'OpenVibe.<wbr>Network', 'OpenVibe.<wbr>Publishing'].map((s) => grouped.indexOf(s)), 'the pages');
        assert.ok(!grouped.includes('Talk &amp; learn'), 'a group with no pages is left out');

        // The Frame reader: groups and hosts from /api/chrome, cached; unreachable → null (one flat shelf).
        let calls = 0;
        const fg = createFrameGroups({ url: 'http://network.test/api/chrome', fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ groups: [{ id: 'watch', name: 'Watch & stream' }], nav: [{ url: 'https://openvibe.live/', group: 'watch' }, { url: 'nope', group: 'x' }] }) }; } });
        const got = await fg.get();
        assert.deepStrictEqual([got.groups, [...got.hosts]], [[{ id: 'watch', name: 'Watch & stream' }], [['openvibe.live', 'watch']]]);
        await fg.get();
        assert.strictEqual(calls, 1, 'cached');
        assert.strictEqual(await createFrameGroups({ url: 'http://network.test/api/chrome', fetchImpl: async () => { throw new Error('down'); } }).get(), null);
        assert.strictEqual(await createFrameGroups({ url: '' }).get(), null);

        console.log('home ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
