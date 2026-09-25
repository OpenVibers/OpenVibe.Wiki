'use strict';
/**
 * wiki.projects on Network (server/integrations/projects-module.js, Contracts 0.41.0, WS-B task 9):
 * creating a space, granting or removing a role and changing a space mark the people concerned in the
 * same transaction; drain() writes their record (public spaces named, others counted) as the owning
 * service, only when it changed, and clears the mark; viewers and people who never had a space get none.
 */
const assert = require('assert');
const { modules } = require('openvibe-contracts');
const H = require('./helpers');
const { summarize, createProjectsModule } = require('../server/integrations/projects-module');

(async () => {
    const h = await H.boot();
    const ann = H.subject(), bob = H.subject(), cat = H.subject();
    const tok = (sub) => H.userToken({ subject: sub });
    const puts = [];
    const fetchImpl = async (url, opts) => {
        const m = String(url).match(/\/internal\/modules\/wiki\.projects\/(usr_[0-9A-Z]+)$/);
        assert.ok(m && opts.method === 'PUT' && opts.headers.Authorization === 'Bearer stub-token', url);
        puts.push({ subject: m[1], data: JSON.parse(opts.body).data });
        return { ok: true, status: 201, json: async () => ({}) };
    };
    const projects = createProjectsModule({ db: h.db, config: { networkInternalUrl: 'http://network.test' }, tokens: h.platform.tokenClient, fetchImpl, log: H.quiet });
    const dirty = () => h.db.prepare('SELECT subject FROM wiki_module_dirty ORDER BY subject').all().map((r) => r.subject);
    try {
        let r = await H.req(h, 'POST', '/api/v1/spaces', { token: tok(ann), body: { name: 'Garden', slug: 'garden', visibility: 'public' } });
        assert.strictEqual(r.status, 201, r.text);
        r = await H.req(h, 'POST', '/api/v1/spaces', { token: tok(ann), body: { name: 'Diary', slug: 'diary', visibility: 'private' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(dirty(), [ann], 'creating a space marks its owner');
        r = await H.req(h, 'PUT', `/api/v1/spaces/garden/roles/${bob}`, { token: tok(ann), body: { role: 'editor' } });
        assert.strictEqual(r.status, 200, r.text);
        r = await H.req(h, 'PUT', `/api/v1/spaces/garden/roles/${cat}`, { token: tok(ann), body: { role: 'viewer' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(summarize(h.db, ann), { spaces: [{ slug: 'garden', name: 'Garden', role: 'owner' }], private_count: 1 });
        assert.deepStrictEqual(summarize(h.db, bob), { spaces: [{ slug: 'garden', name: 'Garden', role: 'editor' }], private_count: 0 });
        assert.ok(modules.validateData('wiki.projects', summarize(h.db, ann)).valid, 'matches the namespace schema');

        assert.strictEqual(await projects.drain(), 2, 'ann and bob; cat is only a viewer');
        assert.deepStrictEqual(puts.map((p) => p.subject).sort(), [ann, bob].sort());
        assert.deepStrictEqual(dirty(), [], 'every mark cleared');

        // Bob loses his role: he is marked although he is no longer in the space's list.
        r = await H.req(h, 'PUT', `/api/v1/spaces/garden/roles/${bob}`, { token: tok(ann), body: { role: null } });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(dirty().includes(bob));
        await projects.drain();
        assert.deepStrictEqual(puts.at(-1), { subject: bob, data: { spaces: [], private_count: 0 } }, 'his record empties');

        // Renaming the space rewrites its people; a drain with nothing new writes nothing.
        r = await H.req(h, 'PATCH', '/api/v1/spaces/garden', { token: tok(ann), body: { name: 'Big Garden' } });
        assert.ok(r.status === 200, r.text);
        const before = puts.length;
        await projects.drain();
        assert.strictEqual(puts.length, before + 1);
        assert.strictEqual(puts.at(-1).data.spaces[0].name, 'Big Garden');
        h.db.prepare('INSERT INTO wiki_module_dirty (subject, marked_at) VALUES (?, 1)').run(ann);
        await projects.drain();
        assert.strictEqual(puts.length, before + 1, 'unchanged: not written again');
        assert.strictEqual(projects.stats().unchanged >= 2, true);
        console.log('wiki.projects: all checks passed');
    } finally { await h.stop(); }
})().catch((err) => { console.error(err); process.exit(1); });
