'use strict';
/**
 * One person cannot act on another's wiki pages or spaces by swapping ids (roadmap WS-R task 5, the
 * IDOR class). permissions.test.js walks the role matrix inside one space and delegation.test.js
 * the service/app side; this suite puts two owners side by side. Bob owns his own space (so every
 * space-level check passes for him there) and tries each write that takes an id with Ann's ids
 * instead: over the API (her page by id: edit, delete, visibility, publish, unpublish, schedule,
 * revert, revisions, citations, review, media, watch; her space: settings, roles, new pages,
 * import; an AI proposal on her page), and over the page forms, including his own space's slug
 * paired with her page's slug (/w/bob-space/<her slug>/…). Every refusal must leave all of the
 * Wiki's tables as they were; controls show each route works for its owner.
 *
 *   node test/security-idor.test.js
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    const h = await H.boot();
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 10).join('\n    ')}`); } };
    try {
        const ann = { kind: 'user', subject: H.subject(), staff: false };
        const bob = { kind: 'user', subject: H.subject(), staff: false };
        const cite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
        const annSpace = await h.svc.createSpace({ name: 'Ann Space', slug: 'ann-space' }, ann);
        const annPage = (await h.svc.createPage(annSpace.id, { title: 'Ann Page', body: H.LONG, citations: cite }, ann)).page;
        await h.svc.publish(annPage.id, {}, ann);
        const annPrivate = (await h.svc.createPage(annSpace.id, { title: 'Ann Private', body: H.LONG, citations: cite, visibility: 'private' }, ann)).page;
        const bobSpace = await h.svc.createSpace({ name: 'Bob Space', slug: 'bob-space' }, bob);
        const bobPage = (await h.svc.createPage(bobSpace.id, { title: 'Bob Page', body: H.LONG, citations: cite }, bob)).page;
        await h.svc.publish(bobPage.id, {}, bob);
        const proposal = await h.svc.propose({ space: annSpace.id, pageId: annPage.id, title: 'Ann Page', body: `${H.LONG} proposed`, summary: 'ai', citations: cite, workflow: { id: 'wf.test', runId: 'run_1' } }, { kind: 'system' });
        const proposalId = proposal.id || (proposal.proposal && proposal.proposal.id);
        const bobTok = H.userToken({ subject: bob.subject, username: 'bob' });
        const annTok = H.userToken({ subject: ann.subject, username: 'ann' });

        const tables = (await h.db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'wiki_%' AND table_name NOT IN ('wiki_event_outbox', 'wiki_module_dirty', 'wiki_module_pushes')").all()).map((r) => r.name);
        const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await h.db.prepare(`SELECT * FROM ${t}`).all()])));
        const same = async (before, label) => {
            const after = await snapshot();
            for (const t of tables) assert.deepStrictEqual(after[t], before[t], `${label}: ${t} changed`);
        };
        const api = (method, p, body, token = bobTok) => H.req(h, method, `/api/v1${p}`, { token, body });
        const form = (p, fields, token = bobTok) => H.req(h, 'POST', p, { cookie: H.cookieFor(token), form: fields, headers: { Origin: 'http://wiki.test' } });
        const refused = (r, what) => assert.ok([401, 403, 404, 409].includes(r.status) || (r.status === 303 && !/\/w\/ann-space/.test(r.headers.get('location') || '')), `${what}: ${r.status} ${r.text.slice(0, 160)}`);

        await check('API: Bob, owner of his own space, cannot touch Ann\'s page or space by id', async () => {
            const before = await snapshot();
            for (const id of [annPage.id, annPrivate.id]) {
                refused(await api('PATCH', `/pages/${id}`, { title: 'pwned', slug: 'pwned', visibility: 'public', noindex: true }), `PATCH ${id}`);
                refused(await api('DELETE', `/pages/${id}`), `DELETE ${id}`);
                refused(await api('POST', `/pages/${id}/revisions`, { expected_revision: 1, body: `${H.LONG} pwned`, citations: cite }), 'new revision');
                refused(await api('POST', `/pages/${id}/publish`, { revision: 1 }), 'publish');
                refused(await api('POST', `/pages/${id}/unpublish`, {}), 'unpublish');
                refused(await api('POST', `/pages/${id}/schedule`, { revision: 1, run_at: new Date(Date.now() + 3600e3).toISOString() }), 'schedule');
                refused(await api('POST', `/pages/${id}/revert`, { to_revision: 1, expected_revision: 1 }), 'revert');
                refused(await api('POST', `/pages/${id}/revisions/1/citations`, { citations: cite }), 'citations');
                refused(await api('POST', `/pages/${id}/revisions/1/review`, { decision: 'approve' }), 'review');
                refused(await api('POST', `/pages/${id}/media`, { media_id: 'med_01J00000000000000000000000' }), 'media');
                refused(await api('POST', `/pages/${id}/media/verify`, {}), 'media verify');
            }
            refused(await api('PATCH', '/spaces/ann-space', { name: 'pwned', visibility: 'private' }), 'PATCH space');
            refused(await api('PUT', `/spaces/ann-space/roles/${bob.subject}`, { role: 'owner' }), 'grant self owner');
            refused(await api('PUT', `/spaces/ann-space/roles/${ann.subject}`, { role: 'viewer' }), 'demote Ann');
            refused(await api('POST', '/spaces/ann-space/pages', { title: 'Bob in Ann', body: H.LONG, citations: cite }), 'create in Ann\'s space');
            refused(await api('POST', '/spaces/ann-space/import', { pages: [{ title: 'x', body: H.LONG }] }), 'import');
            refused(await api('POST', `/proposals/${proposalId}/review`, { decision: 'approve' }), 'review Ann\'s proposal');
            refused(await api('GET', `/pages/${annPrivate.id}`), 'read the private page');
            refused(await api('GET', `/proposals/${proposalId}`), 'read Ann\'s proposal');
            await same(before, 'API');
        });

        await check('forms: Bob cannot post to Ann\'s pages, nor reach them through his own space\'s slug', async () => {
            const before = await snapshot();
            for (const sp of ['ann-space', 'bob-space']) {
                for (const slug of ['ann-page', 'ann-private']) {
                    refused(await form(`/w/${sp}/${slug}/edit`, { body: `${H.LONG} pwned`, summary: 'x', expected_revision: '1' }), `edit ${sp}/${slug}`);
                    refused(await form(`/w/${sp}/${slug}/settings`, { visibility: 'public', title: 'pwned' }), `settings ${sp}/${slug}`);
                    refused(await form(`/w/${sp}/${slug}/revert`, { to: '1' }), `revert ${sp}/${slug}`);
                    refused(await form(`/w/${sp}/${slug}/review`, { decision: 'approve', revision: '1' }), `review ${sp}/${slug}`);
                }
            }
            refused(await form('/s/ann-space/settings', { name: 'pwned', visibility: 'private' }), 'space settings');
            refused(await form('/s/ann-space/new', { title: 'Bob in Ann', body: H.LONG }), 'new page in Ann\'s space');
            refused(await form('/s/ann-space/import', { bundle: '{}' }), 'import form');
            refused(await form(`/proposals/${proposalId}`, { decision: 'approve' }), 'proposal form');
            await same(before, 'forms');
            const r = await H.req(h, 'GET', '/w/bob-space/ann-private', { cookie: H.cookieFor(bobTok) });
            assert.strictEqual(r.status, 404, 'Ann\'s slug under Bob\'s space is not her page');
        });

        await check('controls: Ann can do what Bob could not', async () => {
            assert.strictEqual((await api('PATCH', '/spaces/ann-space', { name: 'Ann Space 2' }, annTok)).status, 200);
            const f = await form('/s/ann-space/settings', { name: 'Ann Space 3', visibility: 'public' }, annTok);
            assert.ok([200, 303].includes(f.status), `the settings form works for its owner: ${f.status} ${f.text.slice(0, 160)}`);
            assert.strictEqual((await h.db.prepare("SELECT name FROM wiki_spaces WHERE slug = 'ann-space'").get()).name, 'Ann Space 3');
            assert.strictEqual((await api('GET', `/pages/${annPrivate.id}`, undefined, annTok)).status, 200);
            const cur = (await h.db.prepare('SELECT max(number) AS n FROM wiki_page_revisions WHERE entity_id = ?').get(annPage.id)).n;
            const r = await api('POST', `/pages/${annPage.id}/revisions`, { expected_revision: cur, body: `${H.LONG} by ann`, citations: cite }, annTok);
            assert.ok([200, 201].includes(r.status), `${r.status} ${r.text.slice(0, 200)}`);
        });
    } finally {
        await h.stop();
    }
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nsecurity-idor: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
