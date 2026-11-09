'use strict';
/**
 * Rich wiki articles (W1): bodies are Markdown plus blocks (infobox, figure, gallery, timeline, quote,
 * callout, stat), the API takes and returns blocks, and the two AI features — the wiki.article.images
 * suggestions and the content.wiki writer — answer through their tasks and file a pending proposal.
 */
const assert = require('assert');
const H = require('./helpers');
require('../server/http/pages'); // the article route this test fetches (the blocks are rendered there)
const { aboutPerson } = require('../server/wiki/images');

const run = (output, extra = {}) => ({ run: { id: 'run_ai_1', status: 'succeeded', output, model: 'stub-model', provider: 'stub', ...extra } });

(async () => {
    const h = await H.boot({
        env: { OV_AI_INTERNAL_URL: 'https://ai.test', OV_PICS_URL: 'https://pics.test' },
        fetch: async (url, init = {}) => {
            const u = new URL(String(url));
            if (u.host === 'ai.test' && u.pathname === '/api/v1/runs') {
                const body = JSON.parse(init.body || '{}');
                if (body.task === 'wiki.article.images') {
                    const provider = (body.input && body.input.providers && body.input.providers[0]) || 'commons';
                    return new Response(JSON.stringify(run({
                        images: [{ url: `https://pictures.test/${provider}.jpg`, source_url: `https://${provider}.test/File:Machine`, title: 'A machine', description: 'A machine in a workshop', author: 'Ada Example', license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', free: true, provider, width: 800, height: 600 }],
                    })), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (body.workflow === 'content.wiki') {
                    return new Response(JSON.stringify({
                        ...run({
                            title: 'Machines', summary: 'A page about machines.',
                            lead: [{ text: `Machines do work. ${H.LONG}`, citations: [0] }],
                            sections: [{ heading: 'History', sentences: [{ text: 'They began with simple tools and grew from there.', citations: [1] }] }],
                            infobox: [{ label: 'Maker', type: 'text', value: 'OpenVibe' }],
                            citations: [0, 1], gaps: [],
                        }),
                        citations: [
                            { ordinal: 0, url: 'https://sources.test/a', title: 'A source', retrieved_at: '2026-11-09T09:00:00.000Z' },
                            { ordinal: 1, url: 'https://sources.test/b', title: 'B source', retrieved_at: '2026-11-09T09:00:00.000Z' },
                        ],
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
            }
            if (u.host === 'pics.test' && u.pathname === '/api/v1/gallery') {
                return new Response(JSON.stringify({ pictures: [{ id: 'pic_1', slug: 'lathe', title: 'A lathe', description: 'A lathe in use', alt: 'A lathe', width: 1200, height: 800, author: 'Bo', links: { page: 'https://pics.test/i/lathe', direct: 'https://pics.test/i/lathe.jpg' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            throw new Error(`unexpected outbound fetch ${url}`);
        },
    });
    const alice = { kind: 'user', subject: H.subject(), staff: false };
    const cookie = H.cookieFor(H.userToken({ subject: alice.subject }));
    try {
        const space = await h.svc.createSpace({ name: 'Machines', slug: 'machines' }, alice);
        const body = ['# Machines', H.LONG,
            ':::infobox{title="Quick facts"}', 'Released: 2026', 'Maker: OpenVibe', ':::',
            ':::callout{tone="tip"}', 'A tip for readers.', ':::',
            ':::timeline{title="History"}', '2025: The first one.', '2026: The second one.', ':::',
            ':::quote{by="Ada"}', 'It works.', ':::',
            ':::stat{value="3" label="machines"}', ':::',
            ':::gallery{items="med_01JAB2C3D4E5F6G7H8J9K0MNPQ"}', ':::'].join('\n\n');
        const made = await h.svc.createPage(space.id, { title: 'Machines', body }, alice);
        const html = await h.svc.renderRevision(space, made.revision, alice);
        for (const cls of ['ov-infobox', 'ov-callout', 'ov-timeline', 'ov-quote', 'ov-stat', 'ov-gallery']) {
            assert.ok(html.includes(`class="${cls}`) || html.includes(`class="ov-media ${cls}`), `${cls} rendered: ${html.slice(0, 200)}`);
        }
        assert.ok(html.includes('data-media-id="med_01JAB2C3D4E5F6G7H8J9K0MNPQ"'), 'a figure names the Media object it wants');

        // The page itself (server/http/pages.js) renders the blocks, and its .json carries the same tree.
        await h.svc.publish(made.page.id, { revision: made.revision.number }, alice);
        const page = await H.req(h, 'GET', `/w/${space.slug}/${made.page.slug}`, { cookie });
        assert.strictEqual(page.status, 200, page.text.slice(0, 300));
        assert.ok(page.text.includes('class="ov-infobox"'), 'the page renders the infobox block');
        assert.ok(page.text.includes('class="ov-stat"'), 'the page renders the stat block');
        const pageJson = await H.req(h, 'GET', `/w/${space.slug}/${made.page.slug}.json`, { cookie });
        assert.strictEqual(pageJson.status, 200);
        assert.strictEqual(pageJson.json.blocks.type, 'root');
        assert.ok(Array.isArray(pageJson.json.blocks.children) && pageJson.json.blocks.children.length > 1);

        // The API takes a block tree and keeps the Markdown it serializes to.
        const tree = { type: 'root', children: [{ type: 'text', value: `# Blocks\n\n${H.LONG}\n\n` }, { type: 'stat', attrs: { value: '2', label: 'blocks' } }] };
        const created = await H.req(h, 'POST', `/api/v1/spaces/${space.slug}/pages`, { cookie, body: { title: 'Blocks', blocks: tree } });
        assert.strictEqual(created.status, 201, created.text);
        assert.ok(created.json.revision.body.includes(':::stat{value="2" label="blocks"}'), created.json.revision.body);
        assert.strictEqual(created.json.blocks.type, 'root');
        const blocksOnly = await H.req(h, 'GET', `/api/v1/pages/${created.json.page.id}?format=blocks`, { cookie });
        assert.strictEqual(blocksOnly.status, 200, blocksOnly.text);
        assert.strictEqual(blocksOnly.json.blocks.type, 'root');
        const bad = await H.req(h, 'POST', `/api/v1/spaces/${space.slug}/pages`, { cookie, body: { title: 'Bad', blocks: { type: 'nope' } } });
        assert.strictEqual(bad.status, 422);
        assert.strictEqual(bad.json.code, 'page.invalid_blocks');

        // A real person never gets an AI illustration: the infobox says so before any image is drawn.
        assert.strictEqual(aboutPerson({ infobox: [{ key: 'born', label: 'Born', type: 'text', value: '1970' }], revision: { fields: { title: 'Ada' }, content: '' } }), true);
        assert.strictEqual(aboutPerson({ infobox: [], revision: { fields: { title: 'A lathe' }, content: 'A lathe turns wood.' } }), false);

        // wiki.article.images: Commons and Openverse first, keeping licence and author; then Pics.
        const suggested = await H.req(h, 'POST', `/api/v1/pages/${made.page.id}/images/suggest`, { cookie, body: { count: 8 } });
        assert.strictEqual(suggested.status, 200, suggested.text);
        assert.strictEqual(suggested.json.task, 'wiki.article.images');
        assert.strictEqual(suggested.json.subject_is_person, false);
        assert.deepStrictEqual([...new Set(suggested.json.suggestions.map((s) => s.provider))].sort(), ['commons', 'openverse', 'pics']);
        const lead = suggested.json.suggestions.find((s) => s.role === 'lead');
        assert.strictEqual(lead.license, 'CC BY-SA 4.0');
        assert.strictEqual(lead.author, 'Ada Example');
        assert.ok(lead.credit.includes('CC BY-SA 4.0'));

        // content.wiki: a draft proposal, pending, with a citation per sentence and the infobox filled.
        const drafted = await H.req(h, 'POST', `/api/v1/pages/${made.page.id}/draft`, { cookie, body: { instruction: 'Add the history' } });
        assert.strictEqual(drafted.status, 201, drafted.text);
        assert.strictEqual(drafted.json.proposal.status, 'pending');
        assert.strictEqual(drafted.json.model, 'stub-model');
        assert.ok(drafted.json.revision.body.startsWith('Machines do work.'), drafted.json.revision.body);
        assert.ok(drafted.json.revision.body.includes('## History'));
        assert.deepStrictEqual(drafted.json.revision.infobox.map((r) => [r.label, r.value]), [['Maker', 'OpenVibe']]);
        assert.deepStrictEqual(drafted.json.sources.map((s) => s.url), ['https://sources.test/a', 'https://sources.test/b']);

        console.log('wiki rich ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
