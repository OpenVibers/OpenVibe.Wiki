'use strict';
/**
 * The page shell (server/render/layout.js): every page is openvibe-publishing/layout's document
 * (openvibe-shared/shell page()): one title, the canonical, robots exactly as the page passed it (the
 * gate's decision for an article, noindex for editing surfaces), JSON-LD, the feed links, the
 * stylesheets, the network app icon, the Frame (navbar mount, noscript navigation, the
 * server-rendered footer and its init) and the boost marker.
 */
const assert = require('assert');
const H = require('./helpers');
const { renderPage } = require('../server/render/layout');

const count = (s, re) => (s.match(re) || []).length;
const split = (html) => ({ head: html.slice(0, html.indexOf('</head>')), body: html.slice(html.indexOf('</head>')) });

/** What every page carries, whatever its robots. */
function frameOf(html, where) {
    const { head, body } = split(html);
    assert.strictEqual(count(html, /<title>/g), 1, `${where}: exactly one <title>`);
    assert.strictEqual(count(head, /<link rel="canonical"/g), 1, `${where}: one canonical`);
    assert.strictEqual(count(head, /<meta name="robots"/g), 1, `${where}: one robots meta`);
    assert.ok(head.includes('<link rel="alternate" type="application/atom+xml" href="/feed.atom" title="OpenVibe.Wiki: recent changes (Atom)">'), `${where}: Atom feed link`);
    assert.ok(head.includes('<link rel="alternate" type="application/feed+json" href="/feed.json" title="OpenVibe.Wiki: recent changes (JSON Feed)">'), `${where}: JSON feed link`);
    assert.ok(/<link rel="stylesheet" href="\/css\/wiki\.css\?v=[0-9a-z]+">/.test(head), `${where}: the wiki stylesheet`);
    assert.ok(/<link rel="[^"]*icon[^"]*"/.test(head), `${where}: the app icon tags`);
    assert.ok(/<meta name="ov-boost" content="wiki@[^"]+">/.test(head), `${where}: the boost marker`);
    assert.ok(/<script src="\/shared\/boost\.js\?v=[0-9a-f]+" data-main="#main" defer><\/script>/.test(head), `${where}: the boost script`);
    assert.ok(body.includes('<div id="navbar-mount"></div>'), `${where}: the navbar mount`);
    assert.ok(body.includes('<noscript><nav'), `${where}: the noscript navigation`);
    assert.ok(body.includes('id="ov-footer"'), `${where}: the server-rendered footer`);
    assert.ok(body.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), `${where}: the footer is initialised`);
    assert.ok(body.includes('<header class="wk-bar">'), `${where}: the site header`);
    assert.ok(body.includes('<main id="main" class="wk-main">'), `${where}: the swappable <main>`);
    assert.ok(body.includes('"loginUrl":"/auth/login?next={path}"'), `${where}: the navbar signs in through the {path} template`);
    return { head, body };
}
const robotsOf = (head) => /<meta name="robots" content="([^"]*)">/.exec(head)[1];

(async () => {
    const h = await H.boot();
    const me = H.subject();
    const cookie = H.cookieFor(H.userToken({ subject: me, username: 'ana' }));
    try {
        let r = await H.req(h, 'POST', '/new-space', { cookie, form: { name: 'Board games', slug: 'board-games', visibility: 'public', description: 'Rules and notes' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        r = await H.req(h, 'POST', '/s/board-games/new', { cookie, form: {
            op: 'publish', title: 'Chess', body: `Chess is played on a board of sixty-four squares. ${H.LONG}`, summary: 'A two-player board game.',
            cite_url_0: 'https://example.org/chess', cite_title_0: 'Chess rules', cite_retrieved_0: '2026-09-20',
        } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));

        // The home page: indexable by an explicit robots string, plus the showcase kit's stylesheet.
        r = await H.req(h, 'GET', '/');
        let { head } = frameOf(r.text, '/');
        assert.ok(head.includes('<title>OpenVibe.Wiki</title>'), 'the home title is the site name');
        assert.ok(/<link rel="canonical" href="https?:\/\/[^"\/]+\/">/.test(head), 'the home canonical');
        assert.strictEqual(robotsOf(head), 'index, follow');
        assert.ok(/<link rel="stylesheet" href="\/shared\/[^"]*showcase[^"]*">/.test(head), 'the extra openvibe-shared stylesheet');
        assert.ok(head.indexOf('/css/wiki.css') < head.indexOf('showcase'), 'the extra stylesheet follows the wiki stylesheet');

        // A public space: its breadcrumb JSON-LD (a single object, not an array) reaches the head.
        r = await H.req(h, 'GET', '/s/board-games');
        ({ head } = frameOf(r.text, '/s/board-games'));
        assert.strictEqual(robotsOf(head), 'index, follow');
        assert.ok(head.includes('<title>Board games · OpenVibe.Wiki</title>'), 'the composed title');
        assert.ok(/<link rel="canonical" href="[^"]+\/s\/board-games">/.test(head));
        assert.ok(count(head, /<script type="application\/ld\+json">/g) >= 1, 'JSON-LD');

        // An article: robots from the gate's decision, canonical, article JSON-LD, Open Graph type.
        r = await H.req(h, 'GET', '/w/board-games/chess');
        assert.strictEqual(r.status, 200);
        ({ head } = frameOf(r.text, 'article'));
        assert.ok(head.includes('<title>Chess · OpenVibe.Wiki</title>'), 'the composed title');
        assert.ok(/<link rel="canonical" href="[^"]+\/w\/board-games\/chess">/.test(head), 'the canonical');
        assert.ok(/^(no)?index, (no)?follow$/.test(robotsOf(head)), `robots from the decision: ${robotsOf(head)}`);
        assert.ok(count(head, /<script type="application\/ld\+json">/g) >= 1, 'JSON-LD');
        assert.ok(head.includes('<meta property="og:type" content="article">'), 'Open Graph article type');

        // Editing surfaces and the sign-in page stay noindex.
        for (const [p, o] of [['/new-space', { cookie }], ['/s/board-games/new', { cookie }], ['/new-space', {}]]) {
            r = await H.req(h, 'GET', p, o);
            ({ head } = frameOf(r.text, p));
            assert.strictEqual(robotsOf(head), 'noindex, nofollow', `${p}: noindex`);
        }
        r = await H.req(h, 'GET', '/search?q=chess');
        assert.strictEqual(robotsOf(frameOf(r.text, '/search').head), 'noindex, follow');

        // A page needs robots or the gate's decision: no default makes it indexable.
        assert.throws(() => renderPage({ title: 'x', body: '', config: { baseUrl: 'https://openvibe.wiki' } }), TypeError);
        assert.throws(() => renderPage({ title: 'x', body: '', head: '<meta name="robots" content="index">', config: { baseUrl: 'https://openvibe.wiki' } }), TypeError);
    } finally {
        await h.stop();
    }
    console.log('layout: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
