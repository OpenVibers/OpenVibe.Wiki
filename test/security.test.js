'use strict';
/**
 * Security regressions: a renamed space's old address stays its redirect; another person cannot
 * claim it (by creating a space or renaming theirs) and serve their pages at the old links.
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    const h = await H.boot();
    const owner = { kind: 'user', subject: H.subject(), staff: false };
    const mallory = { kind: 'user', subject: H.subject(), staff: false };
    try {
        const space = h.svc.createSpace({ name: 'Handbook', slug: 'handbook' }, owner);
        const { page } = h.svc.createPage(space.id, { title: 'Onboarding', body: H.LONG }, owner);
        h.svc.publish(page.id, {}, owner);
        h.svc.updateSpace(space.id, { slug: 'guide' }, owner);

        // Another person cannot take the retired slug, by creating a space or by renaming theirs.
        assert.throws(() => h.svc.createSpace({ name: 'Handbook', slug: 'handbook' }, mallory), (e) => e.status === 409 && e.code === 'space.slug_retired');
        const own = h.svc.createSpace({ name: 'Mine', slug: 'mine' }, mallory);
        assert.throws(() => h.svc.updateSpace(own.id, { slug: 'handbook' }, mallory), (e) => e.status === 409 && e.code === 'space.slug_retired');
        const r = await H.req(h, 'POST', '/api/v1/spaces', { token: H.userToken({ subject: mallory.subject }), body: { name: 'Handbook', slug: 'handbook' } });
        assert.strictEqual(r.status, 409);

        // The old links still lead to the real space and page.
        assert.strictEqual((await H.req(h, 'GET', '/s/handbook')).headers.get('location'), '/s/guide');
        assert.strictEqual((await H.req(h, 'GET', '/w/handbook/onboarding')).headers.get('location'), '/w/guide/onboarding');

        // The space itself may take its old slug back.
        h.svc.updateSpace(space.id, { slug: 'handbook' }, owner);
        assert.strictEqual((await H.req(h, 'GET', '/w/handbook/onboarding')).status, 200);
        console.log('security: ok');
    } finally {
        await h.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
