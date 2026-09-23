'use strict';
/**
 * Third-party principals: a developer app (app:…) or module (mod:…) token acts only for the person
 * in its on_behalf_of claim. X-OV-Subject naming anyone else is refused (403 subject.not_delegated),
 * and so are sandbox tokens (401 token.sandbox_refused). First-party services (svc:…) still name the
 * person they act for, and only they may act as themselves to create official spaces.
 */
const assert = require('assert');
const H = require('./helpers');

const APP = 'app:app_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const MOD = 'mod:mod_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const CAPS = ['wiki.space.create', 'wiki.page.create', 'wiki.page.read'];

(async () => {
    const h = await H.boot();
    const victim = H.subject();
    const appUser = H.subject();
    const token = (sub, actorType, extra) => H.serviceToken({ sub, actorType, cap: CAPS, extra });
    try {
        const victimTok = H.userToken({ subject: victim });
        let r = await H.req(h, 'POST', '/api/v1/spaces', { token: victimTok, body: { name: 'Private notes', slug: 'victim-notes', visibility: 'private' } });
        assert.strictEqual(r.status, 201, r.text);
        r = await H.req(h, 'POST', '/api/v1/spaces/victim-notes/pages', { token: victimTok, body: { title: 'Secret', body: H.LONG } });
        assert.strictEqual(r.status, 201, r.text);
        const secretId = r.json.page.id;

        // An app or module cannot name the victim in X-OV-Subject, with or without its own on_behalf_of.
        for (const [sub, type] of [[APP, 'app'], [MOD, 'mod']]) {
            for (const extra of [{ on_behalf_of: appUser }, {}]) {
                r = await H.req(h, 'POST', '/api/v1/spaces/victim-notes/pages', { token: token(sub, type, extra), headers: { 'X-OV-Subject': victim }, body: { title: `Planted ${type}`, body: H.LONG } });
                assert.strictEqual(r.status, 403, `${type} ${JSON.stringify(extra)}: ${r.text}`);
                assert.strictEqual(r.json.code, 'subject.not_delegated');
                r = await H.req(h, 'GET', `/api/v1/pages/${secretId}`, { token: token(sub, type, extra), headers: { 'X-OV-Subject': victim } });
                assert.strictEqual(r.status, 403, `${type} read as the victim`);
            }
        }
        assert.strictEqual(h.db.prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE title LIKE 'Planted%'").get().n, 0);

        // An app acts for its on_behalf_of person (the header is optional and must match).
        const appTok = token(APP, 'app', { on_behalf_of: appUser });
        r = await H.req(h, 'POST', '/api/v1/spaces', { token: appTok, body: { name: 'App user space', slug: 'app-user' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(h.svc.findSpace('app-user').owner, appUser);
        r = await H.req(h, 'POST', '/api/v1/spaces/app-user/pages', { token: appTok, headers: { 'X-OV-Subject': appUser }, body: { title: 'Mine', body: H.LONG } });
        assert.strictEqual(r.status, 201, r.text);
        r = await H.req(h, 'GET', `/api/v1/pages/${secretId}`, { token: appTok });
        assert.strictEqual(r.status, 404, 'the app user has no access to the victim\'s private space');

        // Sandbox app tokens are refused.
        r = await H.req(h, 'POST', '/api/v1/spaces', { token: token(APP, 'app', { on_behalf_of: appUser, env: 'sandbox' }), body: { name: 'Sandbox', slug: 'sandbox-space' } });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json.code, 'token.sandbox_refused');

        // Only a first-party service acting as itself creates an official space; an app never does.
        r = await H.req(h, 'POST', '/api/v1/spaces', { token: token(APP, 'app', {}), body: { name: 'Official by app', slug: 'app-official', kind: 'official' } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'space.official_staff_only');
        r = await H.req(h, 'POST', '/api/v1/spaces', { token: H.serviceToken({ client: 'tools', cap: CAPS }), body: { name: 'Official', slug: 'svc-official', kind: 'official' } });
        assert.strictEqual(r.status, 201, r.text);

        // First-party services still name the person they act for.
        r = await H.req(h, 'POST', '/api/v1/spaces/victim-notes/pages', { token: H.serviceToken({ client: 'tools', cap: CAPS }), headers: { 'X-OV-Subject': victim }, body: { title: 'For the owner', body: H.LONG } });
        assert.strictEqual(r.status, 201, r.text);
        console.log('delegation: ok');
    } finally {
        await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
