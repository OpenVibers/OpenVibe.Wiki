'use strict';
/**
 * The services Wiki composes, against stubs: Media (a deleted or missing object is an explicit
 * broken-asset state; an outage changes nothing), Sources (item citations carry the item's own
 * provenance; unknown items and outages are refused, never invented), Community (the discussion is
 * a thread reference; comments are posted as the signed-in person), Events (the outbox relay
 * publishes with the service token).
 */
const assert = require('assert');
const H = require('./helpers');

const MED = (c) => `med_01J8Z6Q3KX00000000000000${c}${c}`.slice(0, 30);
const ITEM = 'itm_01J8Z6Q3KX0000000000000001';

(async () => {
    const calls = [];
    let sourcesUp = true;
    const thread = { id: 7, visibility: 'public', comment_count: 1 };
    const comments = [{ id: 1, thread_id: 7, display_name: 'Bea', message: 'Nice page <b>really</b>', created_at: '2026-09-21T10:00:00.000Z', origin: 'user', deleted: false }];
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fetchStub = async (url, init = {}) => {
        const u = new URL(url);
        const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
        calls.push({ url: u.pathname, method: init.method || 'GET', headers, body: init.body ? String(init.body) : null, host: u.host });
        if (u.host === 'media.internal') {
            const id = u.pathname.split('/').pop();
            if (id === MED('A')) return json(200, { id, lifecycle_status: 'ready' });
            if (id === MED('B')) return json(404, { code: 'media.object.not_found' });
            if (id === MED('C')) return json(200, { id, lifecycle_status: 'deleted' });
            throw new Error('ECONNREFUSED');
        }
        if (u.host === 'sources.internal') {
            if (!sourcesUp) throw new Error('ECONNREFUSED');
            if (u.pathname === `/api/v1/items/${ITEM}`) return json(200, { item: { id: ITEM, canonical_url: 'https://news.example/story', title: 'A story', provenance: { retrieved_at: '2026-09-19T08:30:00.000Z', license_note: 'CC BY 4.0' } } });
            return json(404, { code: 'sources.not_found' });
        }
        if (u.host === 'community.internal') {
            if (u.pathname === '/api/v1/comments/threads/resolve') return json(201, { thread, created: true });
            if (u.pathname === '/api/v1/comments/threads/7' && (init.method || 'GET') === 'GET') return json(200, { thread, comments, next_cursor: null });
            if (u.pathname === '/api/v1/comments/threads/7/comments') return json(201, { comment: { id: 2 } });
        }
        if (u.host === 'events.internal' && u.pathname === '/api/v1/events') {
            const b = JSON.parse(init.body);
            const list = b.events || [b];
            const results = list.map((e, i) => ({ event_id: e.event_id, seq: i + 1, duplicate: false }));
            return json(200, b.events ? { results } : results[0]);
        }
        return json(404, { error: 'stub: no route' });
    };
    const h = await H.boot({
        fetch: fetchStub,
        env: { OV_MEDIA_INTERNAL_URL: 'http://media.internal', OV_SOURCES_INTERNAL_URL: 'http://sources.internal', OV_COMMUNITY_INTERNAL_URL: 'http://community.internal', EVENTS_URL: 'http://events.internal' },
    });
    const me = H.subject();
    const tok = H.userToken({ subject: me });
    try {
        let r = await H.req(h, 'POST', '/api/v1/spaces', { token: tok, body: { name: 'Media test', slug: 'mt' } });
        assert.strictEqual(r.status, 201);

        // Sources: an item citation takes url, title, retrieval time and license from the item.
        r = await H.req(h, 'POST', '/api/v1/spaces/mt/pages', { token: tok, body: { title: 'Cited', body: H.LONG, citations: [{ source_item_id: ITEM, quote: 'a line' }] } });
        assert.strictEqual(r.status, 201, r.text);
        const pageId = r.json.page.id;
        assert.deepStrictEqual(
            { url: r.json.citations[0].url, title: r.json.citations[0].title, retrieved_at: r.json.citations[0].retrieved_at, license_note: r.json.citations[0].license_note, source_item_id: r.json.citations[0].source_item_id },
            { url: 'https://news.example/story', title: 'A story', retrieved_at: '2026-09-19T08:30:00.000Z', license_note: 'CC BY 4.0', source_item_id: ITEM },
        );
        const srcCall = calls.find((c) => c.host === 'sources.internal');
        assert.strictEqual(srcCall.headers.authorization, 'Bearer stub-token');
        r = await H.req(h, 'POST', '/api/v1/spaces/mt/pages', { token: tok, body: { title: 'Unknown', body: H.LONG, citations: [{ source_item_id: 'itm_01J8Z6Q3KX0000000000000009' }] } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json.code, 'citation.source_item_not_found');
        sourcesUp = false;
        r = await H.req(h, 'POST', '/api/v1/spaces/mt/pages', { token: tok, body: { title: 'Down', body: H.LONG, citations: [{ source_item_id: ITEM }] } });
        assert.strictEqual(r.status, 503);
        assert.strictEqual(h.svc.findPage(h.svc.findSpace('mt').id, 'down'), null, 'nothing is written without the source');
        sourcesUp = true;
        await H.req(h, 'POST', `/api/v1/pages/${pageId}/publish`, { token: tok, body: {} });

        // Media: attach four objects, check them.
        for (const c of ['A', 'B', 'C', 'D']) {
            r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/media`, { token: tok, body: { media_id: MED(c), alt: `Picture ${c}`, caption: `Caption ${c}` } });
            assert.strictEqual(r.status, 201, r.text);
        }
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/media`, { token: tok, body: { media_id: 'https://evil.example/x.png' } });
        assert.strictEqual(r.status, 400, 'only Media object ids, never URLs');
        r = await H.req(h, 'POST', `/api/v1/pages/${pageId}/media/verify`, { token: tok, body: {} });
        const outcome = Object.fromEntries(r.json.results.map((x) => [x.mediaId, x.outcome + (x.reason ? `:${x.reason}` : '')]));
        assert.deepStrictEqual(outcome, { [MED('A')]: 'available', [MED('B')]: 'broken:not_found', [MED('C')]: 'broken:deleted', [MED('D')]: 'check_failed' });
        const html = (await H.req(h, 'GET', '/w/mt/cited')).text;
        assert.ok(html.includes(`<img src="https://openvibe.media/o/${MED('A')}" alt="Picture A"`));
        assert.ok(html.includes('This media was deleted from OpenVibe.Media and is no longer available.'));
        assert.ok(html.includes('This media is no longer available.'));
        assert.ok(!html.includes(`src="https://openvibe.media/o/${MED('B')}"`), 'no image for a broken object');
        assert.ok(!html.includes(`src="https://openvibe.media/o/${MED('C')}"`));
        assert.ok(html.includes(`data-media-id="${MED('D')}" data-state="unverified"`), 'an outage leaves the state alone');
        const pj = (await H.req(h, 'GET', '/w/mt/cited.json')).json;
        assert.deepStrictEqual(pj.attachments.map((a) => a.state), ['available', 'broken', 'broken', 'unverified']);

        // Community: the thread is resolved once and stored as a reference; comments are Community's.
        r = await H.req(h, 'GET', '/w/mt/cited');
        assert.ok(r.text.includes('Nice page &lt;b&gt;really&lt;/b&gt;'), 'comment text is escaped');
        await H.req(h, 'GET', '/w/mt/cited');
        const resolves = calls.filter((c) => c.url === '/api/v1/comments/threads/resolve');
        assert.strictEqual(resolves.length, 1);
        assert.deepStrictEqual(JSON.parse(resolves[0].body).ref, { service: 'wiki', type: 'page', id: pageId, label: 'Cited' });
        assert.strictEqual(h.db.prepare('SELECT thread_id FROM wiki_discussion_refs WHERE entity_id = ?').get(pageId).thread_id, '7');
        assert.deepStrictEqual(h.db.prepare('PRAGMA table_info(wiki_discussion_refs)').all().map((c) => c.name).sort(), ['entity_id', 'ref', 'resolved_at', 'thread_id'], 'no copy of comment content');
        r = await H.req(h, 'POST', '/w/mt/cited/discuss', { cookie: H.cookieFor(tok), form: { message: 'Thanks' } });
        assert.strictEqual(r.status, 303);
        const post = calls.find((c) => c.url === '/api/v1/comments/threads/7/comments');
        assert.strictEqual(post.headers['x-ov-subject'], me);
        assert.deepStrictEqual(JSON.parse(post.body), { message: 'Thanks' });
        r = await H.req(h, 'POST', '/w/mt/cited/discuss', { form: { message: 'anon' } });
        assert.strictEqual(r.status, 401, 'anonymous visitors do not post through Wiki');

        // Events: the relay publishes the outbox with the service token.
        const pending = h.platform.outbox.pending();
        assert.ok(pending > 0);
        const flushed = await h.platform.outbox.flush();
        assert.strictEqual(flushed.sent, pending);
        assert.strictEqual(h.platform.outbox.pending(), 0);
        const ev = calls.filter((c) => c.host === 'events.internal');
        assert.ok(ev.length >= 1);
        assert.strictEqual(ev[0].headers.authorization, 'Bearer stub-token');
        const published = ev.flatMap((c) => { const b = JSON.parse(c.body); return b.events || [b]; });
        assert.ok(published.some((e) => e.event_type === 'wiki.index_document.upserted'));
        assert.ok(published.every((e) => /^evt_[0-9A-Z]{26}$/.test(e.event_id)));
        console.log('integrations ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
