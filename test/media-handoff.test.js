'use strict';
/**
 * Media permissions survive the author/editor handoff (the model is documented at attachMedia in
 * server/wiki/service.js):
 *   author A attaches an object A can read → editor B revises, reverts and publishes (the attachment
 *   stays, B needs no rights on it) → B cannot attach an object only A can read (the same answer as
 *   an unknown id), and not even A can attach a private one → Media deletes one object and makes the
 *   other private → the public page shows the explicit broken / withheld state, never the image, and
 *   the image comes back when Media shares the object again.
 */
const assert = require('assert');
const H = require('./helpers');

const MED = (n) => `med_01J8Z6Q3KX0000000000000${String(n).padStart(3, '0')}`;

(async () => {
    const A = H.subject();
    const B = H.subject();
    const C = H.subject();
    // Media's view of the namespace; tests change it as Media would.
    const objects = new Map([
        [MED(1), { visibility: 'public', owner: A, lifecycle_status: 'ready' }], // A's picture
        [MED(2), { visibility: 'unlisted', owner: C, lifecycle_status: 'ready' }], // someone else's, shared by link
        [MED(3), { visibility: 'private', owner: A, lifecycle_status: 'ready' }], // only A can read it
        [MED(4), { visibility: 'public', owner: A, lifecycle_status: 'pending' }], // upload not finished
    ]);
    let mediaUp = true;
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fetchStub = async (url) => {
        const u = new URL(url);
        if (u.host !== 'media.internal') return json(404, { error: 'stub: no route' });
        if (!mediaUp) throw new Error('ECONNREFUSED');
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const o = objects.get(id);
        if (!o) return json(404, { code: 'media.object.not_found' });
        return json(200, { id, visibility: o.visibility, owner: { subject: o.owner, app: 'wiki', user_id: null }, lifecycle_status: o.lifecycle_status });
    };
    const h = await H.boot({ fetch: fetchStub, env: { OV_MEDIA_INTERNAL_URL: 'http://media.internal' } });
    const tokA = H.userToken({ subject: A });
    const tokB = H.userToken({ subject: B });
    const attach = (token, pageId, mediaId, extra = {}) => H.req(h, 'POST', `/api/v1/pages/${pageId}/media`, { token, body: { media_id: mediaId, alt: `alt ${mediaId.slice(-3)}` }, ...extra });
    const imgOf = (id) => `<img src="https://openvibe.media/o/${id}"`;
    try {
        // A's space; B is an editor.
        let r = await H.req(h, 'POST', '/api/v1/spaces', { token: tokA, body: { name: 'Handoff', slug: 'handoff' } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual((await H.req(h, 'PUT', `/api/v1/spaces/handoff/roles/${B}`, { token: tokA, body: { role: 'editor' } })).status, 200);
        r = await H.req(h, 'POST', '/api/v1/spaces/handoff/pages', { token: tokA, body: { title: 'Gallery', body: H.LONG } });
        const pageId = r.json.page.id;
        await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tokA, body: {} });

        // 1. Author A attaches an object A owns and one shared by link; both are checked as A.
        r = await attach(tokA, pageId, MED(1));
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.attachment.state, 'available');
        assert.strictEqual(r.json.attachment.attached_by, A);
        assert.strictEqual((await attach(tokA, pageId, MED(2))).status, 201, 'unlisted objects are readable by anyone with the id');
        const origins = h.db.prepare('SELECT media_id, attached_by, media_owner, media_visibility FROM wiki_attachment_origins WHERE page_id = ? ORDER BY attachment_id').all(pageId);
        assert.deepStrictEqual(origins, [
            { media_id: MED(1), attached_by: A, media_owner: A, media_visibility: 'public' },
            { media_id: MED(2), attached_by: A, media_owner: C, media_visibility: 'unlisted' },
        ]);
        assert.throws(() => h.db.prepare('UPDATE wiki_attachment_origins SET attached_by = ?').run(B), /immutable/);
        r = await attach(tokA, pageId, MED(4));
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.code, 'media.not_ready');

        // 2. Editor B revises, publishes and reverts: the attachments stay, nothing is re-attached.
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/revisions`, { token: tokB, body: { expected_revision: 1, body: `${H.LONG} Edited by B.` } });
        assert.strictEqual(r.status, 201, r.text);
        await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tokB, body: {} });
        let page = await H.req(h, 'GET', '/w/handoff/gallery');
        assert.ok(page.text.includes('Edited by B.'));
        assert.ok(page.text.includes(imgOf(MED(1))) && page.text.includes(imgOf(MED(2))), 'the attachments carry over to B\'s revision');
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/revert`, { token: tokB, body: { to_revision: 1, expected_revision: 2 } });
        assert.strictEqual(r.status, 201, r.text);
        r = await H.req(h, 'GET', `/api/v1/pages/${pageId}`, { token: tokB });
        assert.deepStrictEqual(r.json.attachments.map((a) => [a.media_id, a.attached_by, a.state]), [[MED(1), A, 'available'], [MED(2), A, 'available']]);
        assert.strictEqual(h.db.prepare('SELECT COUNT(*) AS n FROM wiki_page_attachments WHERE entity_id = ?').get(pageId).n, 2);

        // 3. B cannot attach an object only A can read — the same answer as an id that does not exist.
        const refused = await attach(tokB, pageId, MED(3));
        const unknown = await attach(tokB, pageId, MED(999));
        assert.strictEqual(refused.status, 422);
        assert.strictEqual(refused.json.code, 'media.not_readable');
        assert.deepStrictEqual([unknown.status, unknown.json.code, unknown.json.detail], [refused.status, refused.json.code, refused.json.detail], 'a private id is not confirmed to exist');
        // …nor through a service acting for B, nor through the page settings form.
        const svcTok = H.serviceToken({ client: 'ai', cap: ['wiki.page.create'] });
        r = await attach(svcTok, pageId, MED(3), { headers: { 'X-OV-Subject': B } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json.code, 'media.not_readable');
        r = await H.req(h, 'POST', '/w/handoff/gallery/settings', { cookie: H.cookieFor(tokB), form: { op: 'attach', media_id: MED(3) } });
        assert.strictEqual(r.status, 422);
        assert.ok(r.text.includes('No OpenVibe.Media object you can read has that id'));
        // Its owner can read it, but a page shows media to every reader: private objects are never attached.
        r = await attach(tokA, pageId, MED(3));
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.code, 'media.private');
        // No person, no attachment (a service acting as itself has no rights in the space); a Media
        // outage attaches nothing unchecked.
        r = await attach(H.serviceToken({ client: 'ai', cap: ['wiki.page.create'] }), pageId, MED(1));
        assert.strictEqual(r.status, 403);
        await assert.rejects(h.svc.attachMedia(pageId, { mediaId: MED(1) }, { kind: 'service', service: 'svc:ai', subject: null }, { describe: h.platform.media.describe }), (e) => e.status === 403);
        mediaUp = false;
        r = await attach(tokA, pageId, MED(1));
        assert.strictEqual(r.status, 503);
        mediaUp = true;
        await assert.rejects(h.svc.attachMedia(pageId, { mediaId: MED(1) }, { kind: 'user', subject: A }, {}), (e) => e.status === 503, 'no Media configured: nothing is attached');
        assert.strictEqual(h.db.prepare('SELECT COUNT(*) AS n FROM wiki_page_attachments WHERE entity_id = ?').get(pageId).n, 2, 'nothing refused was attached');

        // 4. Media deletes one object and makes the other private: after the check, the public page
        //    shows the explicit states and no image.
        objects.get(MED(1)).visibility = 'private';
        objects.get(MED(2)).lifecycle_status = 'deleted';
        r = await H.req(h, 'POST', '/w/handoff/gallery/settings', { cookie: H.cookieFor(tokB), form: { op: 'verify' } });
        assert.strictEqual(r.status, 303);
        assert.ok(decodeURIComponent(r.headers.get('location')).includes('0 available, 2 broken'));
        page = await H.req(h, 'GET', '/w/handoff/gallery');
        assert.strictEqual(page.status, 200);
        assert.ok(!page.text.includes(imgOf(MED(1))) && !page.text.includes(imgOf(MED(2))), 'no image for a withheld or deleted object');
        assert.ok(page.text.includes('This media is no longer shared publicly in OpenVibe.Media, so it is not shown here.'));
        assert.ok(page.text.includes('This media was deleted from OpenVibe.Media and is no longer available.'));
        const pj = (await H.req(h, 'GET', '/w/handoff/gallery.json')).json;
        assert.deepStrictEqual(pj.attachments.map((a) => [a.state, a.broken_reason]), [['broken', 'forbidden'], ['broken', 'deleted']]);

        // 5. Shared again in Media: the next check shows it again.
        objects.get(MED(1)).visibility = 'public';
        await H.req(h, 'POST', `/api/v1/pages/${pageId}/media/verify`, { token: tokA, body: {} });
        page = await H.req(h, 'GET', '/w/handoff/gallery');
        assert.ok(page.text.includes(imgOf(MED(1))));
        assert.ok(!page.text.includes(imgOf(MED(2))));
        console.log('media handoff ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
