'use strict';
/**
 * A wiki's default audience for new pages and "apply it to every page" (VISIBILITY-EVERYWHERE
 * rules 1-2, step-5 test). The setting belongs to the wiki's owner on its settings page.
 */
const assert = require('assert');
const H = require('./helpers');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
    const h = await H.boot();
    const alice = { subject: H.subject(), username: 'alice' };
    const sam = { subject: H.subject(), username: 'sam' };
    const tok = (u) => H.userToken({ subject: u.subject, username: u.username, aud: ['openvibe.network', 'openvibe.wiki'] });
    const save = (form) => H.req(h, 'POST', '/s/handbook/settings', { token: tok(alice), form: { op: 'sharing', ...form } });

    await H.req(h, 'POST', '/api/v1/spaces', { token: tok(alice), body: { slug: 'handbook', name: 'Handbook', kind: 'user', visibility: 'public' } });
    const make = async (title) => {
        const r = await H.req(h, 'POST', '/api/v1/spaces/handbook/pages', { token: tok(alice), body: { title, body: H.LONG } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json.page;
    };
    const row = async (id) => await h.db.prepare('SELECT * FROM shares WHERE service = ? AND kind = ? AND resource_id = ?').get('wiki', 'page', id);
    const space = async () => await h.db.prepare("SELECT * FROM wiki_spaces WHERE slug = 'handbook'").get();

    await check('a wiki starts at Everyone; the settings page shows the default and its form', async () => {
        const s = await space();
        assert.strictEqual(s.default_visibility, 'public');
        const page = await H.req(h, 'GET', '/s/handbook/settings', { token: tok(alice) });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert.ok(page.text.includes('New pages') && page.text.includes('name="default_visibility"'));
        assert.ok(/<option value="public" selected>/.test(page.text));
        const form = await H.req(h, 'GET', '/s/handbook/new', { token: tok(alice) });
        assert.ok(/<option value="public" selected>/.test(form.text), 'the new-page form starts at the default');
    });

    await check('the default moves the new-page form and an API create that does not choose', async () => {
        const saved = await save({ default_visibility: 'private' });
        assert.strictEqual(saved.status, 303, saved.text);
        const form = await H.req(h, 'GET', '/s/handbook/new', { token: tok(alice) });
        assert.ok(/<option value="private" selected>/.test(form.text), 'the form starts at Only me');
        const p = await make('Only me by default');
        assert.strictEqual(p.visibility, 'private');
        assert.strictEqual((await row(p.id)).audience, 'private', 'a new page is still a private draft');
        // A per-page choice still wins.
        const q = await H.req(h, 'POST', '/api/v1/spaces/handbook/pages', { token: tok(alice), body: { title: 'Chosen public', body: H.LONG, visibility: 'public' } });
        assert.strictEqual(q.json.page.visibility, 'public');
    });

    await check('apply to all moves the published page and the drafts, and only a published page changes its share row', async () => {
        await save({ default_visibility: 'public' });
        const pub = await make('Published page');
        const pubres = await H.req(h, 'POST', `/api/v1/pages/${pub.id}/publish`, { token: tok(alice), body: {} });
        assert.strictEqual(pubres.status, 200, pubres.text);
        assert.strictEqual((await row(pub.id)).audience, 'public');
        const draft = await make('Still a draft');
        assert.strictEqual((await row(draft.id)).audience, 'private');

        const applied = await save({ default_visibility: 'private', apply: '1' });
        assert.strictEqual(applied.status, 303, applied.text);
        assert.strictEqual((await space()).default_visibility, 'private');
        assert.strictEqual((await h.db.prepare('SELECT visibility FROM wiki_pages WHERE id = ?').get(pub.id)).visibility, 'private');
        assert.strictEqual((await h.db.prepare('SELECT visibility FROM wiki_pages WHERE id = ?').get(draft.id)).visibility, 'private');
        assert.strictEqual((await row(pub.id)).audience, 'private', 'the published page left Everyone at once');
        assert.strictEqual((await row(draft.id)).audience, 'private', 'the draft stays Only me');
        assert.strictEqual((await H.req(h, 'GET', `/w/handbook/${pub.slug}`)).status, 404, 'a stranger no longer reads it');
        assert.strictEqual((await H.req(h, 'GET', `/w/handbook/${pub.slug}`, { token: tok(alice) })).status, 200, 'the owner still does');
        assert.strictEqual((await H.req(h, 'GET', `/w/handbook/${draft.slug}`, { token: tok(sam) })).status, 404, 'the draft was never opened to anyone');
    });

    await check('a non-owner cannot change the default', async () => {
        const r = await H.req(h, 'POST', '/s/handbook/settings', { token: tok(sam), form: { op: 'sharing', default_visibility: 'public' } });
        assert.ok(r.status === 403 || r.status === 404, `${r.status}: ${r.text.slice(0, 120)}`);
        assert.strictEqual((await space()).default_visibility, 'private');
    });

    await h.stop();
    if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
    console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });
