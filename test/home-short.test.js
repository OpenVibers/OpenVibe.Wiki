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

        assert.ok(!text.includes('pick-read'), 'the pages to start with are one list, not a pick block');
        // Every list stays in the page for the crawlers.
        assert.ok(text.includes('Most linked pages') && text.includes('Recently revised'), 'both lists are in the page');
        assert.strictEqual((text.match(/class="wk-h-rank"/g) || []).length, 1, 'the most-linked list is in the page');

        // The folds: open in the page, closed on a phone, and their content stays in the page.
        for (const id of ['wikis', 'faq', 'network', 'shipped']) {
            assert.ok(text.includes(`<details class="wk-fold wk-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
            assert.ok(!text.includes(`document.getElementById("${id}")`), `${id} is never closed by script`);
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
        assert.ok(!grouped.includes('pick-shelf-openvibe'), 'the groups are one list, not a pick block');
        for (const title of ['Watch &amp; stream', 'Your OpenVibe', 'Platform and libraries']) {
            assert.ok(grouped.includes(title), `${title} is in the page`);
        }
        // Every page stays in the page.
        assert.strictEqual((grouped.match(/class="sc-card wk-h-card"/g) || []).length, 3, 'every page card is in the page');
        assert.ok(!rules.join('').includes('.pick:has('), 'no pick rule is written for the page');

        // Nothing hides a ranked page, a recent change or a fold line on a phone.
        const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'wiki.css'), 'utf8');
        assert.ok(!/nth-child\(n\+4\)/.test(css), 'no ranked page is hidden');
        assert.ok(!/nth-child\(n\+6\)/.test(css), 'no recent change is hidden');
        assert.ok(!/\.wk-h-fold > summary span \{ display: none/.test(css), 'a fold keeps its line');

        console.log('home-short ok');
    } finally {
        await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
