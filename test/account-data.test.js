'use strict';
/**
 * ADR-033: Wiki's part of an account export and of an account deletion, through the signed loopback route
 * POST /internal/events with a stand-in Network. Alice owns a user space with a published page; she also edits and
 * watches a page in Bob's space, where she holds the editor role. Her export carries her spaces, pages, revisions and
 * roles. Her deletion deletes her own space (as its owner would), removes her role, watch and drafts, leaves her
 * revision in Bob's space without her id (the text unchanged), keeps reviews, and confirms once. The append-only rows
 * refuse any other change, even inside the erasure.
 */
const assert = require('assert');
const http = require('http');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const H = require('./helpers');

const SECRET = `whsec_${'fixture'.repeat(6)}`;

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_wiki', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}`); }
}

(async () => {
    const stub = await startNetworkStub();
    const h = await H.boot({ env: { WIKI_EVENTS_SECRET: SECRET, OV_OAUTH_CLIENT_SECRET: 'wiki-secret' }, accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'wiki', clientSecret: 'wiki-secret' }) });
    const alice = { kind: 'user', subject: H.subject() };
    const bob = { kind: 'user', subject: H.subject() };
    const db = h.db;
    const count = async (sql, args) => Number(await db.value(sql, args));
    const deliver = async (event, { secret = SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${h.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
    let mine;
    let theirs;
    let bobsPage;

    try {
        await check('alice\'s own space and page, and her edit, role and watch in bob\'s space', async () => {
            mine = await h.svc.createSpace({ name: 'Alice notes', slug: 'alice-notes' }, alice);
            const { page } = await h.svc.createPage(mine.id, { title: 'Hello', body: `Mine ${H.LONG}`, citations: [{ url: 'https://example.org/a', title: 'A source', retrievedAt: '2026-09-01' }] }, alice);
            await h.svc.publish(page.id, {}, alice);
            theirs = await h.svc.createSpace({ name: 'Bob guide', slug: 'bob-guide' }, bob);
            bobsPage = (await h.svc.createPage(theirs.id, { title: 'Guide', body: `Bob wrote this ${H.LONG}` }, bob)).page;
            await h.svc.setRole(theirs.id, alice.subject, 'editor', bob);
            await h.svc.loadRoles(alice);
            alice.wikiRoles = null;
            await h.svc.editPage(bobsPage.id, { expectedRevision: 1, title: 'Guide', body: `Bob wrote this, Alice improved it ${H.LONG}`, citations: [{ url: 'https://example.org/b', title: 'B source', retrievedAt: '2026-09-02' }] }, alice);
            await h.svc.watch(bobsPage.id, alice, true);
            assert.strictEqual(await count('SELECT count(*) FROM wiki_page_revisions WHERE author = $1', [alice.subject]), 2);
        });

        await check('the export carries her spaces, pages, revisions, roles and watches, and nothing of bob\'s', async () => {
            const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: alice.subject }));
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'exported'], JSON.stringify(r.json));
            const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
            assert.strictEqual(part.auth, 'Bearer tok_wiki');
            const names = part.body.files.map((f) => f.name).sort();
            assert.deepStrictEqual(names, ['pages.json', 'revisions.json', 'roles.json', 'spaces.json', 'watching.json']);
            assert.ok(!JSON.stringify(part.body).includes(bob.subject));
        });

        await check('the deletion deletes her own space, removes her role and watch, leaves her edit authorless, and confirms once', async () => {
            const event = ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: alice.subject });
            const r = await deliver(event);
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'erased'], JSON.stringify(r.json));
            const space = await db.maybe('SELECT owner, created_by, deleted_at FROM wiki_spaces WHERE id = $1', [mine.id]);
            assert.ok(space.deleted_at, 'her space is deleted');
            assert.deepStrictEqual([space.owner, space.created_by], ['deleted', 'deleted']);
            assert.strictEqual((await H.req(h, 'GET', '/s/alice-notes')).status, 410, 'and answers Gone');
            assert.strictEqual(await count('SELECT count(*) FROM wiki_permissions WHERE subject = $1', [alice.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM wiki_watchers WHERE subject = $1', [alice.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM wiki_page_revisions WHERE author = $1', [alice.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM wiki_citations WHERE attached_by = $1', [alice.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM wiki_module_dirty WHERE subject = $1', [alice.subject]), 0);
            const edit = await db.maybe('SELECT author, content FROM wiki_page_revisions WHERE entity_id = $1 AND number = 2', [bobsPage.id]);
            assert.strictEqual(edit.author, null);
            assert.ok(edit.content.includes('Alice improved it'), 'the text never changes');
            assert.strictEqual(await count('SELECT count(*) FROM wiki_spaces WHERE id = $1 AND deleted_at IS NULL AND owner = $2', [theirs.id, bob.subject]), 1, 'bob\'s space stays');
            const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
            assert.strictEqual(conf.length, 1);
            assert.strictEqual(conf[0].body.erased.wiki_spaces, 1);
            assert.strictEqual(conf[0].body.erased.wiki_permissions, 2, 'her owner row in her own space and her editor role in bob\'s');
            assert.ok(conf[0].body.retained.tombstones >= 4);
            assert.strictEqual((await deliver(event)).json.outcome, 'unchanged');
            assert.strictEqual(stub.calls.filter((c) => c.url.includes('/confirmations')).length, 1);
        });

        await check('revisions and citations stay append-only: outside the erasure nothing changes, inside it only the id', async () => {
            await assert.rejects(db.exec('UPDATE wiki_page_revisions SET author = NULL WHERE entity_id = $1 AND number = 1', [bobsPage.id]), /immutable/);
            await assert.rejects(db.tx(async (tx) => {
                await tx.value("SELECT set_config('wiki.account_erasure', 'on', true)");
                await tx.exec("UPDATE wiki_page_revisions SET content = 'rewritten', author = NULL WHERE entity_id = $1 AND number = 1", [bobsPage.id]);
            }), /immutable/);
            await assert.rejects(db.tx(async (tx) => {
                await tx.value("SELECT set_config('wiki.account_erasure', 'on', true)");
                await tx.exec("UPDATE wiki_citations SET url = 'https://evil.example/', attached_by = NULL WHERE entity_id = $1", [bobsPage.id]);
            }), /immutable/);
        });

        await check('the route refuses a bad signature and a request that came through a proxy', async () => {
            const event = ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX2', subject: alice.subject });
            assert.strictEqual((await deliver(event, { secret: `whsec_${'mismatch'.repeat(5)}` })).status, 401);
            assert.strictEqual((await deliver(event, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
        });
    } finally {
        await h.stop();
        await stub.close();
    }
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})();
