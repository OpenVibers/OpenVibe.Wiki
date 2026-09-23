'use strict';
/**
 * A public page is useful with JavaScript disabled, and so is editing: every step here is a plain
 * GET or an HTML form post (application/x-www-form-urlencoded), exactly what a browser without
 * scripts sends. Also: red links, preview, edit conflicts, revert, cross-site post refusal.
 */
const assert = require('assert');
const H = require('./helpers');

const stripScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');

(async () => {
    const h = await H.boot();
    const me = H.subject();
    const cookie = H.cookieFor(H.userToken({ subject: me, username: 'ana' }));
    try {
        // Anonymous: the home page offers sign-in, the new-space form asks for it.
        let r = await H.req(h, 'GET', '/');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Sign in with OpenVibe'));
        assert.ok(r.text.includes('<noscript><nav'), 'a navigation exists without the JavaScript navbar');
        r = await H.req(h, 'GET', '/new-space');
        assert.strictEqual(r.status, 401);
        assert.ok(r.text.includes('/auth/login?next=%2Fnew-space'));

        // Create a space with a form post.
        r = await H.req(h, 'POST', '/new-space', { cookie, form: { name: 'Board games', slug: 'board-games', visibility: 'public', description: 'Rules and notes' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), '/s/board-games');
        r = await H.req(h, 'GET', '/s/board-games', { cookie });
        assert.ok(r.text.includes('href="/s/board-games/new"'));

        // Preview does not save.
        const body = `Chess is played on a board of sixty-four squares. See [[Go]] and [[Missing rules|the missing rules]]. ${H.LONG}`;
        r = await H.req(h, 'POST', '/s/board-games/new', { cookie, form: { op: 'preview', title: 'Chess', body, infobox: 'Players | number | 2\nInvented | text | unknown' } });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Preview (not saved)'));
        assert.strictEqual(h.svc.findPage(h.svc.findSpace('board-games').id, 'chess'), null);
        // Invalid infobox rows come back with the text intact.
        r = await H.req(h, 'POST', '/s/board-games/new', { cookie, form: { op: 'save', title: 'Chess', body, infobox: 'Players | number | two' } });
        assert.strictEqual(r.status, 422);
        assert.ok(r.text.includes('is not a number'));
        assert.ok(r.text.includes('Chess is played on a board'));

        // Save and publish with a source from the form's citation rows.
        r = await H.req(h, 'POST', '/s/board-games/new', { cookie, form: {
            op: 'publish', title: 'Chess', body, summary: 'A two-player board game.', infobox: 'Players | number | 2',
            cite_url_0: 'https://example.org/chess', cite_title_0: 'Chess rules', cite_retrieved_0: '2026-09-20', cite_quote_0: 'sixty-four squares',
        } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        assert.strictEqual(r.headers.get('location'), '/w/board-games/chess');

        // The published page read without any script: content, infobox, sources, history link.
        r = await H.req(h, 'GET', '/w/board-games/chess');
        assert.strictEqual(r.status, 200);
        const page = stripScripts(r.text);
        assert.ok(page.includes('<h1>Chess</h1>'));
        assert.ok(page.includes('Chess is played on a board of sixty-four squares.'));
        assert.ok(/<tr data-key="players" data-type="number"><th scope="row">Players<\/th><td>2<\/td><\/tr>/.test(page));
        assert.ok(page.includes('href="https://example.org/chess"'));
        assert.ok(page.includes('retrieved <time datetime="2026-09-20T00:00:00.000Z">2026-09-20</time>'));
        assert.ok(page.includes('href="/w/board-games/chess/history"'));
        assert.ok(page.includes('<nav class="ov-breadcrumbs"'));
        // Red links: anonymous readers get plain text, not a dead link.
        assert.ok(page.includes('<span class="ov-wikilink ov-redlink" title="Go (page does not exist)">Go</span>'));
        // Structured data only from real fields (no invented author or image).
        const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const article = ld.find((x) => x['@type'] === 'Article');
        assert.strictEqual(article.headline, 'Chess');
        assert.strictEqual(article.author, undefined);
        assert.strictEqual(article.image, undefined);
        assert.deepStrictEqual(article.citation, [{ '@type': 'CreativeWork', url: 'https://example.org/chess', name: 'Chess rules' }]);
        // The JSON representation describes the same content.
        const j = (await H.req(h, 'GET', '/w/board-games/chess.json')).json;
        assert.strictEqual(j.title, 'Chess');
        assert.strictEqual(j.citations[0].retrieved_at, '2026-09-20T00:00:00.000Z');
        assert.deepStrictEqual(j.infobox, [{ key: 'players', label: 'Players', type: 'number', value: 2 }]);

        // Editors get red links that open the new-page form with the title filled in.
        r = await H.req(h, 'GET', '/w/board-games/chess', { cookie });
        assert.ok(r.text.includes('href="/w/board-games/go/edit?title=Go"'));
        r = await H.req(h, 'GET', '/w/board-games/go/edit?title=Go', { cookie });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), '/s/board-games/new?title=Go');
        r = await H.req(h, 'POST', '/s/board-games/new', { cookie, form: { op: 'publish', title: 'Go', body: `Go is played with stones. Compare [[Chess]]. ${H.LONG}`, cite_url_0: 'https://example.org/go', cite_retrieved_0: '2026-09-21' } });
        assert.strictEqual(r.status, 303);
        r = await H.req(h, 'GET', '/w/board-games/chess');
        assert.ok(r.text.includes('<a class="ov-wikilink" href="/w/board-games/go">Go</a>'), 'the red link turned blue');
        assert.ok(r.text.includes('What links here'), 'backlinks from Go');

        // Edit form: prefilled, keeps sources by default, publishes a new revision.
        r = await H.req(h, 'GET', '/w/board-games/chess/edit', { cookie });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('name="expected_revision" value="1"'));
        assert.ok(r.text.includes('name="keep_citation"'));
        const citeId = r.text.match(/name="keep_citation" value="(\d+)"/)[1];
        r = await H.req(h, 'POST', '/w/board-games/chess/edit', { cookie, form: { op: 'publish', expected_revision: '1', base_revision: '1', title: 'Chess', body: `${body} Castling exists.`, infobox: 'Players | number | 2', keep_citation: citeId } });
        assert.strictEqual(r.status, 303);
        r = await H.req(h, 'GET', '/w/board-games/chess');
        assert.ok(r.text.includes('Castling exists.'));
        assert.ok(r.text.includes('href="https://example.org/chess"'), 'the kept source moved to revision 2');
        // A stale form is a conflict, and the typed text survives.
        r = await H.req(h, 'POST', '/w/board-games/chess/edit', { cookie, form: { op: 'save', expected_revision: '1', base_revision: '1', title: 'Chess', body: 'My stale text', infobox: '' } });
        assert.strictEqual(r.status, 409);
        assert.ok(r.text.includes('My stale text'));

        // Revert through the form.
        r = await H.req(h, 'GET', '/w/board-games/chess/revert?to=1', { cookie });
        assert.strictEqual(r.status, 200);
        r = await H.req(h, 'POST', '/w/board-games/chess/revert', { cookie, form: { to: '1', expected_revision: '2' } });
        assert.strictEqual(r.status, 303);
        r = await H.req(h, 'GET', '/w/board-games/chess');
        assert.ok(!r.text.includes('Castling exists.'));
        assert.ok(r.text.includes('Revision 3 (a revert to revision 1)'));
        // History compare form → diff page.
        r = await H.req(h, 'GET', '/w/board-games/chess/compare?a=3&b=2');
        assert.strictEqual(r.headers.get('location'), '/w/board-games/chess/diff/2/3');

        // Page settings: move with the form; the old address redirects.
        r = await H.req(h, 'POST', '/w/board-games/chess/settings', { cookie, form: { op: 'move', slug: 'chess-game', parent_id: '' } });
        assert.strictEqual(r.status, 303);
        r = await H.req(h, 'GET', '/w/board-games/chess');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.get('location'), '/w/board-games/chess-game');
        // Links written as [[Chess]] still resolve through the redirect.
        r = await H.req(h, 'GET', '/w/board-games/go');
        assert.ok(r.text.includes('href="/w/board-games/chess-game"'));

        // Watch with a form.
        r = await H.req(h, 'POST', '/w/board-games/go/watch', { cookie, form: { on: '1' } });
        assert.strictEqual(r.status, 303);
        assert.ok((await H.req(h, 'GET', '/w/board-games/go', { cookie })).text.includes('Stop watching'));

        // Cross-site form posts are refused.
        r = await H.req(h, 'POST', '/w/board-games/go/watch', { cookie, headers: { Origin: 'https://evil.example' }, form: { on: '0' } });
        assert.strictEqual(r.status, 403);

        // Search without JavaScript.
        r = await H.req(h, 'GET', '/search?q=stones');
        assert.ok(r.text.includes('href="/w/board-games/go"'));
        // Discussion degrades to an explicit state when Community is not configured.
        r = await H.req(h, 'GET', '/w/board-games/go');
        assert.ok(r.text.includes('could not be loaded right now'));
        console.log('nojs ok');
    } finally {
        await h.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
