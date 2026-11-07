'use strict';
// The menu's network card for OpenVibe.Wiki (frame.menu-card@1): GET /.well-known/openvibe-menu.json serves
// "New on the wiki" — the most recently revised public pages, each linking to its article. The array validates
// against frame.menu-cards@1, carries no private or deleted page, is CORS * and cached for five minutes.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createMenuCard, cardFrom, pagePath, CARD_TTL_S } = require('../server/menu-card');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const change = (over = {}) => ({
    space: { slug: 'openvibe', name: 'OpenVibe', ...(over.space || {}) },
    page: {
        slug: 'how-it-works', title: 'How OpenVibe works', state: 'published', visibility: 'public',
        revision_published_at: NOW - 2 * 60 * 60_000, ...(over.page || {}),
    },
});

// ── The card's shape and words ───────────────────────────────────────────
const card = cardFrom([
    change(),
    change({ space: { slug: 'cooking', name: 'Cooking' }, page: { slug: 'rye-bread', title: '<b>Rye</b>\nbread', revision_published_at: NOW - 26 * 60 * 60_000 } }),
], NOW);
const checked = contracts.validate('frame.menu-cards@1', [card]);
assert.ok(checked.valid, JSON.stringify(checked.errors));
assert.deepStrictEqual(Object.keys(card).sort(), ['id', 'items', 'kind', 'more', 'site', 'title', 'ttl_s', 'updated_at']);
assert.strictEqual(card.id, 'new-pages');
assert.strictEqual(card.site, 'wiki');
assert.strictEqual(card.title, 'New on the wiki');
assert.strictEqual(card.kind, 'rows');
assert.strictEqual(card.ttl_s, CARD_TTL_S);
assert.deepStrictEqual(card.items, [
    { title: 'How OpenVibe works', meta: 'OpenVibe · 2h ago', url: 'https://openvibe.wiki/w/openvibe/how-it-works' },
    { title: 'Rye bread', meta: 'Cooking · 1d ago', url: 'https://openvibe.wiki/w/cooking/rye-bread' },
]);
assert.deepStrictEqual(card.more, { label: 'All wikis', url: 'https://openvibe.wiki/' });
assert.ok(card.title.length <= 60);
for (const it of card.items) assert.ok(it.title.length <= 80 && (!it.meta || it.meta.length <= 120) && it.url.startsWith('https://openvibe.wiki/w/'));

// Drafts, private wikis, deleted pages and broken rows never enter the card, and at most six pages are sent.
assert.deepStrictEqual(cardFrom([change({ page: { visibility: 'private' } })], NOW).items, []);
assert.deepStrictEqual(cardFrom([change({ page: { state: 'deleted' } })], NOW).items, []);
assert.deepStrictEqual(cardFrom([change({ page: { title: '   ' } })], NOW).items, []);
assert.deepStrictEqual(cardFrom([null, {}], NOW).items, []);
assert.deepStrictEqual(cardFrom(null, NOW).items, []);
const many = Array.from({ length: 9 }, (_, i) => change({ page: { slug: `page-${i}`, title: `Page ${i}` } }));
assert.strictEqual(cardFrom(many, NOW).items.length, 6);

// The path is the site's own, with both segments encoded.
assert.strictEqual(pagePath({ slug: 'a b' }, { slug: 'c/d' }), '/w/a%20b/c%2Fd');

// ── The five-minute cache and the route's headers ───────────────────────
(async () => {
    let t = NOW;
    let loads = 0;
    const menu = createMenuCard({ load: async () => { loads++; return [change()]; }, now: () => t });
    const first = await menu.card();
    assert.strictEqual(loads, 1);
    assert.strictEqual(await menu.card(), first);
    assert.strictEqual(loads, 1, 'a second request inside the ttl is served from the cache');
    t += CARD_TTL_S * 1000 + 1;
    await menu.card();
    assert.strictEqual(loads, 2, 'after the ttl the card is rebuilt');

    const headers = {};
    let body = null;
    const res = {
        set(k, v) { headers[k] = v; return this; },
        json(v) { body = v; return this; },
    };
    await menu.handler({}, res);
    assert.strictEqual(headers['Access-Control-Allow-Origin'], '*');
    assert.strictEqual(headers['Cross-Origin-Resource-Policy'], 'cross-origin');
    assert.strictEqual(headers['Cache-Control'], 'public, max-age=60');
    assert.ok(Array.isArray(body) && body.length === 1, 'the file is an array of cards');
    assert.ok(contracts.validate('frame.menu-cards@1', body).valid);

    // A failing database keeps the last good card rather than publishing an empty list.
    let fail = false;
    const flaky = createMenuCard({ load: async () => { if (fail) throw new Error('db down'); return [change()]; }, now: () => t });
    const good = await flaky.card();
    fail = true;
    t += CARD_TTL_S * 1000 + 1;
    assert.strictEqual(await flaky.card(), good);

    console.log('menu card: shape, contract, public-only pages, plain text, 5 min cache, CORS and last-good card');
})().catch((err) => { console.error(err); process.exit(1); });
