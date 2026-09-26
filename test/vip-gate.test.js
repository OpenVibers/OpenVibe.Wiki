'use strict';
/**
 * VIP spaces and pages (roadmap WS-K task 8): OpenVibe.VIP decides who may read, before render (cached; the
 * JSON export asks authoritatively); every doubt refuses with a join prompt; roles in the space always
 * read; VIP content never reaches sitemaps, feeds, Search or another viewer's list; official spaces refuse vip.
 */
const assert = require('assert');
const H = require('./helpers');

const OWNER = H.subject();
const MEMBER = H.subject();
const STRANGER = H.subject();
const VIP_URL = 'http://127.0.0.1:4620/api/v1/policies/evaluate';

(async () => {
    // Migration: a database made before `vip` (the old CHECK) is widened in place; rows stay; idempotent.
    {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const { openDb, createStores, widenVisibilityChecks, SCHEMA } = require('../server/db');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vipmig-')), 'wiki.db');
        const old = openDb(file);
        old.exec(SCHEMA.split("CHECK (visibility IN ('public','members','vip','private'))").join("CHECK (visibility IN ('public','members','private'))"));
        old.prepare("INSERT INTO wiki_spaces (id, slug, name, kind, visibility, owner, created_by, created_at, updated_at) VALUES ('spc_1', 'old', 'Old', 'user', 'members', ?, ?, 1, 1)").run(OWNER, OWNER);
        assert.throws(() => old.prepare("UPDATE wiki_spaces SET visibility = 'vip' WHERE id = 'spc_1'").run(), /CHECK constraint/);
        old.close();
        const db = openDb(file);
        createStores(db);
        db.prepare("UPDATE wiki_spaces SET visibility = 'vip' WHERE id = 'spc_1'").run();
        assert.strictEqual(db.prepare("SELECT visibility FROM wiki_spaces WHERE id = 'spc_1'").get().visibility, 'vip', 'widened; the row kept');
        assert.throws(() => db.prepare("UPDATE wiki_spaces SET visibility = 'secret' WHERE id = 'spc_1'").run(), /CHECK constraint/, 'still checked');
        assert.deepStrictEqual(widenVisibilityChecks(db), [], 'idempotent');
        assert.strictEqual(db.pragma('integrity_check', { simple: true }), 'ok');
        db.close();
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }

    const asks = [];
    let vipDown = false;
    const fetch = async (url, opts = {}) => {
        if (url !== VIP_URL) throw new Error(`unexpected outbound fetch ${url}`);
        const b = JSON.parse(opts.body);
        asks.push(b);
        if (vipDown) throw new Error('ECONNREFUSED');
        const allow = b.subject === MEMBER && b.owner === OWNER && b.resource.service === 'wiki' && b.fallback && b.fallback.binding === 'wiki:gated_page';
        return new Response(JSON.stringify({ allow, reason: allow ? 'member' : 'not_member', rule: null, fallback: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const h = await H.boot({ fetch, env: { OV_OAUTH_CLIENT_SECRET: 'x'.repeat(40) } });
    const owner = { kind: 'user', subject: OWNER, staff: false };
    const cookie = (sub) => H.cookieFor(H.userToken({ subject: sub }));
    try {
        const cite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
        const club = h.svc.createSpace({ name: 'Members club', slug: 'club', visibility: 'vip' }, owner);
        const secret = h.svc.createPage(club.id, { title: 'Club secret', body: H.LONG, citations: cite }, owner).page;
        h.svc.publish(secret.id, {}, owner);
        const open = h.svc.createSpace({ name: 'Open notes', slug: 'open' }, owner);
        const perk = h.svc.createPage(open.id, { title: 'Perk page', body: H.LONG, citations: cite, visibility: 'vip' }, owner).page;
        h.svc.publish(perk.id, {}, owner);
        const pub = h.svc.createPage(open.id, { title: 'Public page', body: H.LONG, citations: cite }, owner).page;
        h.svc.publish(pub.id, {}, owner);

        // Anonymous: the join prompt (403, never publicly cached), no body.
        let r = await H.req(h, 'GET', '/w/club/club-secret');
        assert.strictEqual(r.status, 403);
        assert.match(r.text, /For VIP members/);
        assert.match(r.text, /Sign in/);
        assert.ok(!r.text.includes('thin content rule'), 'no body for a non-member');
        assert.match(r.headers.get('cache-control'), /private/);
        assert.strictEqual(asks.length, 0, 'nobody signed in: VIP is not asked');

        // A member: VIP says yes (space resource, the owner, the wiki fallback).
        r = await H.req(h, 'GET', '/w/club/club-secret', { cookie: cookie(MEMBER) });
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes('thin content rule'));
        assert.deepStrictEqual([asks[0].resource, asks[0].owner, asks[0].subject, asks[0].mode], [{ service: 'wiki', type: 'space', id: club.id }, OWNER, MEMBER, undefined]);
        const n = asks.length;
        await H.req(h, 'GET', '/w/club/club-secret', { cookie: cookie(MEMBER) });
        assert.strictEqual(asks.length, n, 'cached');

        // A signed-in stranger: the join prompt with the VIP link.
        r = await H.req(h, 'GET', '/w/club/club-secret', { cookie: cookie(STRANGER) });
        assert.strictEqual(r.status, 403);
        assert.ok(r.text.includes(`https://openvibe.vip/${OWNER}`), 'links to the owner\'s plans');
        assert.strictEqual((await H.req(h, 'GET', '/s/club', { cookie: cookie(STRANGER) })).status, 403);
        assert.strictEqual((await H.req(h, 'GET', '/s/club', { cookie: cookie(MEMBER) })).status, 200);

        // A VIP-only page in a public space is decided on the page.
        r = await H.req(h, 'GET', '/w/open/perk-page', { cookie: cookie(MEMBER) });
        assert.strictEqual(r.status, 200);
        assert.ok(asks.some((a) => a.resource.type === 'page' && a.resource.id === perk.id));
        assert.strictEqual((await H.req(h, 'GET', '/w/open/perk-page')).status, 403);
        r = await H.req(h, 'GET', '/s/open');
        assert.ok(r.text.includes('Public page') && !r.text.includes('Perk page'), 'the tree hides a VIP page from a non-member');
        r = await H.req(h, 'GET', '/s/open', { cookie: cookie(MEMBER) });
        assert.ok(r.text.includes('Perk page'), 'and shows it to a member');

        // The JSON export is sensitive: VIP asks authoritatively, never cached.
        const before = asks.length;
        r = await H.req(h, 'GET', '/w/club/club-secret.json', { cookie: cookie(MEMBER) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(asks.length, before + 1);
        assert.strictEqual(asks[asks.length - 1].mode, 'authoritative');

        // The owner reads without asking VIP; the API honours the same gate.
        const ownerAsks = asks.length;
        assert.strictEqual((await H.req(h, 'GET', '/w/club/club-secret', { cookie: cookie(OWNER) })).status, 200);
        assert.strictEqual(asks.length, ownerAsks, 'a role in the space never asks VIP');
        assert.strictEqual((await H.req(h, 'GET', `/api/v1/pages/${secret.id}`, { token: H.userToken({ subject: MEMBER }) })).status, 200);
        assert.strictEqual((await H.req(h, 'GET', `/api/v1/pages/${secret.id}`, { token: H.userToken({ subject: STRANGER }) })).status, 404);

        // Lists: the member sees the VIP space on the home page; others do not.
        assert.ok((await H.req(h, 'GET', '/', { cookie: cookie(MEMBER) })).text.includes('/s/club'));
        assert.ok(!(await H.req(h, 'GET', '/', { cookie: cookie(STRANGER) })).text.includes('/s/club'));
        assert.ok(!(await H.req(h, 'GET', '/')).text.includes('/s/club'));

        // Never in sitemaps, feeds or Search; its events say vip.
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('club-secret'));
        assert.ok(!(await H.req(h, 'GET', '/feed.atom')).text.includes('club-secret'));
        assert.ok(!(await H.req(h, 'GET', '/sitemaps/pages-1.xml')).text.includes('perk-page'));
        const evs = H.outbox(h);
        assert.ok(!evs.some((e) => e.event_type === 'wiki.index_document.upserted' && (e.subject.id === secret.id || e.subject.id === perk.id)), 'no Search document');
        assert.ok(evs.some((e) => e.event_type === 'wiki.page.published' && e.subject.id === secret.id && e.payload.visibility === 'vip'));

        // VIP down: fail closed.
        vipDown = true;
        const outage = H.subject();
        r = await H.req(h, 'GET', '/w/club/club-secret', { cookie: cookie(outage) });
        assert.strictEqual(r.status, 403);
        vipDown = false;

        // Official spaces have no VIP owner.
        assert.throws(() => h.svc.createSpace({ name: 'Staff club', slug: 'staff-club', kind: 'official', visibility: 'vip' }, { kind: 'system', service: 'svc:wiki' }), /no VIP owner/);
    } finally {
        await h.stop();
    }
    console.log('vip gate: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
