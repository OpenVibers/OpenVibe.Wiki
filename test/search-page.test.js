'use strict';
/**
 * The search page has one search box: the site bar (layout.js) carries the query, and the page names it and lists what
 * matched. It used to draw a second form ("Words") under the bar (2026-11-01).
 */
const assert = require('assert');
const H = require('./helpers');

const count = (s, re) => (s.match(re) || []).length;

(async () => {
    const h = await H.boot();
    try {
        let r = await H.req(h, 'GET', '/search');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(count(r.text, /role="search"/g), 1, 'one search form: the bar');
        assert.ok(!r.text.includes('<label>Words'), 'no second form');
        assert.ok(r.text.includes('<h1>Search the wiki</h1>'), 'the empty page says what to do');
        assert.ok(r.text.includes('href="/recent"') && r.text.includes('>All wikis</a>'), 'and where to go instead');

        r = await H.req(h, 'GET', '/search?q=nothing-matches-this-xyz');
        assert.strictEqual(count(r.text, /role="search"/g), 1);
        assert.ok(r.text.includes('Results for “nothing-matches-this-xyz”'), 'the heading names the query');
        assert.ok(r.text.includes('No published page matches.'), 'and says when nothing matched');

        r = await H.req(h, 'GET', '/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
        assert.ok(!r.text.includes('<script>alert(1)</script>'), 'the query is escaped in the heading');
    } finally {
        await h.stop();
    }
    console.log('search page: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
