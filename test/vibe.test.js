'use strict';
/**
 * "Vibe a wiki" end to end against stand-ins for OpenVibe.AI and OpenVibe.Media: a person names a topic → a new wiki
 * they own → research, plan, pages written with their sources and pictures (stored in Media for the person, placed in
 * the text and the infobox, credited as citations) → published with the AI disclosure and noindex. AI's quota (429)
 * makes the job wait and resume; the daily limit refuses; a signed-out visitor is asked to sign in. Also: the
 * [[media:…]] syntax and the picture fetcher's refusals.
 */
const assert = require('assert');
const H = require('./helpers');
const content = require('../server/wiki/content');
const { checkUrl, sniff } = require('../server/integrations/image-fetch');
const { normalizePlan, spaceSlugFor, contentsOf } = require('../server/wiki/vibe');

const MED = (n) => `med_01J8Z6Q3KX0000000000000${String(n).padStart(3, '0')}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const LONG = 'Kim Possible is a teenager who saves the world between classes, with her best friend and a naked mole-rat. '.repeat(6);

// Unit checks first: the syntax, the fetcher's rules, the plan's shape.
{
    const src = 'Intro.\n\n[[media:' + MED(1) + '|A caption]]\n\nSee [[Ron Stoppable]] and [[media:' + MED(9) + ']].';
    assert.deepStrictEqual(content.extractLinks(src, 'kp').map((l) => l.slug), ['ron-stoppable'], 'a picture is not a page link');
    assert.deepStrictEqual(content.mediaRefs(src), [MED(1), MED(9)]);
    const out = content.renderContent(src, { currentSpace: 'kp', resolve: () => ({ href: '/w/kp/ron-stoppable', exists: true }), media: (id, cap) => (id === MED(1) ? `<figure data-id="${id}">${cap}</figure>` : null) });
    assert.ok(out.includes(`<figure data-id="${MED(1)}">A caption</figure>`), out);
    assert.ok(!/<p>\s*<figure/.test(out), 'a picture on its own line is not wrapped in a paragraph');
    assert.ok(!out.includes(MED(9)), 'a picture the page does not have shows nothing');
    for (const bad of ['http://x.test/a.png', 'https://127.0.0.1/a.png', 'https://user:pw@x.test/a.png', 'file:///etc/passwd', 'nonsense']) assert.throws(() => checkUrl(bad), bad);
    assert.strictEqual(sniff(PNG), 'image/png');
    assert.strictEqual(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'an SVG is never taken for a picture');
    assert.strictEqual(spaceSlugFor('Pokémon Red & Blue!'), 'pokemon-red-blue');
    assert.strictEqual(spaceSlugFor('東京'), null);
    const plan = normalizePlan({ title: 'KP', summary: 's', pages: [{ title: 'Ron', kind: 'character', outline: ['A'] }, { title: 'Kim Possible', kind: 'overview' }, { title: 'ron', kind: 'person' }, { title: 'Bad [[x]]|', kind: 'weird' }] }, 'Kim Possible', 3);
    assert.deepStrictEqual(plan.pages.map((p) => [p.title, p.kind]), [['Kim Possible', 'overview'], ['Ron', 'character'], ['Bad x', 'other']], 'main page first, duplicates out, kinds known, link syntax stripped');
    assert.match(contentsOf(plan), /### Characters\n\n- \[\[Ron\]\]/);
}

(async () => {
    const A = H.subject();
    const calls = [];
    let quota = 1;            // the first write of "Ron Stoppable" meets a full quota
    let objects = 0;
    const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    const research = (focus) => ({
        query: focus || 'Kim Possible', topic: 'Kim Possible', focus: focus || null,
        sources: [
            { source_type: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Kim_Possible', title: 'Kim Possible — Wikipedia', content: LONG, retrieved_at: '2026-10-25T10:00:00.000Z', provenance: { provider: 'wikipedia', license: 'CC BY-SA 4.0 (Wikipedia)' } },
            { source_type: 'fandom', url: `https://kimpossible.fandom.com/wiki/${focus ? 'Ron_Stoppable' : 'Kim_Possible'}`, title: 'Kim Possible Wiki', content: LONG, retrieved_at: '2026-10-25T10:00:00.000Z', provenance: { provider: 'fandom', license: 'CC BY-SA 3.0 (Fandom)' } },
        ],
        images: [{ url: 'https://img.test/kim.png', title: focus || 'Kim Possible', description: 'from the show', license: 'CC BY-SA 4.0', author: 'Jane Doe', free: true, source_url: 'https://commons.wikimedia.org/wiki/File:Kim.png', provider: 'commons' }],
        facts: [], topic_wiki: { name: 'Kim Possible Wiki', url: 'https://kimpossible.fandom.com' }, providers: { wikipedia: { ok: true, count: 1 }, fandom: { ok: true, count: 1 }, deepseek: { ok: false, skipped: 'not configured' } }, usage: {},
    });
    const page = (title) => ({
        title, summary: `${title} is part of Kim Possible.`, lead: `**${title}** is part of the show. ${title === 'Kim Possible' ? 'Her friend is [[Ron Stoppable]].' : 'He is friends with [[Kim Possible]].'} ${LONG}`,
        sections: [{ heading: 'Premise', body: LONG, citations: [0] }, { heading: 'Legacy', body: LONG, citations: [1] }],
        infobox: [{ label: 'Created by', value: 'Bob Schooley and Mark McCorkle', citations: [0] }, { label: 'Network', value: 'Disney Channel', citations: [0] }],
        images: [{ index: 0, caption: `${title} on screen`, section: 'lead' }, { index: 7, caption: 'out of range', section: 'Premise' }],
        citations: [0, 1], gaps: [],
    });
    const fetchStub = async (url, init = {}) => {
        const u = new URL(url);
        calls.push({ host: u.host, path: u.pathname, method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? init.body : null });
        if (u.host === 'ai.internal') {
            if (u.pathname !== '/api/v1/runs' || init.method !== 'POST') return json(404, {});
            const b = JSON.parse(init.body);
            assert.deepStrictEqual(b.on_behalf_of, { type: 'user', id: A }, 'AI runs on behalf of the person');
            const id = `run_${calls.length}`;
            if (b.workflow === 'research.gather') return json(201, { run: { id, status: 'succeeded', output: research(b.input.focus) } });
            if (b.workflow === 'wiki.generate_space') {
                assert.ok(b.input.sources.length >= 1 && b.input.max_pages === 6);
                return json(201, { run: { id, status: 'succeeded', output: { title: 'Kim Possible', summary: 'An animated series about a teen hero.', pages: [
                    { title: 'Kim Possible', kind: 'overview', parent: '', outline: ['Premise', 'Legacy'], query: 'Kim Possible', citations: [0] },
                    { title: 'Ron Stoppable', kind: 'character', parent: 'Kim Possible', outline: ['Premise'], query: 'Ron Stoppable Kim Possible', citations: [1] },
                    { title: 'Kim Possible', kind: 'other', parent: '', outline: [], query: '', citations: [] },
                ], citations: [0], gaps: [] } } });
            }
            if (b.workflow === 'wiki.generate_page') {
                assert.ok(b.input.pages.includes('Ron Stoppable') && b.input.images.length === 1);
                if (b.input.title === 'Ron Stoppable' && quota-- > 0) return json(429, { code: 'quota.exceeded', detail: 'daily budget used' }, { 'Retry-After': '120' });
                return json(201, { run: { id, status: 'succeeded', output: page(b.input.title) } });
            }
            return json(404, {});
        }
        if (u.host === 'media.internal') {
            const m = /^\/api\/v2\/wiki\/objects(?:\/([^/]+))?(?:\/(content|complete))?$/.exec(u.pathname);
            if (!m) return json(404, {});
            if (!m[1] && init.method === 'POST') {
                const b = JSON.parse(init.body);
                assert.strictEqual(b.visibility, 'public');
                assert.strictEqual(b.kind, 'asset');
                assert.strictEqual(init.headers['X-OV-Subject'], A, 'the picture belongs to the person');
                assert.strictEqual(b.metadata.license, 'CC BY-SA 4.0');
                const id = MED(++objects);
                return json(201, { id, upload: { method: 'PUT', url: `https://openvibe.media/api/v2/wiki/objects/${id}/content?token=t1`, token: 't1', complete_url: `https://openvibe.media/api/v2/wiki/objects/${id}/complete` } });
            }
            if (m[2] === 'content') { assert.strictEqual(init.method, 'PUT'); return json(200, { ok: true }); }
            if (m[2] === 'complete') return json(200, { object: { id: m[1], lifecycle_status: 'ready' } });
            return json(200, { id: m[1], visibility: 'public', owner: { subject: A, app: 'wiki' }, lifecycle_status: 'ready' });
        }
        return json(404, { error: 'stub: no route' });
    };
    const fetched = [];
    const h = await H.boot({
        fetch: fetchStub, imageFetch: async (url) => { fetched.push(url); return { bytes: PNG, mime: 'image/png', url }; },
        env: { OV_MEDIA_INTERNAL_URL: 'http://media.internal', OV_AI_INTERNAL_URL: 'http://ai.internal', WIKI_VIBE_PER_PERSON_DAY: '2', WIKI_VIBE_PAGES_QUICK: '6' },
    });
    const tok = H.userToken({ subject: A });
    try {
        // Signed out: asked to sign in; the form is on /vibe and the home.
        let r = await H.req(h, 'POST', '/vibe', { form: { topic: 'Kim Possible' } });
        assert.strictEqual(r.status, 401);
        r = await H.req(h, 'GET', '/vibe');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Vibe a wiki/);
        assert.match(r.text, /Sign in to vibe/);
        r = await H.req(h, 'GET', '/');
        assert.match(r.text, /Any topic\./);
        assert.match(r.text, /href="\/vibe"/);

        // Start one.
        r = await H.req(h, 'POST', '/api/v1/vibes', { token: tok, body: { topic: '  Kim   Possible ', size: 'quick' } });
        assert.strictEqual(r.status, 202, r.text);
        const id = r.json.vibe.id;
        assert.strictEqual(r.json.vibe.status, 'queued');
        assert.strictEqual(r.json.space.slug, 'kim-possible');
        assert.strictEqual(r.json.space.kind, 'user');
        assert.match(r.json.progress_url, new RegExp(`/vibe/${id}$`));
        r = await H.req(h, 'POST', '/api/v1/vibes', { token: tok, body: { topic: 'x' } });
        assert.strictEqual(r.status, 422);
        r = await H.req(h, 'POST', '/api/v1/vibes', { token: tok, body: { topic: 'Kim Possible', size: 'enormous' } });
        assert.strictEqual(r.status, 422);

        // Research, plan, the main page; Ron meets a full quota → the job waits for Retry-After.
        assert.strictEqual(await h.vibes.tick(), true);
        let v = (await H.req(h, 'GET', `/api/v1/vibes/${id}`, { token: tok })).json.vibe;
        assert.strictEqual(v.status, 'writing');
        assert.ok(v.waiting_until, 'waiting for AI\'s quota');
        assert.deepStrictEqual(v.pages.map((p) => [p.title, p.status]), [['Kim Possible', 'done'], ['Ron Stoppable', 'waiting']]);
        assert.strictEqual(await h.vibes.tick(), false, 'nothing is due while it waits');
        await h.db.prepare('UPDATE wiki_vibes SET retry_at = 1 WHERE id = ?').run(id);
        assert.strictEqual(await h.vibes.tick(), true);
        v = (await H.req(h, 'GET', `/api/v1/vibes/${id}`, { token: tok })).json.vibe;
        assert.strictEqual(v.status, 'done', JSON.stringify(v));
        assert.strictEqual(v.done, 2);
        assert.strictEqual(v.main_page, '/w/kim-possible/kim-possible');
        assert.deepStrictEqual(v.research.from.sort(), ['Fandom', 'Wikipedia']);
        assert.strictEqual(fetched.length, 2, 'one picture per page; an index out of range is ignored');

        // The wiki: named and described by the plan, the person owns it.
        r = await H.req(h, 'GET', '/api/v1/spaces/kim-possible', { token: tok });
        assert.strictEqual(r.json.space.name, 'Kim Possible');
        assert.strictEqual(r.json.space.description, 'An animated series about a teen hero.');
        assert.deepStrictEqual(r.json.pages.map((p) => [p.slug, p.children.map((c) => c.slug)]), [['kim-possible', ['ron-stoppable']]], 'pages hang under the main page');

        // The main page as a reader sees it.
        r = await H.req(h, 'GET', '/w/kim-possible/kim-possible');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /written with AI assistance/i);
        assert.match(r.text, /<meta name="robots" content="noindex/, 'noindex until a person reviews it');
        assert.match(r.text, new RegExp(`class="wk-ib-pic"[\\s\\S]*?<img src="https://openvibe.media/o/${MED(1)}"`), 'the lead picture in the infobox');
        assert.match(r.text, /Kim Possible on screen \(Picture: Jane Doe, CC BY-SA 4.0\)/, 'captioned with its credit');
        assert.match(r.text, /<th scope="row">Created by<\/th><td>Bob Schooley and Mark McCorkle<\/td>/);
        assert.match(r.text, /<h2[^>]*>In this wiki<\/h2>/);
        assert.match(r.text, /<a class="ov-wikilink" href="\/w\/kim-possible\/ron-stoppable">Ron Stoppable<\/a>/, 'a blue link to the page written after it');
        assert.match(r.text, /href="https:\/\/en.wikipedia.org\/wiki\/Kim_Possible"[^>]*>Kim Possible — Wikipedia<\/a>, retrieved/);
        assert.match(r.text, /Picture: Kim Possible<\/a>, retrieved[\s\S]*?\(CC BY-SA 4.0, Jane Doe\)/, 'the picture cited with its licence');
        assert.ok(!/<section class="wk-media">/.test(r.text), 'no second copy of a picture already shown');
        const att = await h.db.prepare('SELECT o.media_id, o.attached_by, o.media_visibility FROM wiki_attachment_origins o JOIN wiki_pages p ON p.id = o.page_id WHERE p.slug = ?').all('kim-possible');
        assert.deepStrictEqual(att, [{ media_id: MED(1), attached_by: A, media_visibility: 'public' }]);

        // The progress page and its JSON.
        r = await H.req(h, 'GET', `/vibe/${id}`);
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /is ready/);
        assert.match(r.text, /href="\/w\/kim-possible\/kim-possible">Open the wiki/);
        r = await H.req(h, 'GET', `/vibe/${id}.json`);
        assert.strictEqual(r.json.status, 'done');
        assert.strictEqual((await H.req(h, 'GET', '/vibe/vib_01J8Z6Q3KX00000000000000000.json')).status, 404);
        r = await H.req(h, 'GET', '/');
        assert.match(r.text, /Wikis people vibed/);

        // The daily limit (2 here): the second start is allowed, the third refused.
        r = await H.req(h, 'POST', '/api/v1/vibes', { token: tok, body: { topic: 'Ron Stoppable', size: 'quick', visibility: 'private' } });
        assert.strictEqual(r.status, 202, r.text);
        r = await H.req(h, 'POST', '/api/v1/vibes', { token: tok, body: { topic: 'Rufus' } });
        assert.strictEqual(r.status, 429);
        assert.strictEqual(r.json.code, 'vibe.daily_limit');
        // A private generated wiki's progress is not shown to others.
        const second = (await H.req(h, 'GET', '/api/v1/vibes', { token: tok })).json.vibes.find((x) => x.topic === 'Ron Stoppable');
        assert.strictEqual((await H.req(h, 'GET', `/vibe/${second.id}`)).status, 404);
        assert.strictEqual((await H.req(h, 'GET', `/vibe/${second.id}.json`, { token: H.userToken() })).status, 404);
        console.log('vibe: all checks passed');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
