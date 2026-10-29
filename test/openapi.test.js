'use strict';
/**
 * /openapi.json documents this service's API, and the document is the API: every route it lists is a
 * route the app mounts, and every /api/v1 route the app mounts is listed. The test walks the real
 * router stack (the same arrays server/http/api.js mounts) rather than trusting the table in
 * server/http/openapi.js, so a route added, renamed or removed without the document fails here.
 */
const assert = require('assert');
const H = require('./helpers');
const { routes, MOUNT } = require('../server/http/openapi');

/** The path an app.use(...) layer mounts its router at, decoded from Express's compiled regexp. */
function mountOf(layer) {
    const source = String((layer.regexp && layer.regexp.source) || '');
    if (layer.regexp && layer.regexp.fast_slash) return '';
    const m = /^\^(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
    assert.ok(m, `cannot read the mount path of a router layer (${source})`);
    return m[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
}

/** ":param" as OpenAPI writes it, "{param}". */
const templated = (p) => String(p).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

/** Every "METHOD /path" the app answers, routers included. */
function mounted(app) {
    const out = new Set();
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                for (const [method, on] of Object.entries(layer.route.methods)) {
                    if (!on || method === '_all') continue;
                    for (const p of [].concat(layer.route.path)) out.add(`${method.toUpperCase()} ${prefix}${templated(p)}`);
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountOf(layer));
            }
        }
    };
    assert.ok(app._router && app._router.stack, 'the app has a router');
    walk(app._router.stack, '');
    return out;
}

(async () => {
    const h = await H.boot();
    try {
        const r = await H.req(h, 'GET', '/openapi.json');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
        assert.ok(r.json, 'the response is JSON');

        const doc = r.json;
        assert.strictEqual(doc.openapi, '3.1.0');
        assert.ok(doc.paths && typeof doc.paths === 'object', 'paths is an object');
        const documented = Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`)).sort();
        assert.ok(documented.length > 0, 'paths is not empty');
        for (const key of Object.keys(doc.paths)) {
            assert.ok(key.startsWith('/api/'), `${key} is outside /api`);
            for (const op of Object.values(doc.paths[key])) {
                assert.ok(op.operationId, `${key} has an operationId`);
                assert.ok(op.responses && Object.keys(op.responses).length, `${key} describes its responses`);
            }
        }

        // The document is the routes the app mounts: nothing advertised that is not there…
        const live = mounted(h.app);
        for (const key of documented) {
            assert.ok(live.has(key), `${key} is documented but not mounted`);
        }
        // …and nothing mounted under the API that the document leaves out.
        const api = [...live].filter((key) => key.endsWith(` ${MOUNT}/openapi.json`) === false && key.split(' ')[1].startsWith(`${MOUNT}/`)).sort();
        assert.deepStrictEqual(documented, api, 'every /api/v1 route is documented and vice versa');
        assert.deepStrictEqual(routes(), documented, 'server/http/openapi.js routes() and the document agree');

        // The prefix redirect a site using /api/v1 answers.
        const redirect = await H.req(h, 'GET', '/api/v1/openapi.json');
        assert.strictEqual(redirect.status, 308);
        assert.strictEqual(redirect.headers.get('location'), '/openapi.json');
    } finally {
        await h.stop();
    }
    console.log('openapi: /openapi.json documents exactly the mounted /api/v1 routes');
})().catch((err) => { console.error(err); process.exitCode = 1; });
