'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the home's blocks of the same kind are one pick
 * block, a row of chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(),
 * no script for the chips; every block stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const H = require('./helpers');
const { seed } = require('../server/wiki/seed');
const views = require('../server/render/views');

const cite = { url: 'https://github.com/OpenVibers/OpenVibe.Wiki/blob/main/README.md', title: 'README', retrievedAt: '2026-10-11T12:00:00.000Z', quote: 'A fixture page.' };
const page = (title, parent, links, domain) => ({
    title, parent,
    body: `**${title}** is a fixture page. ${links.map((l) => `It links to [[${l}]].`).join(' ')} ${H.LONG}\n`,
    summary: `${title} in one line.`,
    infobox: domain ? [{ key: 'domain', label: 'Domain', type: 'text', value: domain }] : [],
    citations: [cite],
});
const data = {
    space: { slug: 'openvibe', name: 'OpenVibe', description: 'The official fixture wiki.', kind: 'official', visibility: 'public' },
    pages: [
        page('OpenVibe', null, ['OpenVibe.Live', 'OpenVibe.Network'], 'openvibe.network'),
        page('OpenVibe.Network', 'OpenVibe', [], 'openvibe.network'),
        page('OpenVibe.Live', 'OpenVibe', ['OpenVibe.Network'], 'openvibe.live'),
        page('OpenVibe.Publishing', 'OpenVibe', ['OpenVibe.Network'], null),
    ],
};

(async () => {
    const h = await H.boot();
    try {
        await seed(h.svc, data, { log: H.quiet });
        // A community wiki, so the home shows the wikis people made.
        await h.svc.createSpace({ slug: 'classic-rock', name: 'Classic rock', description: 'Every band and album.', kind: 'user', visibility: 'public' }, { kind: 'user', subject: H.subject(), staff: false });

        // The home: the lists of pages are one pick block, the parts a reader rarely needs are folds.
        const r = await H.req(h, 'GET', '/');
        assert.strictEqual(r.status, 200);
        const text = r.text;

        assert.ok(text.includes('<div class="pick" id="pick-read">'), 'the pages to start with are one pick block');
        assert.match(text, /<div class="pick-row" role="radiogroup" aria-label="Pages to start with">/);
        const chips = [...text.matchAll(/<input type="radio" name="pick-read" id="pk-read-([a-z]+)" value="\1"( checked)?><label for="pk-read-\1">([^<]+)<\/label>/g)];
        assert.deepStrictEqual(chips.map((m) => m[1]), ['linked', 'recent'], 'a chip per list');
        assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), ['linked'], 'the first list is picked');
        assert.strictEqual((text.match(/class="pick-pane"/g) || []).length, chips.length, 'one pane per chip');
        // Every list stays in the page for the crawlers.
        assert.ok(text.includes('Most linked pages') && text.includes('Recently revised'), 'both lists are in the page');

        // The folds: open in the page, closed on a phone, and their content stays in the page.
        for (const id of ['wikis', 'faq', 'network', 'shipped']) {
            assert.ok(text.includes(`<details class="wk-fold wk-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
            assert.ok(text.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
        }
        assert.ok(text.includes('Who can start a wiki?'), 'the questions are still in the page');
        assert.ok(text.includes('Part of OpenVibe'), 'the other OpenVibe places are still in the page');

        // The shelf: the groups of the official wiki are one pick block, a chip per group.
        const spaces = await h.svc.listSpaces({ kind: 'anonymous' });
        const shelf = await h.svc.shelf(spaces[0], { kind: 'anonymous' }, 60);
        const groups = {
            groups: [{ id: 'watch', name: 'Watch & stream' }, { id: 'you', name: 'Your OpenVibe' }],
            hosts: new Map([['openvibe.live', 'watch'], ['openvibe.network', 'you']]),
        };
        const rules = [];
        const grouped = String(views.home({ spaces, recent: [], shelves: new Map([[spaces[0].id, shelf]]), groups, actor: { kind: 'anonymous' }, rules }));
        assert.ok(grouped.includes('<div class="pick" id="pick-shelf-openvibe">'), 'the groups are one pick block');
        const groupChips = [...grouped.matchAll(/<input type="radio" name="pick-shelf-openvibe" id="pk-shelf-openvibe-([a-z-]+)" value="\1"( checked)?><label for="pk-shelf-openvibe-\1">([^<]+)<\/label>/g)];
        assert.deepStrictEqual(groupChips.map((m) => m[1]), ['watch-stream', 'your-openvibe', 'platform-and-libraries'], 'a chip per group');
        assert.deepStrictEqual(groupChips.filter((m) => m[2]).map((m) => m[1]), ['watch-stream'], 'the first group is picked');
        // Every page stays in the page.
        assert.strictEqual((grouped.match(/class="sc-card wk-h-card"/g) || []).length, 3, 'every page card is in the page');
        // The rule that shows the picked group is written for the page.
        assert.ok(rules.join('').includes('.pick:has(#pk-shelf-openvibe-watch-stream:checked) #pp-shelf-openvibe-watch-stream{display:block}'), 'the picked group shows');

        // The CSS guard: the chips are hidden and the blocks all show until 640 px and where :has() is understood.
        const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'wiki.css'), 'utf8');
        assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
        assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
        assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
        assert.match(css, /\.pick-pane \{ display: none; \}/, 'the blocks are hidden on a phone');

        console.log('home-short ok');
    } finally {
        await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
