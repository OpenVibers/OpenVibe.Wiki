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
const { composeBody } = require('../server/wiki/writer');

const run = (output, extra = {}) => ({ run: { id: 'run_ai_1', status: 'succeeded', output, model: 'stub-model', provider: 'stub', ...extra } });

(async () => {
    const h = await H.boot({
        env: { OV_AI_INTERNAL_URL: 'https://ai.test', OV_PICS_URL: 'https://pics.test' },
        fetch: async (url, init = {}) => {
            const u = new URL(String(url));
            if (u.host === 'ai.test' && u.pathname === '/api/v1/runs') {
                const body = JSON.parse(init.body || '{}');
                if (body.task === 'image.picture' && body.input && body.input.mode === 'find') {
                    if (String(body.input.query || '').includes('No picture')) return new Response(JSON.stringify(run({ mode: 'find', task: 'image.picture', query: body.input.query, media: [], count: 0, gaps: [], note: 'No licensed picture was found for this search.' })), { status: 200, headers: { 'Content-Type': 'application/json' } });
                    return new Response(JSON.stringify(run({
                        mode: 'find', task: 'image.picture', query: body.input.query, media: [
                            { media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ', url: 'https://media.test/o/med_01JAB2C3D4E5F6G7H8J9K0MNPQ', source_url: 'https://commons.test/File:Machine', title: 'A machine', alt: 'A machine in a workshop', caption: 'A machine in a workshop', credit: 'Ada Example, CC BY-SA 4.0', author: 'Ada Example', license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', width: 800, height: 600, provider: 'commons', ai: false, model: null },
                            { media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPR', url: 'https://media.test/o/med_01JAB2C3D4E5F6G7H8J9K0MNPR', source_url: 'https://openverse.test/File:Machine', title: 'A second machine', alt: 'A second machine', caption: 'A second machine', credit: 'Bo, CC BY 4.0', author: 'Bo', license: 'CC BY 4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', width: 900, height: 700, provider: 'openverse/flickr', ai: false, model: null },
                        ], count: 2, gaps: [], note: null,
                    })), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (body.task === 'image.picture' && body.input && body.input.mode === 'make') {
                    return new Response(JSON.stringify(run({ mode: 'make', task: 'image.picture', prompt: body.input.prompt, dry_run: false, estimate: null, media: [
                        { media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPS', url: 'https://media.test/o/med_01JAB2C3D4E5F6G7H8J9K0MNPS', width: 1024, height: 1024, title: 'An illustration', alt: 'An illustration for Machines', caption: 'An illustration for Machines (Made with AI (gpt-image-1))', credit: 'Made with AI (gpt-image-1)', author: null, license: null, license_url: null, source_url: null, provider: 'image', ai: true, model: 'gpt-image-1' },
                    ], count: 1, gaps: [], note: null })), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (body.workflow === 'content.wiki') {
                    return new Response(JSON.stringify({
                        ...run({
                            title: 'Machines', summary: 'A page about machines.',
                            lead: [{ text: `# Machines\n\nMachines do work. ${H.LONG}`, citations: [0] }],
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
                if (String(u.searchParams.get('q') || '').includes('No picture')) return new Response(JSON.stringify({ pictures: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
        const blocksLink = page.text.match(/<link rel="stylesheet" href="(\/css\/blocks\.css\?v=[0-9a-f]{10})">/);
        assert.ok(blocksLink, 'the article links the hashed blocks sheet');
        assert.ok(page.text.indexOf(blocksLink[0]) < page.text.indexOf('<link rel="stylesheet" href="/css/wiki.css?'), 'blocks CSS loads before wiki placement rules');
        const sheet = await fetch(`${h.base}${blocksLink[1]}`);
        assert.strictEqual(sheet.status, 200);
        assert.match(sheet.headers.get('content-type'), /^text\/css/);
        assert.strictEqual(sheet.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        assert.ok((await sheet.text()).includes('.ov-infobox'), 'the served sheet comes from the library');
        assert.ok(page.text.includes('This revision cites no sources.'));
        assert.ok(!page.text.includes('Inspect these sources'), 'an empty list has no inspect link');
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

        // image.picture: Commons and Openverse first, keeping licence and author and naming the Media object; then Pics.
        const suggested = await H.req(h, 'POST', `/api/v1/pages/${made.page.id}/images/suggest`, { cookie, body: { count: 8 } });
        assert.strictEqual(suggested.status, 200, suggested.text);
        assert.strictEqual(suggested.json.task, 'image.picture');
        assert.strictEqual(suggested.json.subject_is_person, false);
        assert.deepStrictEqual([...new Set(suggested.json.suggestions.map((s) => s.provider))].sort(), ['commons', 'openverse', 'pics']);
        const lead = suggested.json.suggestions.find((s) => s.role === 'lead');
        assert.strictEqual(lead.media_id, 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        assert.strictEqual(lead.license, 'CC BY-SA 4.0');
        assert.strictEqual(lead.author, 'Ada Example');
        assert.ok(lead.credit.includes('CC BY-SA 4.0'));

        // image.picture make: nothing real exists, the owner has a model, so one illustration comes back as a
        // Media reference and its credit says which model made it. A real person is still never drawn.
        const drawn = await H.req(h, 'POST', `/api/v1/pages/${made.page.id}/images/suggest`, { cookie, body: { query: 'No picture of machines', allow_ai: true, count: 2 } });
        assert.strictEqual(drawn.status, 200, drawn.text);
        assert.strictEqual(drawn.json.suggestions.length, 1);
        assert.strictEqual(drawn.json.suggestions[0].provider, 'ai');
        assert.strictEqual(drawn.json.suggestions[0].ai, true);
        assert.strictEqual(drawn.json.suggestions[0].media_id, 'med_01JAB2C3D4E5F6G7H8J9K0MNPS');
        assert.strictEqual(drawn.json.suggestions[0].model, 'gpt-image-1');
        assert.ok(drawn.json.suggestions[0].credit.includes('Illustration made with gpt-image-1'));

        // content.wiki: a draft proposal, pending, with a citation per sentence and the infobox filled.
        const drafted = await H.req(h, 'POST', `/api/v1/pages/${made.page.id}/draft`, { cookie, body: { instruction: 'Add the history' } });
        assert.strictEqual(drafted.status, 201, drafted.text);
        assert.strictEqual(drafted.json.proposal.status, 'pending');
        assert.strictEqual(drafted.json.model, 'stub-model');
        assert.ok(drafted.json.revision.body.startsWith('Machines do work.'), drafted.json.revision.body);
        assert.ok(drafted.json.revision.body.includes('## History'));
        assert.ok(!drafted.json.revision.body.startsWith('# Machines'), 'the writer drops a repeated leading title');
        assert.strictEqual(composeBody({ sections: [{ heading: 'Machines', sentences: [{ text: 'A cited sentence.', citations: [0] }] }] }, 'Machines'), 'A cited sentence.');
        assert.deepStrictEqual(drafted.json.revision.infobox.map((r) => [r.label, r.value]), [['Maker', 'OpenVibe']]);
        assert.deepStrictEqual(drafted.json.sources.map((s) => s.url), ['https://sources.test/a', 'https://sources.test/b']);

        console.log('wiki rich ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
