'use strict';
/**
 * /feed.atom is linked from every page, so it always answers: with nothing listable it is a valid
 * Atom feed with zero entries (200, never 404). The feed-level <updated> is a real time — the last
 * change to a public space, or the epoch when there is none — never "now" and never the time of a
 * change readers cannot see. Unlisted content (drafts, private pages, unreviewed AI-assisted
 * imports) never appears as an entry.
 */
const assert = require('assert');
const H = require('./helpers');
const { SYSTEM, IMPORTED } = require('../server/wiki/seed');

/** A small well-formedness check: balanced tags, one root, no stray markup characters in text. */
function assertWellFormed(xml) {
    const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
    const stack = [];
    let roots = 0;
    let last = 0;
    for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g)) {
        const text = body.slice(last, m.index);
        assert.ok(!/[<>]|&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text), `stray markup in text: ${text.slice(0, 80)}`);
        last = m.index + m[0].length;
        const [, close, name, , selfClose] = m;
        if (!stack.length && !close) roots++;
        if (close) assert.strictEqual(stack.pop(), name, `</${name}> closes the wrong element`);
        else if (!selfClose) stack.push(name);
    }
    assert.strictEqual(body.slice(last).trim(), '', 'nothing after the root element');
    assert.strictEqual(stack.length, 0, `unclosed: ${stack.join(', ')}`);
    assert.strictEqual(roots, 1, 'exactly one root element');
}

function atom(text) {
    assertWellFormed(text);
    const head = text.split('<entry>')[0];
    const one = (tag, src = head) => { const m = src.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m ? m[1] : null; };
    return {
        root: /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/.test(text),
        id: one('id'), title: one('title'), updated: one('updated'),
        self: (head.match(/<link rel="self" type="application\/atom\+xml" href="([^"]+)"\/>/) || [])[1] || null,
        entries: [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({ id: one('id', m[1]), updated: one('updated', m[1]), href: (m[1].match(/href="([^"]+)"/) || [])[1] })),
    };
}

(async () => {
    const h = await H.boot();
    const owner = { kind: 'user', subject: H.subject(), staff: false };
    try {
        // A new wiki: nothing at all.
        let r = await H.req(h, 'GET', '/feed.atom');
        assert.strictEqual(r.status, 200, 'an empty feed is a feed, not a 404');
        assert.match(r.headers.get('content-type'), /^application\/atom\+xml/);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
        let f = atom(r.text);
        assert.ok(f.root, 'root <feed> in the Atom namespace');
        assert.strictEqual(f.id, 'http://wiki.test/feed.atom');
        assert.strictEqual(f.title, 'OpenVibe.Wiki: recent changes');
        assert.strictEqual(f.self, 'http://wiki.test/feed.atom');
        assert.strictEqual(f.updated, '1970-01-01T00:00:00.000Z', 'no public space: the epoch, never "now"');
        assert.deepStrictEqual(f.entries, []);

        // Published, but nothing listable: an unreviewed AI-assisted import, a private page, a draft.
        const space = h.svc.createSpace({ name: 'Notes', slug: 'notes' }, owner);
        const cite = [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T00:00:00Z' }];
        const seeded = h.svc.createPage(space.id, { title: 'Imported page', body: H.LONG, citations: cite, authorship: IMPORTED }, SYSTEM).page;
        h.svc.publish(seeded.id, {}, SYSTEM);
        const hidden = h.svc.createPage(space.id, { title: 'Private page', body: H.LONG, citations: cite, visibility: 'private' }, owner).page;
        h.svc.publish(hidden.id, {}, owner);
        h.svc.createPage(space.id, { title: 'Draft page', body: H.LONG, citations: cite }, owner);
        const secret = h.svc.createSpace({ name: 'Secret', slug: 'secret', visibility: 'private' }, owner);
        const inSecret = h.svc.createPage(secret.id, { title: 'Hidden plans', body: H.LONG, citations: cite }, owner).page;
        h.svc.publish(inSecret.id, {}, owner);
        r = await H.req(h, 'GET', '/feed.atom');
        assert.strictEqual(r.status, 200);
        f = atom(r.text);
        assert.deepStrictEqual(f.entries, []);
        assert.strictEqual(f.updated, new Date(h.svc.findSpace('notes').updated_at).toISOString(), 'the last change to a public space');
        assert.ok(!/imported-page|private-page|draft-page|hidden-plans/.test(r.text), 'nothing unlisted leaks into the feed');
        assert.deepStrictEqual((await H.req(h, 'GET', '/feed.json')).json.items, []);

        // A listable page: one entry, and the feed's <updated> is that entry's.
        const open = h.svc.createPage(space.id, { title: 'Open page', body: H.LONG, citations: cite }, owner).page;
        h.svc.publish(open.id, {}, owner);
        f = atom((await H.req(h, 'GET', '/feed.atom')).text);
        assert.deepStrictEqual(f.entries.map((e) => e.href), ['http://wiki.test/w/notes/open-page']);
        assert.strictEqual(f.updated, f.entries[0].updated);
        console.log('feeds ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
