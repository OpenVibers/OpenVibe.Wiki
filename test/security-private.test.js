'use strict';
/**
 * Private, members-only and unpublished wiki content reaches nobody who may not read it, on any
 * path (roadmap WS-R task 5, the private-object class). visibility.test.js, vip-gate.test.js and
 * discussion-visibility.test.js pin the rules and the machine surfaces; this suite covers the
 * class: it seeds a private space, and in a public space a private page, a members-only page, a
 * draft and an unpublished second revision, plus an AI proposal against the private page, each
 * with words found nowhere else. Then it GETs EVERY route the booted app has (listed from Express's
 * router stack, test/security-crawl.js), with those spaces, slugs, page ids, revision numbers and
 * the proposal id in every parameter, plus the machine surfaces (sitemaps, feeds, llms.txt, search),
 * as anonymous, a signed-in stranger and Network staff (who get no silent access to user spaces).
 * None of the words may appear (the members-only page's to anonymous: it is for any signed-in account). A viewer of the private space sees it (control), and the events
 * outbox carries none of it (the Search index gets tombstones, never the text).
 *
 *   node test/security-private.test.js
 */
const assert = require('assert');
const H = require('./helpers');
const { getPaths, crawl } = require('./security-crawl');

(async () => {
    const h = await H.boot();
    const owner = { kind: 'user', subject: H.subject(), staff: false };
    const friend = H.subject();
    const cite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
    const SECRET = {
        spaceName: 'Vault Of Whispers', hiddenTitle: 'Hidden Ledger Title', hiddenWords: 'ledger-secret-words',
        privateTitle: 'Private Plans Title', privateWords: 'private-plans-words', membersWords: 'members-only-words',
        draftTitle: 'Draft Musings Title', draftWords: 'draft-musings-words', rev2Words: 'unpublished-revision-words',
        proposalWords: 'proposal-secret-words',
    };
    const body = (w) => `${H.LONG} ${w} ${w}.`;
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 10).join('\n    ')}`); } };
    try {
        const vault = h.svc.createSpace({ name: SECRET.spaceName, slug: 'vault', visibility: 'private' }, owner);
        h.svc.setRole(vault.id, friend, 'viewer', owner);
        const hidden = h.svc.createPage(vault.id, { title: SECRET.hiddenTitle, body: body(SECRET.hiddenWords), citations: cite }, owner).page;
        h.svc.publish(hidden.id, {}, owner);

        const open = h.svc.createSpace({ name: 'Open Space', slug: 'open' }, owner);
        const control = h.svc.createPage(open.id, { title: 'Open Page', body: body('open-control-words'), citations: cite }, owner).page;
        h.svc.publish(control.id, {}, owner);
        // Restricted from the start (a page that was public once was legitimately public then).
        const priv = h.svc.createPage(open.id, { title: SECRET.privateTitle, body: body(SECRET.privateWords), citations: cite, visibility: 'private' }, owner).page;
        h.svc.publish(priv.id, {}, owner);
        const members = h.svc.createPage(open.id, { title: 'Members Page', body: body(SECRET.membersWords), citations: cite, visibility: 'members' }, owner).page;
        h.svc.publish(members.id, {}, owner);
        const draft = h.svc.createPage(open.id, { title: SECRET.draftTitle, body: body(SECRET.draftWords), citations: cite }, owner).page;
        // A published page with a second, unpublished revision.
        h.svc.editPage(control.id, { expectedRevision: 1, body: body(SECRET.rev2Words), summary: 'wip', citations: cite }, owner);
        const proposal = h.svc.propose({ space: vault.id, pageId: hidden.id, title: SECRET.hiddenTitle, body: body(SECRET.proposalWords), summary: 'ai', citations: cite, workflow: { id: 'wf.test', runId: 'run_1' } }, { kind: 'system' });
        const pageIds = [hidden.id, priv.id, draft.id, members.id, proposal.id || proposal.proposal && proposal.proposal.id];

        const ownerTok = H.userToken({ subject: owner.subject, username: 'owner' });
        await check('control: the owner and a viewer of the private space read it; the open page is public', async () => {
            let r = await H.req(h, 'GET', '/w/vault/hidden-ledger-title', { cookie: H.cookieFor(H.userToken({ subject: friend, username: 'friend' })) });
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.ok(r.text.includes(SECRET.hiddenWords));
            r = await H.req(h, 'GET', `/api/v1/pages/${priv.id}`, { token: ownerTok });
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.ok(r.text.includes(SECRET.privateTitle));
            assert.strictEqual((await H.req(h, 'GET', '/w/open/open-page')).status, 200);
        });

        await check('every GET route, page and machine surface: nothing of it reaches anonymous, a stranger or staff', async () => {
            const values = (name) => {
                if (name === 'space') return ['vault', 'open', 'open', 'open'];
                if (name === 'slug') return ['hidden-ledger-title', 'private-plans-title', 'draft-musings-title', 'members-page', 'open-page'];
                if (name === 'n' || name === 'a' || name === 'b') return [1, 2, 1, 2, 2];
                if (name === 'subject') return [owner.subject, friend];
                return pageIds;
            };
            const paths = getPaths(h.app, values, {
                // (Queries use parts of the words: a page may echo its own query back.)
                query: 'q=ledger&space=vault&revision=2&from=1&to=2',
                extra: ['/sitemap.xml', '/sitemaps/spaces.xml', '/sitemaps/pages-1.xml', '/feed.atom', '/feed.json', '/llms.txt', '/recent', '/updates',
                    '/search?q=ledger', '/search?q=private-plans', '/search?q=draft-musings', '/search?q=Hidden+Ledger', '/api/v1/search?q=members-only',
                    '/api/v1/search?q=ledger', '/api/v1/search?q=unpublished-revision', '/api/v1/search?q=proposal-secret',
                    '/api/v1/spaces', '/s/vault', '/s/open', '/w/open/open-page/history', '/w/open/open-page/diff/1/2', '/w/open/open-page?revision=2',
                    '/w/open/open-page/compare?a=1&b=2', `/api/v1/pages/${control.id}/revisions/2`, `/api/v1/pages/${control.id}/diff?from=1&to=2`],
            });
            const staffTok = H.userToken({ subject: H.subject(), username: 'staffer', role: 'admin' });
            const strangerTok = H.userToken({ subject: H.subject(), username: 'stranger' });
            // A members page is for any signed-in account: only anonymous must not see it.
            const signedIn = Object.fromEntries(Object.entries(SECRET).filter(([k]) => k !== 'membersWords'));
            const r = await crawl(h, H.req, paths, { anonymous: null, stranger: strangerTok, staff: staffTok }, (who) => (who === 'anonymous' ? SECRET : signedIn));
            console.log(`    (${paths.length} paths × 3 people; answers ${JSON.stringify(r.statuses)})`);
            assert.ok(r.answered >= paths.length * 2);
            assert.deepStrictEqual(r.found, []);
        });

        await check('public events and Search index documents carry none of it (internal events are first-party only)', async () => {
            const text = JSON.stringify(H.outbox(h).filter((e) => e.visibility === 'public' || e.event_type === 'wiki.index_document.upserted'));
            assert.ok(text.includes('open-control-words') || text.includes('Open Page'), 'the public page is there (control)');
            const hits = Object.entries(SECRET).filter(([, w]) => text.includes(w)).map(([k]) => k);
            assert.deepStrictEqual(hits, []);
        });
    } finally {
        await h.stop();
    }
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nsecurity-private: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
