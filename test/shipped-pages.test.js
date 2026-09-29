'use strict';
/**
 * The shared update system on openvibe.wiki: the home shows what shipped, /updates is the log, the
 * footer links it, and the shared navbar (not a second account strip) signs in and out.
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    const h = await H.boot();
    try {
        let r = await H.req(h, 'GET', '/');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('data-ov-shipped="latest" data-service="wiki" href="/updates"'));
        assert.ok(r.text.includes('"logoutUrl":"/auth/logout?next={path}"'));
        assert.ok(r.text.includes('"loginUrl":"/auth/login?next={path}"'), 'the navbar sign-in returns to the current page (boost swaps it in place)');
        assert.ok(/<meta name="ov-boost" content="wiki@[^"]+">/.test(r.text), 'the boost marker carries the release');
        assert.ok(r.text.includes('<script src="/shared/boost.js?v=') && r.text.includes('data-main="#main"'), 'the boost script swaps #main');
        assert.ok(r.text.includes('<main id="main"'), 'the boost marker targets an existing main');
        assert.ok(/<noscript><span class="wk-account">/.test(r.text), 'the site account strip only without JavaScript');
        assert.ok(r.text.includes('"updates":"/updates"'));
        r = await H.req(h, 'GET', '/updates');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('What shipped on OpenVibe.Wiki') && r.text.includes('data-ov-shipped="log" data-service="wiki"'));
        assert.ok(r.text.includes('https://openvibe.network/updates?site=wiki'));
        console.log('shipped pages: all checks passed');
    } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
