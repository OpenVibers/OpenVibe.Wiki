'use strict';
/**
 * The Wiki fetches no URL a user chose (roadmap WS-R task 5, the SSRF class). Citations and links
 * are the URLs people type here; they are stored, rendered as links and checked by OpenVibe.Sources
 * (the citation inspector reads Sources' verdicts), never fetched by the Wiki itself. This suite
 * cites internal addresses in every spelling (loopback, decimal, octal, IPv6, mapped, metadata,
 * private ranges, file:, gopher:), then drives every path that handles citations: create, edit,
 * attach, publish, the page, its sources page, the citation inspector, the API reads, the feeds.
 * The Wiki's outbound fetch (injected, recorded here) must never be asked for any of them.
 * And a ratchet: every file in server/ that makes an outbound request itself is on a reviewed list,
 * with the reason its URLs are configured services and not a user's choice.
 *
 *   node test/security-ssrf.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const INTERNAL = [
    'http://127.0.0.1:3000/internal/admin', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://127.1/', 'http://0.0.0.0/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data/', 'http://[fd00::1]/',
    'http://10.0.0.1/', 'http://192.168.1.1/', 'http://localhost:4001/api', 'file:///etc/passwd', 'gopher://127.0.0.1:6379/_x',
];

(async () => {
    const outbound = [];
    const h = await H.boot({
        env: { OV_SOURCES_INTERNAL_URL: 'http://sources.test', OV_COMMUNITY_INTERNAL_URL: 'http://community.test', OV_MEDIA_INTERNAL_URL: 'http://media.test' },
        fetch: async (url, opts = {}) => { outbound.push(String(url)); return new Response(JSON.stringify({ items: [], verdicts: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); },
    });
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 10).join('\n    ')}`); } };
    try {
        const owner = { kind: 'user', subject: H.subject(), staff: false };
        const tok = H.userToken({ subject: owner.subject, username: 'owner' });
        const space = await h.svc.createSpace({ name: 'Refs', slug: 'refs' }, owner);
        const okCite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
        const page = (await h.svc.createPage(space.id, { title: 'Cited Page', body: `${H.LONG} ${INTERNAL.map((u) => `[x](${u})`).join(' ')}`, citations: okCite }, owner)).page;
        await h.svc.publish(page.id, {}, owner);

        await check('internal citation URLs are refused or stored, never fetched, through every path that handles them', async () => {
            for (const url of INTERNAL) {
                // Through the API (attach to a revision), the service (a new revision) and the edit form.
                await H.req(h, 'POST', `/api/v1/pages/${page.id}/revisions/1/citations`, { token: tok, body: { citations: [{ url, retrieved_at: '2026-09-20T00:00:00Z' }] } });
                try { await h.svc.editPage(page.id, { expectedRevision: h.db.prepare('SELECT max(number) AS n FROM wiki_page_revisions WHERE entity_id = ?').get(page.id).n, body: `${H.LONG} see ${url}`, summary: 'cite', citations: [{ url, retrievedAt: '2026-09-20T00:00:00Z' }] }, owner); } catch { /* refused: fine */ }
            }
            const n = (await h.db.prepare('SELECT max(number) AS n FROM wiki_page_revisions WHERE entity_id = ?').get(page.id)).n;
            try { await h.svc.publish(page.id, { revision: n }, owner); } catch { /* the gate may refuse: fine */ }
            for (const p of ['/w/refs/cited-page', '/w/refs/cited-page/sources', '/w/refs/cited-page/history', `/api/v1/pages/${page.id}`, `/api/v1/pages/${page.id}/revisions/${n}/citations`,
                `/api/v1/pages/${page.id}/revisions/1/citations`, '/feed.atom', '/feed.json', '/llms.txt', '/llms-full.txt', '/sitemaps/pages-1.xml']) {
                await H.req(h, 'GET', p, { cookie: H.cookieFor(tok) });
                await H.req(h, 'GET', p);
            }
            const hit = outbound.filter((u) => INTERNAL.some((i) => u.startsWith(i)) || /127\.0\.0\.1|localhost|169\.254|\[::|2130706433|0x7f|0177|10\.0\.0\.1|192\.168/.test(u));
            assert.deepStrictEqual(hit, [], 'the Wiki fetched a cited URL');
            assert.ok(outbound.every((u) => /^http:\/\/(sources|community|media)\.test\//.test(u)), `only the configured services were called: ${outbound.filter((u) => !/^http:\/\/(sources|community|media)\.test\//.test(u)).join(', ')}`);
        });

        await check('ratchet: every file that makes an outbound request itself is reviewed', () => {
            const REVIEWED = {
                'server/auth/keys.js': 'Network JWKS (configured)',
                'server/auth/session.js': 'Network OAuth token and revoke (configured)',
                'server/integrations/platform.js': 'Community, Sources, Media, VIP (configured)',
                'server/integrations/projects-module.js': 'Network user modules (configured)',
            };
            const root = path.join(__dirname, '..');
            const found = [];
            const walk = (dir) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const f = path.join(dir, e.name);
                    if (e.isDirectory()) walk(f);
                    else if (e.name.endsWith('.js')) {
                        const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                        if (/(^|[^.\w])(fetch|fetchImpl)\(|\bhttps?\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(root, f));
                    }
                }
            };
            walk(path.join(root, 'server'));
            assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: a user-chosen URL goes through openvibe-shared/egress; then add the file here with the reason');
        });
    } finally {
        await h.stop();
    }
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nsecurity-ssrf: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
