'use strict';
/**
 * Permissions: space roles (owner/editor/viewer), visibility (public/members/private), visitors
 * without SSO read public content only, service tokens are judged on one capability per route and
 * act for the person in X-OV-Subject, AI proposals need a person's approval before publication.
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    const h = await H.boot();
    const owner = H.subject(), editor = H.subject(), viewer = H.subject(), stranger = H.subject(), staff = H.subject();
    const tok = (sub, role = 'user') => H.userToken({ subject: sub, role });
    try {
        // A person creates a user space over the API; they become its owner.
        let r = await H.req(h, 'POST', '/api/v1/spaces', { token: tok(owner), body: { name: 'Garden', slug: 'garden', visibility: 'public' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.space.kind, 'user');
        // Anonymous visitors cannot create spaces; a normal user cannot create an official one.
        r = await H.req(h, 'POST', '/api/v1/spaces', { body: { name: 'Nope' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.headers.get('content-type'), 'application/problem+json');
        assert.strictEqual(r.json.code, 'wiki.person_required');
        r = await H.req(h, 'POST', '/api/v1/spaces', { token: tok(stranger), body: { name: 'Official?', kind: 'official' } });
        assert.strictEqual(r.status, 403);
        r = await H.req(h, 'POST', '/api/v1/spaces', { token: tok(staff, 'admin'), body: { name: 'Handbook', slug: 'handbook', kind: 'official' } });
        assert.strictEqual(r.status, 201);
        // A bad Bearer token is refused, never downgraded to anonymous.
        r = await H.req(h, 'GET', '/api/v1/spaces', { token: 'not.a.jwt' });
        assert.strictEqual(r.status, 401);
        r = await H.req(h, 'GET', '/api/v1/spaces', { token: H.userToken({ issuer: 'https://evil.example' }) });
        assert.strictEqual(r.status, 401);

        // Roles: only the owner grants them.
        r = await H.req(h, 'PUT', `/api/v1/spaces/garden/roles/${editor}`, { token: tok(stranger), body: { role: 'editor' } });
        assert.strictEqual(r.status, 403);
        r = await H.req(h, 'PUT', `/api/v1/spaces/garden/roles/${editor}`, { token: tok(owner), body: { role: 'editor' } });
        assert.strictEqual(r.status, 200);
        r = await H.req(h, 'PUT', `/api/v1/spaces/garden/roles/${viewer}`, { token: tok(owner), body: { role: 'viewer' } });
        assert.strictEqual(r.status, 200);
        r = await H.req(h, 'PUT', `/api/v1/spaces/garden/roles/${owner}`, { token: tok(owner), body: { role: 'editor' } });
        assert.strictEqual(r.status, 409, 'the last owner cannot step down');

        // Editors write; strangers and viewers do not.
        const page = { title: 'Tomatoes', body: H.LONG, citations: [{ url: 'https://example.org/t', retrieved_at: '2026-09-01T00:00:00Z' }] };
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: tok(stranger), body: page });
        assert.strictEqual(r.status, 403);
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: tok(viewer), body: page });
        assert.strictEqual(r.status, 403);
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: tok(editor), body: page });
        assert.strictEqual(r.status, 201, r.text);
        const pageId = r.json.page.id;
        assert.strictEqual(r.json.citations[0].retrieved_at, '2026-09-01T00:00:00.000Z');
        // Viewers cannot publish; editors can.
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok(viewer), body: {} })).status, 403);
        assert.strictEqual((await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok(editor), body: {} })).status, 200);
        // Only owners delete pages or change page visibility.
        assert.strictEqual((await H.req(h, 'DELETE', `/api/v1/pages/${pageId}`, { token: tok(editor) })).status, 403);
        assert.strictEqual((await H.req(h, 'PATCH', `/api/v1/pages/${pageId}`, { token: tok(editor), body: { visibility: 'private' } })).status, 403);

        // Visitors without SSO read public content only.
        assert.strictEqual((await H.req(h, 'GET', `/api/v1/pages/${pageId}`)).status, 200);
        assert.strictEqual((await H.req(h, 'GET', '/w/garden/tomatoes')).status, 200);
        await H.req(h, 'PATCH', '/api/v1/spaces/garden', { token: tok(owner), body: { visibility: 'private' } });
        for (const p of ['/w/garden/tomatoes', '/w/garden/tomatoes/history', '/w/garden/tomatoes.json', '/s/garden']) {
            assert.strictEqual((await H.req(h, 'GET', p)).status, 404, `anonymous ${p}`);
            assert.strictEqual((await H.req(h, 'GET', p, { cookie: H.cookieFor(tok(stranger)) })).status, 404, `stranger ${p}`);
            assert.strictEqual((await H.req(h, 'GET', p, { cookie: H.cookieFor(tok(viewer)) })).status, 200, `viewer ${p}`);
        }
        assert.strictEqual((await H.req(h, 'GET', `/api/v1/pages/${pageId}`)).status, 404);
        assert.ok(!(await H.req(h, 'GET', '/api/v1/spaces')).json.spaces.some((s) => s.slug === 'garden'));
        assert.ok((await H.req(h, 'GET', '/api/v1/spaces', { token: tok(viewer) })).json.spaces.some((s) => s.slug === 'garden'));
        // Staff get no silent access to a private user space.
        assert.strictEqual((await H.req(h, 'GET', '/w/garden/tomatoes', { cookie: H.cookieFor(tok(staff, 'admin')) })).status, 404);
        // A watcher who loses access is not notified.
        h.svc.watch(pageId, { kind: 'user', subject: viewer }, true);
        h.db.prepare('INSERT INTO wiki_watchers (page_id, subject, created_at) VALUES (?, ?, ?)').run(pageId, stranger, Date.now());
        h.svc.editPage(pageId, { expectedRevision: 1, body: `${H.LONG} More.` }, { kind: 'user', subject: editor });
        const watch = H.outbox(h).filter((e) => e.event_type === 'wiki.watch.triggered').pop();
        assert.ok(watch.payload.recipients.includes(viewer));
        assert.ok(!watch.payload.recipients.includes(stranger), 'no notification about a page the person cannot read');
        assert.ok(!watch.payload.recipients.includes(editor), 'the actor is not notified of their own change');
        await H.req(h, 'PATCH', '/api/v1/spaces/garden', { token: tok(owner), body: { visibility: 'public' } });

        // Service tokens: one capability per route, audience openvibe.wiki, acting for X-OV-Subject.
        const svcTok = (cap, aud) => H.serviceToken({ client: 'tools', cap, aud });
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: svcTok(['wiki.page.read']), headers: { 'X-OV-Subject': editor }, body: { ...page, title: 'Beans' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json.code, 'capability.denied');
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: svcTok(['wiki.page.create'], 'openvibe.media'), headers: { 'X-OV-Subject': editor }, body: { ...page, title: 'Beans' } });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json.code, 'token.wrong_audience');
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: svcTok(['wiki.page.create']), body: { ...page, title: 'Beans' } });
        assert.strictEqual(r.status, 403, 'a service writes content only for a named person');
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: svcTok(['wiki.page.create']), headers: { 'X-OV-Subject': stranger }, body: { ...page, title: 'Beans' } });
        assert.strictEqual(r.status, 403, 'the named person must be an editor');
        r = await H.req(h, 'POST', '/api/v1/spaces/garden/pages', { token: svcTok(['wiki.*']), headers: { 'X-OV-Subject': editor }, body: { ...page, title: 'Beans' } });
        assert.strictEqual(r.status, 201, 'a wiki.* grant covers wiki.page.create');
        assert.strictEqual(r.json.revision.author, editor);
        // A service without a subject reads public content only.
        r = await H.req(h, 'GET', `/api/v1/pages/${pageId}`, { token: svcTok(['wiki.page.read']) });
        assert.strictEqual(r.status, 200);
        r = await H.req(h, 'GET', `/api/v1/pages/${pageId}`, { token: svcTok(['wiki.search.query']) });
        assert.strictEqual(r.status, 403);
        r = await H.req(h, 'GET', '/api/v1/search?q=Tomatoes', { token: svcTok(['wiki.search.query']) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.results[0].id, pageId);

        // AI proposals: a service with wiki.revision.propose proposes; nothing publishes until a person approves.
        const ai = H.serviceToken({ client: 'ai', cap: ['wiki.revision.propose', 'wiki.page.read'] });
        const proposal = { space: 'garden', page_id: pageId, body: `${H.LONG} Proposed by a workflow.`, workflow: { id: 'wiki.generate_page', run_id: 'run_01', version: 1 }, citations: [{ url: 'https://example.org/ai', retrieved_at: '2026-09-10T00:00:00Z' }] };
        r = await H.req(h, 'POST', '/api/v1/proposals', { token: tok(editor), body: proposal });
        assert.strictEqual(r.status, 403, 'people do not file AI proposals');
        r = await H.req(h, 'POST', '/api/v1/proposals', { token: ai, body: { ...proposal, workflow: {} } });
        assert.strictEqual(r.status, 400, 'a proposal names its workflow and run');
        r = await H.req(h, 'POST', '/api/v1/proposals', { token: ai, body: proposal });
        assert.strictEqual(r.status, 201, r.text);
        const prop = r.json.proposal;
        assert.strictEqual(prop.status, 'pending');
        assert.strictEqual(r.json.revision.authorship.mode, 'ai');
        const n = prop.revision;
        // Publishing the AI revision without approval is refused (by the Publishing authorship rules).
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok(editor), body: { revision: n } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.code, 'ai_generated_unreviewed');
        // The public page still shows the human revision.
        assert.ok(!(await H.req(h, 'GET', '/w/garden/tomatoes')).text.includes('Proposed by a workflow'));
        // Readers never see an unapproved AI revision, not even through history or ?rev=.
        assert.strictEqual((await H.req(h, 'GET', `/w/garden/tomatoes?rev=${n}`)).status, 404);
        assert.strictEqual((await H.req(h, 'GET', `/w/garden/tomatoes/diff/1/${n}`)).status, 404);
        assert.ok(!(await H.req(h, 'GET', '/w/garden/tomatoes/history')).text.includes(`?rev=${n}"`));
        assert.ok(!(await H.req(h, 'GET', `/api/v1/pages/${pageId}/revisions`)).json.revisions.some((x) => x.number === n));
        // Editors do, labelled as a pending AI proposal.
        const ed = await H.req(h, 'GET', `/w/garden/tomatoes?rev=${n}`, { cookie: H.cookieFor(tok(editor)) });
        assert.strictEqual(ed.status, 200);
        assert.ok(ed.text.includes('AI proposal waiting for a person'));
        assert.ok(ed.text.includes('not yet reviewed by a person'));
        // A service cannot approve (reviews are by people); a viewer cannot either.
        r = await H.req(h, 'POST', `/api/v1/proposals/${prop.id}/review`, { token: H.serviceToken({ client: 'ai', cap: ['wiki.revision.publish'] }), body: { decision: 'approved' } });
        assert.strictEqual(r.status, 403);
        r = await H.req(h, 'POST', `/api/v1/proposals/${prop.id}/review`, { token: tok(viewer), body: { decision: 'approved' } });
        assert.strictEqual(r.status, 403);
        r = await H.req(h, 'POST', `/api/v1/proposals/${prop.id}/review`, { token: tok(editor), body: { decision: 'approved' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.published, true);
        const shown = await H.req(h, 'GET', '/w/garden/tomatoes');
        assert.ok(shown.text.includes('Proposed by a workflow'));
        assert.ok(shown.text.includes('AI-generated'), 'the AI disclosure is shown at the item');
        assert.ok(shown.text.includes('reviewed by a person'));
        const doc = H.outbox(h).filter((e) => e.event_type === 'wiki.index_document.upserted' && e.subject.id === pageId).pop().payload;
        assert.strictEqual(doc.authorship, 'ai_generated');
        assert.ok(doc.provenance.some((p) => p.service === 'ai' && p.type === 'run' && p.id === 'run_01'));
        r = await H.req(h, 'POST', `/api/v1/proposals/${prop.id}/review`, { token: tok(editor), body: { decision: 'rejected' } });
        assert.strictEqual(r.status, 409, 'a proposal is reviewed once');
        // The proposing service can read its proposal's state.
        r = await H.req(h, 'GET', `/api/v1/proposals/${prop.id}`, { token: ai });
        assert.strictEqual(r.json.proposal.status, 'approved');
        assert.strictEqual(r.json.proposal.reviewed_by, editor);

        // Stub-provider output is also held for review; a rejected proposal never publishes.
        r = await H.req(h, 'POST', '/api/v1/proposals', { token: ai, body: { space: 'garden', title: 'Peppers', body: H.LONG, stub_provider: true, workflow: { id: 'wiki.generate_page', run_id: 'run_02' } } });
        assert.strictEqual(r.status, 201);
        const p2 = r.json.proposal;
        r = await H.req(h, 'POST', `/api/v1/proposals/${p2.id}/review`, { token: tok(editor), body: { decision: 'rejected', note: 'not sourced' } });
        assert.strictEqual(r.json.published, false);
        assert.strictEqual(h.svc.pageById(p2.page_id).state, 'draft');
        assert.strictEqual((await H.req(h, 'GET', '/w/garden/peppers')).status, 404);
        console.log('permissions ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
