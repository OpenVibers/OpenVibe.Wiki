'use strict';
/**
 * Regressions for the gaps fixed in the threat review (docs/threat-review.md):
 *   - outbound links in community (user) spaces carry rel="nofollow ugc" — Markdown links, bare
 *     URLs, citations and infobox URLs — so link spam passes no ranking; official spaces keep theirs;
 *   - a page summary is short text (it becomes the meta description, feeds and the Search document):
 *     anything else is refused instead of stored;
 *   - AI proposals (which reach any space without a person) come only from first-party services;
 *   - the HTML search (a LIKE scan over every published page) and revision diffs (CPU and memory
 *     heavy for large, very different revisions) are rate-limited per address.
 */
const assert = require('assert');
const H = require('./helpers');
const { SYSTEM } = require('../server/wiki/seed');

(async () => {
    const h = await H.boot();
    const me = H.subject();
    const tok = H.userToken({ subject: me });
    const cite = [{ url: 'https://cited.example/a', title: 'Cited', retrievedAt: '2026-09-01' }];
    const body = `[a link](https://spam.example/one) and https://spam.example/two ${H.LONG}`;
    const infobox = [{ label: 'Site', type: 'url', value: 'https://infobox.example/' }];
    const anchors = (html, host) => html.match(new RegExp(`<a href="https://${host.replace('.', '\\.')}[^"]*"[^>]*>`, 'g')) || [];
    try {
        // Community space: every outbound link is nofollow ugc.
        const user = h.svc.createSpace({ name: 'Community', slug: 'community' }, { kind: 'user', subject: me });
        const up = h.svc.createPage(user.id, { title: 'Links', body, infobox, citations: cite }, { kind: 'user', subject: me }).page;
        h.svc.publish(up.id, {}, { kind: 'user', subject: me });
        let html = (await H.req(h, 'GET', '/w/community/links')).text;
        const userLinks = [...anchors(html, 'spam.example'), ...anchors(html, 'cited.example'), ...anchors(html, 'infobox.example')];
        assert.strictEqual(userLinks.length, 4, userLinks.join('\n'));
        for (const a of userLinks) assert.ok(/rel="nofollow ugc noopener"/.test(a), a);
        html = (await H.req(h, 'GET', '/w/community/links/sources')).text;
        assert.ok(anchors(html, 'cited.example').every((a) => /rel="nofollow ugc noopener"/.test(a)));
        // The editor's preview renders the same way.
        html = (await H.req(h, 'POST', '/s/community/new', { cookie: H.cookieFor(tok), form: { op: 'preview', title: 'X', body } })).text;
        assert.ok(anchors(html, 'spam.example').every((a) => /rel="nofollow ugc noopener"/.test(a)));

        // Official space: staff vouch for their links.
        const off = h.svc.createSpace({ name: 'Official', slug: 'official', kind: 'official' }, SYSTEM);
        const op = h.svc.createPage(off.id, { title: 'Links', body, infobox, citations: cite }, { kind: 'user', subject: me, staff: true }).page;
        h.svc.publish(op.id, {}, { kind: 'user', subject: me, staff: true });
        html = (await H.req(h, 'GET', '/w/official/links')).text;
        assert.ok(anchors(html, 'spam.example').every((a) => /rel="noopener"/.test(a)) && anchors(html, 'spam.example').length === 2);
        assert.ok(anchors(html, 'cited.example').every((a) => /rel="noopener nofollow"/.test(a)));

        // Summaries: short text only, through every write path.
        const bad = [{ a: 1 }, ['x'], 42, 's'.repeat(301)];
        for (const summary of bad) {
            const r = await H.req(h, 'POST', '/api/v1/spaces/community/pages', { token: tok, body: { title: `S ${String(summary).length}`, body: H.LONG, summary } });
            assert.strictEqual(r.status, 422, JSON.stringify(summary).slice(0, 40));
            assert.strictEqual(r.json.code, 'page.invalid_summary');
        }
        let r = await H.req(h, 'POST', `/api/v1/pages/${up.id}/revisions`, { token: tok, body: { expected_revision: 1, summary: 'x'.repeat(5000) } });
        assert.strictEqual(r.status, 422);
        assert.throws(() => h.svc.propose({ space: 'community', title: 'Proposed', body: H.LONG, summary: { html: '<b>' }, workflow: { id: 'wiki.generate_page', runId: 'run_1' } }, { kind: 'service', service: 'svc:ai' }), (e) => e.status === 422 && e.code === 'page.invalid_summary');
        r = await H.req(h, 'POST', '/api/v1/spaces/community/pages', { token: tok, body: { title: 'Summarised', body: H.LONG, summary: '  One   short sentence.  ' } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.json.revision.summary, 'One short sentence.');

        // AI proposals reach any space without a person, so only first-party services file them:
        // a developer app or module holding the capability is refused.
        const proposal = { space: 'community', title: 'Planted', body: H.LONG, workflow: { id: 'wiki.generate_page', run_id: 'run_2' } };
        for (const [sub, actorType] of [['app:app_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', 'app'], ['mod:mod_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', 'mod']]) {
            r = await H.req(h, 'POST', '/api/v1/proposals', { token: H.serviceToken({ sub, actorType, cap: ['wiki.revision.propose'], extra: { on_behalf_of: me } }), body: proposal });
            assert.strictEqual(r.status, 403, `${actorType}: ${r.text}`);
            assert.strictEqual(r.json.code, 'proposal.service_only');
        }
        assert.strictEqual(h.svc.findPage(user.id, 'planted'), null);
        r = await H.req(h, 'POST', '/api/v1/proposals', { token: H.serviceToken({ client: 'ai', cap: ['wiki.revision.propose'] }), body: proposal });
        assert.strictEqual(r.status, 201, r.text);
        await h.stop();

        // The HTML search and diffs are rate-limited per address (other pages are not).
        const limited = await H.boot({ rateLimits: true });
        try {
            for (let i = 0; i < 60; i++) assert.strictEqual((await H.req(limited, 'GET', `/search?q=w${i}`)).status, 200);
            assert.strictEqual((await H.req(limited, 'GET', '/search?q=again')).status, 429);
            assert.strictEqual((await H.req(limited, 'GET', '/')).status, 200);
            const owner = { kind: 'user', subject: H.subject() };
            const sp = limited.svc.createSpace({ name: 'Diffs', slug: 'diffs' }, owner);
            const pg = limited.svc.createPage(sp.id, { title: 'Long', body: 'a b c' }, owner).page;
            limited.svc.editPage(pg.id, { expectedRevision: 1, body: 'x y z' }, owner);
            limited.svc.publish(pg.id, {}, owner);
            for (let i = 0; i < 15; i++) {
                assert.strictEqual((await H.req(limited, 'GET', '/w/diffs/long/diff/1/2')).status, 200);
                assert.strictEqual((await H.req(limited, 'GET', `/api/v1/pages/${pg.id}/diff?from=1&to=2`)).status, 200);
            }
            assert.strictEqual((await H.req(limited, 'GET', '/w/diffs/long/diff/1/2?mode=line')).status, 429, 'SSR and API diffs share one budget');
            assert.strictEqual((await H.req(limited, 'GET', '/w/diffs/long')).status, 200);
        } finally {
            await limited.stop();
        }
        console.log('threat review regressions ok');
    } catch (err) {
        await h.stop().catch(() => {});
        throw err;
    }
})().catch((err) => { console.error(err); process.exit(1); });
