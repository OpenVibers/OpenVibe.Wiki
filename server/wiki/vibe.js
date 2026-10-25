'use strict';
/**
 * "Vibe a wiki": a person names any topic and gets a whole wiki about it, researched from the web, written page by page
 * with sources and pictures, in a new wiki they own.
 *
 *   1. research   OpenVibe.AI research.gather (MegaSource: Wikipedia, the topic's Fandom wiki, Wikidata, DeepSeek web
 *                 search, Commons, Openverse) for the topic as a whole
 *   2. plan       wiki.generate_space: the wiki's name, summary and pages (main page first), from that research
 *   3. write      for each page, its own research (the page's subject inside the topic) and wiki.generate_page; the
 *                 pictures it picks are fetched safely (integrations/image-fetch.js), stored in OpenVibe.Media for the
 *                 person (public, with where they came from), placed in the text and attached; the page is imported
 *                 like any AI-assisted page (published with the disclosure, noindex until a person reviews it)
 *
 * The wiki's pages say the text was written with AI and cite every source they rest on, pictures included (licence and
 * credit). Nothing is invented: a page the sources cannot support is not written (it stays a red link to create).
 *
 * The job is one wiki_vibes row a worker takes under a lease. Progress is saved after every step, so a restart or a
 * refusal resumes where it stopped (pages already made are skipped); AI's quota or queue being full (429) waits for its
 * Retry-After. Limits: WIKI_VIBE_PER_PERSON_DAY and WIKI_VIBE_PER_DAY.
 */
const crypto = require('crypto');
const { ulid } = require('openvibe-contracts').ids;
const content = require('./content');
const importer = require('./import');
const { fetchImage } = require('../integrations/image-fetch');

const SIZES = ['quick', 'standard', 'big'];
const ACTIVE = ['queued', 'researching', 'planning', 'writing'];
// A job's lease is renewed every minute while it runs, so a restart frees it within LEASE_MS.
const LEASE_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGES_PER_PAGE = 3;
// How the main page groups the rest, by what the plan says each page is about.
const GROUP = { character: 'Characters', person: 'People', episode: 'Episodes', season: 'Seasons', work: 'Works', place: 'Places', group: 'Groups and organizations',
    object: 'Things', concept: 'Ideas and themes', event: 'Events', production: 'Behind the scenes', reception: 'Reception', list: 'Lists', other: 'More' };
// What research.gather's providers are called where people read them.
const SOURCE_NAMES = { wikipedia: 'Wikipedia', fandom: 'Fandom', wikidata: 'Wikidata', deepseek: 'the web', web: 'the web', commons: 'Wikimedia Commons', openverse: 'Openverse', wikipedia_images: 'Wikipedia', wikidata_image: 'Wikidata' };
const sourceNames = (list) => [...new Set((list || []).map((k) => SOURCE_NAMES[k] || k))];
const GROUP_ORDER = ['character', 'person', 'work', 'season', 'episode', 'place', 'group', 'object', 'concept', 'event', 'production', 'reception', 'list', 'other'];

class VibeError extends Error {
    constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; if (extra) Object.assign(this, extra); }
}

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const clip = (s, n) => { const t = String(s || '').trim(); return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '')}…`; };

/** An ASCII space slug for a topic ("Pokémon Red" → "pokemon-red"), or null when nothing Latin is left. */
function spaceSlugFor(topic) {
    const s = String(topic || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
    return s.length >= 2 ? s : null;
}

/** The plan as the job keeps it: unique titles (by slug), the main page first, at most `max` pages. */
function normalizePlan(output, topic, max) {
    const pages = [];
    const seen = new Set();
    const add = (p) => {
        const title = oneLine(p && p.title, 120).replace(/[[\]|]/g, '').trim();
        if (!title) return;
        let slug;
        try { slug = content.pageSlug(title); } catch { return; }
        if (seen.has(slug)) return;
        seen.add(slug);
        pages.push({
            title, slug,
            kind: GROUP[p.kind] || p.kind === 'overview' ? p.kind : 'other',
            parent: oneLine(p.parent, 120),
            outline: (Array.isArray(p.outline) ? p.outline : []).map((h) => oneLine(h, 80)).filter(Boolean).slice(0, 8),
            query: oneLine(p.query, 120),
            status: 'waiting',
        });
    };
    const list = Array.isArray(output && output.pages) ? output.pages : [];
    const main = list.find((p) => p && p.kind === 'overview') || list[0] || { title: topic };
    add({ ...main, kind: 'overview', parent: '' });
    for (const p of list) if (p !== main && pages.length < max) add(p);
    return {
        title: oneLine(output && output.title, 120) || oneLine(topic, 120),
        summary: clip(output && output.summary, 1000),
        pages,
    };
}

/** The sources a page cited (indices in any `citations` array of the writer's output); all of them when it cited none. */
function citedIndices(output, count) {
    const set = new Set();
    const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== 'object') return;
        for (const [k, x] of Object.entries(v)) {
            if (k === 'citations' && Array.isArray(x)) x.forEach((i) => { if (Number.isInteger(i) && i >= 0 && i < count) set.add(i); });
            else walk(x);
        }
    };
    walk(output);
    return set.size ? [...set].sort((a, b) => a - b) : [...Array(count).keys()];
}

/** A picture's credit line: who made it or where it is from, and its licence. */
function creditOf(img) {
    let site = null;
    try { site = img.source_url ? new URL(img.source_url).hostname.replace(/^www\./, '') : null; } catch { /* no site */ }
    const who = oneLine(img.author, 80) || site || oneLine(img.provider, 40);
    // A picture that is not freely licensed is shown to identify the subject; its owners keep the copyright.
    const terms = img.free ? oneLine(img.license, 60) : '© its owners';
    return [who ? `Picture: ${who}` : 'Picture', terms || null].filter(Boolean).join(', ');
}

/** Source numbers a writer left in the text ("…stories.[0][2]"): the page lists its sources, so they go. Links stay. */
function stripMarkers(text) {
    return String(text || '').replace(/(?:\s?\[\d{1,2}(?:\s*[,–-]\s*\d{1,2})*\])+(?![(:])/g, '').replace(/[ \t]+([.,;:!?])/g, '$1');
}

/** The Markdown of one page from the writer's output: lead, sections with their pictures, and the main page's contents. */
function composeBody(out, { placed = new Map(), contents = null }) {
    const parts = [];
    const lead = stripMarkers(out.lead).trim();
    if (lead) parts.push(lead);
    const used = new Set();
    for (const sec of Array.isArray(out.sections) ? out.sections : []) {
        const heading = oneLine(sec.heading, 120).replace(/^#+\s*/, '');
        const body = stripMarkers(sec.body).trim().replace(/^#{1,2}\s/gm, '### ');
        if (!heading || !body) continue;
        const key = heading.toLowerCase();
        const pic = placed.get(key);
        parts.push(`## ${heading}${pic && !used.has(key) ? `\n\n[[media:${pic.mediaId}|${pic.caption.replace(/[[\]|]/g, '')}]]` : ''}\n\n${body}`);
        if (pic) used.add(key);
    }
    // Pictures for headings the writer did not use go under the lead.
    const loose = [...placed.entries()].filter(([k]) => k !== 'lead' && !used.has(k)).map(([, p]) => `[[media:${p.mediaId}|${p.caption.replace(/[[\]|]/g, '')}]]`);
    if (loose.length) parts.splice(lead ? 1 : 0, 0, loose.join('\n\n'));
    if (contents) parts.push(contents);
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The main page's "In this wiki": every other planned page, grouped by kind (links turn blue as pages are written). */
function contentsOf(plan) {
    const rest = plan.pages.slice(1);
    if (!rest.length) return null;
    const groups = new Map();
    for (const p of rest) { const k = GROUP[p.kind] ? p.kind : 'other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    const blocks = GROUP_ORDER.filter((k) => groups.has(k)).map((k) => `### ${GROUP[k]}\n\n${groups.get(k).map((p) => `- [[${p.title}]]`).join('\n')}`);
    return `## In this wiki\n\n${blocks.join('\n\n')}`;
}

function createVibes({ db, svc, platform, config, now = () => Date.now(), log = console, fetchImg = fetchImage }) {
    const cfg = config.vibe || {};
    const pagesFor = (size) => (cfg.pages && cfg.pages[size]) || { quick: 6, standard: 12, big: 24 }[size] || 12;
    const owner = `wiki-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const q = {
        insert: db.prepare(`INSERT INTO wiki_vibes (id, space_id, topic, lang, size, status, requested_by, progress, created_at, updated_at)
                            VALUES (@id, @space_id, @topic, @lang, @size, 'queued', @requested_by, '{}'::jsonb, @now, @now)`),
        get: db.prepare('SELECT * FROM wiki_vibes WHERE id = ?'),
        bySpace: db.prepare('SELECT * FROM wiki_vibes WHERE space_id = ? ORDER BY created_at DESC LIMIT 1'),
        mine: db.prepare('SELECT * FROM wiki_vibes WHERE requested_by = ? ORDER BY created_at DESC LIMIT ?'),
        countMine: db.prepare('SELECT COUNT(*)::int AS n FROM wiki_vibes WHERE requested_by = ? AND created_at > ?'),
        countAll: db.prepare('SELECT COUNT(*)::int AS n FROM wiki_vibes WHERE created_at > ?'),
        recentDone: db.prepare(`SELECT v.* FROM wiki_vibes v JOIN wiki_spaces s ON s.id = v.space_id
                                WHERE v.status = 'done' AND s.deleted_at IS NULL AND s.visibility = 'public' ORDER BY v.finished_at DESC LIMIT ?`),
        claim: db.prepare(`UPDATE wiki_vibes SET lease_owner = @owner, lease_until = @until, updated_at = @now
                           WHERE id = (SELECT id FROM wiki_vibes WHERE status IN ('queued','researching','planning','writing')
                                         AND (retry_at IS NULL OR retry_at <= @now) AND (lease_until IS NULL OR lease_until < @now)
                                       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
                           RETURNING *`),
        renew: db.prepare('UPDATE wiki_vibes SET lease_until = ? WHERE id = ? AND lease_owner = ?'),
        save: db.prepare(`UPDATE wiki_vibes SET status = @status, plan = @plan::jsonb, progress = @progress::jsonb, error = @error, attempts = @attempts,
                          retry_at = @retry_at, lease_owner = @lease_owner, lease_until = @lease_until, updated_at = @now, finished_at = @finished_at WHERE id = @id`),
    };

    function requirePerson(actor) {
        if (!actor || actor.kind !== 'user' || !/^usr_/.test(String(actor.subject || ''))) throw new VibeError(401, 'vibe.sign_in', 'Sign in with your OpenVibe account to vibe a wiki');
        return actor.subject;
    }

    async function freeSlug(base) {
        const root = base || `wiki-${crypto.randomBytes(3).toString('hex')}`;
        for (const s of [root, `${root}-wiki`, ...[2, 3, 4, 5, 6].map((n) => `${root}-${n}`), `${root}-${crypto.randomBytes(2).toString('hex')}`]) {
            if (!content.SPACE_SLUG_RE.test(s)) continue;
            if (!await svc.findSpace(s)) return s;
        }
        throw new VibeError(409, 'vibe.slug_taken', 'Every address for this topic is taken; try naming it differently');
    }

    /** Start one: checks, the person's new wiki, the job. → { vibe, space } */
    async function start({ topic, size = 'standard', visibility = 'public', lang = 'en' } = {}, actor) {
        const who = requirePerson(actor);
        const name = oneLine(topic, 120);
        if (name.replace(/[^\p{L}\p{N}]/gu, '').length < 2) throw new VibeError(422, 'vibe.invalid_topic', 'Name a topic: a show, a game, a place, a person, an idea');
        if (!SIZES.includes(size)) throw new VibeError(422, 'vibe.invalid_size', 'size is quick, standard or big');
        if (!['public', 'private'].includes(visibility)) throw new VibeError(422, 'vibe.invalid_visibility', 'visibility is public or private');
        const language = /^[a-z]{2,3}$/.test(lang || '') ? lang : 'en';
        if (!platform.ai.configured || !platform.media.configured) throw new VibeError(503, 'vibe.unavailable', 'Generating wikis needs OpenVibe.AI and OpenVibe.Media, and one of them is not configured here');
        const since = now() - DAY_MS;
        if ((await q.countMine.get(who, since)).n >= (cfg.perPersonDay || 3)) throw new VibeError(429, 'vibe.daily_limit', `You can vibe ${cfg.perPersonDay || 3} wikis a day; try again tomorrow`, { retryAfter: 3600 });
        if ((await q.countAll.get(since)).n >= (cfg.perDay || 30)) throw new VibeError(429, 'vibe.busy', 'Today\'s wikis are all being written; try again later', { retryAfter: 3600 });
        const slug = await freeSlug(spaceSlugFor(name));
        const space = await svc.createSpace({ slug, name, description: `A wiki about ${name}, being researched and written by AI.`, kind: 'user', visibility }, actor);
        const id = `vib_${ulid(now())}`;
        await q.insert.run({ id, space_id: space.id, topic: name, lang: language, size, requested_by: who, now: now() });
        if (timer) setImmediate(() => { tick().catch((err) => log.warn(`[Vibe] ${err && err.message}`)); });   // a running worker starts it now
        return { vibe: await q.get.get(id), space };
    }

    /** The public shape of a job (what /vibe/:id and the API show). */
    function present(v, space) {
        const progress = v.progress || {};
        const pages = (v.plan && v.plan.pages) || [];
        const state = progress.pages || {};
        const list = pages.map((p) => ({ title: p.title, kind: p.kind, status: (state[p.slug] && state[p.slug].status) || 'waiting', url: state[p.slug] && state[p.slug].status === 'done' ? `/w/${encodeURIComponent(space.slug)}/${encodeURIComponent(p.slug)}` : null, images: (state[p.slug] && state[p.slug].images) || 0, sources: (state[p.slug] && state[p.slug].sources) || 0 }));
        return {
            id: v.id, topic: v.topic, size: v.size, status: v.status,
            space: { slug: space.slug, name: space.name, url: `/s/${encodeURIComponent(space.slug)}`, visibility: space.visibility },
            research: progress.research ? { sources: progress.research.sources.length, images: progress.research.images.length, from: sourceNames(progress.research.from), topic_wiki: progress.research.topic_wiki || null } : null,
            pages: list,
            done: list.filter((p) => p.status === 'done').length,
            total: list.length,
            error: v.status === 'failed' ? v.error : null,
            waiting_until: v.retry_at && v.retry_at > now() ? new Date(Number(v.retry_at)).toISOString() : null,
            created_at: new Date(Number(v.created_at)).toISOString(),
            finished_at: v.finished_at ? new Date(Number(v.finished_at)).toISOString() : null,
            main_page: list[0] && list[0].url ? list[0].url : null,
        };
    }

    async function get(id, actor) {
        const v = /^vib_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || '')) ? await q.get.get(id) : null;
        if (!v) return null;
        const space = await svc.spaceById(v.space_id);
        if (!space || space.deleted_at) return null;
        await svc.access.loadRoles(actor || { kind: 'anonymous' }, { fresh: true });
        if (!svc.access.canReadSpace(space, actor || { kind: 'anonymous' })) return null;
        return present(v, space);
    }

    async function mine(actor, limit = 20) {
        const who = requirePerson(actor);
        const rows = await q.mine.all(who, limit);
        const out = [];
        for (const v of rows) { const space = await svc.spaceById(v.space_id); if (space && !space.deleted_at) out.push(present(v, space)); }
        return out;
    }

    async function recent(limit = 12) {
        const rows = await q.recentDone.all(limit);
        const out = [];
        for (const v of rows) { const space = await svc.spaceById(v.space_id); if (space && !space.deleted_at) out.push(present(v, space)); }
        return out;
    }

    // ── The worker ──────────────────────────────────────────
    let running = false;
    let timer = null;

    async function save(v, patch = {}) {
        Object.assign(v, patch);
        await q.save.run({
            id: v.id, status: v.status, plan: JSON.stringify(v.plan || null), progress: JSON.stringify(v.progress || {}), error: v.error || null,
            attempts: v.attempts || 0, retry_at: v.retry_at || null, lease_owner: v.lease_owner || null, lease_until: v.lease_until || null,
            now: now(), finished_at: v.finished_at || null,
        });
    }

    async function tick() {
        if (running) return false;
        running = true;
        try {
            const v = await q.claim.get({ owner, until: now() + LEASE_MS, now: now() });
            if (!v) return false;
            const beat = setInterval(() => { q.renew.run(now() + LEASE_MS, v.id, owner).catch(() => {}); }, HEARTBEAT_MS);
            if (beat.unref) beat.unref();
            try { await runJob(v); } finally { clearInterval(beat); }
            return true;
        } finally { running = false; }
    }

    function startWorker() {
        if (timer) return;
        const loop = () => { tick().then((worked) => { timer = setTimeout(loop, worked ? 200 : (cfg.intervalMs || 5000)); timer.unref && timer.unref(); }, (err) => { log.warn(`[Vibe] worker: ${err && err.message}`); timer = setTimeout(loop, cfg.intervalMs || 5000); timer.unref && timer.unref(); }); };
        timer = setTimeout(loop, 1000);
        timer.unref && timer.unref();
    }
    function stopWorker() { if (timer) clearTimeout(timer); timer = null; }

    const sourceForAi = (s, chars) => ({ ...s, content: clip(s.content, chars), snippet: s.snippet ? clip(s.snippet, 400) : undefined });

    async function runJob(v) {
        const actor = { kind: 'user', subject: v.requested_by, staff: false };
        const space = await svc.spaceById(v.space_id);
        if (!space || space.deleted_at) { await save(v, { status: 'cancelled', error: 'The wiki was deleted', lease_owner: null, lease_until: null, finished_at: now() }); return; }
        v.progress = v.progress || {};
        const ai = (workflow, input, key) => platform.ai.run(workflow, input, { subject: v.requested_by, idempotencyKey: `vibe:${v.id}:${key}`, totalMs: 300000 });
        try {
            // 1. Research the topic.
            if (!v.progress.research) {
                await save(v, { status: 'researching', error: null });
                const r = await ai('research.gather', { query: v.topic, topic: v.topic, lang: v.lang, max_sources: 14, max_images: 16, content_chars: 4500 }, 'research');
                const out = r.output || {};
                if (!out.sources || !out.sources.length) throw new VibeError(422, 'vibe.nothing_found', `Nothing could be found about "${v.topic}". Try its full name or another spelling.`);
                v.progress.research = {
                    sources: out.sources, images: out.images || [], facts: out.facts || [], topic_wiki: out.topic_wiki || null, run: r.runId,
                    from: Object.entries(out.providers || {}).filter(([, p]) => p && p.ok && p.count).map(([k]) => k),
                };
                await save(v);
            }
            const research = v.progress.research;
            // 2. Plan the pages.
            if (!v.plan) {
                await save(v, { status: 'planning' });
                const max = pagesFor(v.size);
                const r = await ai('wiki.generate_space', { topic: v.topic, max_pages: max, sources: research.sources.map((s) => sourceForAi(s, 3500)) }, 'plan');
                const plan = normalizePlan(r.output, v.topic, max);
                plan.run = r.runId;
                v.plan = plan;
                v.progress.pages = {};
                await save(v);
                await svc.updateSpace(space.id, { name: plan.title.slice(0, 120), description: clip(plan.summary || `A wiki about ${v.topic}.`, 1000) }, actor).catch((err) => log.warn(`[Vibe] ${v.id} space details: ${err && err.message}`));
            }
            // 3. Write the pages, a few at a time; the main page first so the rest hang under it.
            await save(v, { status: 'writing' });
            const titles = v.plan.pages.map((p) => p.title);
            const todo = v.plan.pages.filter((p) => !['done', 'failed'].includes((v.progress.pages[p.slug] || {}).status));
            const first = todo[0] && todo[0].slug === v.plan.pages[0].slug ? [todo.shift()] : [];
            for (const p of first) await writeOne(v, space, actor, p, titles, ai);
            const width = cfg.concurrency || 2;
            let next = 0;
            await Promise.all(Array.from({ length: Math.min(width, todo.length) }, async () => {
                while (next < todo.length) { const p = todo[next++]; await writeOne(v, space, actor, p, titles, ai); }
            }));
            // One more try for pages that hit a passing failure.
            for (const p of v.plan.pages.filter((x) => (v.progress.pages[x.slug] || {}).status === 'waiting')) await writeOne(v, space, actor, p, titles, ai);
            const states = Object.values(v.progress.pages);
            const written = states.filter((s) => s.status === 'done').length;
            if (!written) throw new VibeError(502, 'vibe.nothing_written', 'No page could be written from what was found');
            await save(v, { status: 'done', error: null, lease_owner: null, lease_until: null, finished_at: now() });
            await svc.updateSpace(space.id, { description: clip(`${v.plan.summary || `A wiki about ${v.topic}.`}`, 1000) }, actor).catch(() => {});
            log.log(`[Vibe] ${v.id} "${v.topic}": ${written} of ${v.plan.pages.length} pages`);
        } catch (err) {
            if (err && err.status === 429) {
                const wait = Math.max(30, Math.min(Number(err.retryAfter) || 300, 6 * 3600));
                await save(v, { retry_at: now() + wait * 1000, error: `Waiting for OpenVibe.AI: ${err.message}`, lease_owner: null, lease_until: null });
                return;
            }
            const attempts = (v.attempts || 0) + 1;
            const final = attempts >= 3 || (err && err.status && err.status < 500 && err.status !== 408);
            log.warn(`[Vibe] ${v.id} "${v.topic}" ${final ? 'failed' : 'will retry'}: ${err && err.message}`);
            await save(v, {
                attempts, error: oneLine(err && err.message, 500) || 'failed',
                ...(final ? { status: 'failed', finished_at: now() } : { retry_at: now() + attempts * 60000 }),
                lease_owner: null, lease_until: null,
            });
        }
    }

    async function writeOne(v, space, actor, p, titles, ai) {
        const state = v.progress.pages[p.slug] || {};
        v.progress.pages[p.slug] = { ...state, status: 'writing' };
        await save(v);
        await q.renew.run(now() + LEASE_MS, v.id, owner);
        try {
            const isMain = p.slug === v.plan.pages[0].slug;
            const existing = await svc.findPage(space.id, p.slug);
            if (existing && existing.state !== 'deleted') { v.progress.pages[p.slug] = { status: 'done', sources: 0, images: 0 }; await save(v); return; }
            // The page's own research (the main page reuses the topic's).
            let research = v.progress.research;
            if (!isMain) {
                const r = await ai('research.gather', { query: p.query || `${p.title} ${v.topic}`, topic: v.topic, focus: p.title, lang: v.lang, max_sources: 8, max_images: 10, content_chars: 4000 }, `research:${p.slug}`);
                research = r.output || { sources: [], images: [] };
                // The topic's best source helps every page: its facts and names.
                const lead = v.progress.research.sources[0];
                if (lead && !research.sources.some((s) => s.url === lead.url) && research.sources.length < 10) research = { ...research, sources: [...research.sources, lead] };
            }
            const sources = (research.sources || []).slice(0, 10).map((s) => sourceForAi(s, isMain ? 4000 : 3500));
            if (!sources.length) throw new VibeError(422, 'vibe.page_no_sources', 'nothing was found about it');
            const pictures = (research.images || []).slice(0, 12);
            const r = await ai('wiki.generate_page', {
                title: p.title, topic: v.plan.title || v.topic, space: v.plan.title || v.topic, outline: p.outline, pages: titles,
                images: pictures.map((im) => ({ title: oneLine(im.title, 300) || 'Picture', description: oneLine([im.description, im.license ? `(${im.license})` : ''].filter(Boolean).join(' '), 400) })),
                sources,
            }, `page:${p.slug}`);
            const out = r.output || {};
            // Pictures: fetched, stored in Media for the person, placed by heading.
            const placed = new Map();
            const usedPictures = [];
            for (const pick of (Array.isArray(out.images) ? out.images : []).slice(0, MAX_IMAGES_PER_PAGE)) {
                const img = Number.isInteger(pick.index) ? pictures[pick.index] : null;
                if (!img || usedPictures.includes(img)) continue;
                const key = /^lead$/i.test(String(pick.section || '').trim()) || !pick.section ? 'lead' : oneLine(pick.section, 120).replace(/^#+\s*/, '').toLowerCase();
                if (placed.has(key)) continue;
                try {
                    const got = await fetchImg(img.url, { timeoutMs: 15000 });
                    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[got.mime];
                    const mediaId = await platform.media.upload({
                        bytes: got.bytes, mime: got.mime, filename: `${content.pageSlug(img.title || p.title).slice(0, 60) || 'picture'}.${ext}`, owner: v.requested_by,
                        metadata: { title: oneLine(img.title, 200), source_url: img.source_url || img.url, license: img.license || null, license_url: img.license_url || null, author: img.author || null, free: Boolean(img.free), origin: 'wiki.vibe', vibe: v.id },
                    });
                    const caption = clip(`${oneLine(pick.caption, 220) || oneLine(img.title, 120)} (${creditOf(img)})`, 300);
                    placed.set(key, { mediaId, caption, alt: oneLine(pick.caption || img.title, 200), img });
                    usedPictures.push(img);
                } catch (err) {
                    log.warn(`[Vibe] ${v.id} picture for "${p.title}" skipped: ${err && err.message}`);
                }
            }
            const lead = placed.get('lead');
            const body = composeBody(out, { placed: new Map([...placed].filter(([k]) => k !== 'lead')), contents: isMain ? contentsOf(v.plan) : null });
            if (!body || body.length < 200) throw new VibeError(422, 'vibe.page_too_thin', 'the sources did not say enough for a page');
            const infobox = [];
            if (lead) infobox.push({ label: 'Picture', type: 'media', value: lead.mediaId });
            const keys = new Set(lead ? ['picture'] : []);
            for (const row of Array.isArray(out.infobox) ? out.infobox : []) {
                const label = oneLine(row.label, 60).replace(/\|/g, '/');
                const value = oneLine(row.value, 300);
                const key = content.keyFromLabel(label);
                if (!label || !value || !key || keys.has(key)) continue;
                keys.add(key);
                infobox.push({ label, type: 'text', value });
                if (infobox.length >= 14) break;
            }
            const cited = citedIndices(out, sources.length);
            const citations = cited.map((i) => sources[i]).filter((s) => s && s.url).map((s) => ({
                url: s.url, title: oneLine(s.title, 300) || s.url, retrievedAt: s.retrieved_at || new Date(now()).toISOString(),
                licenseNote: (s.provenance && s.provenance.license) || null,
            }));
            for (const pic of placed.values()) {
                const img = pic.img;
                if (!img.source_url && !img.url) continue;
                citations.push({ url: img.source_url || img.url, title: `Picture: ${oneLine(img.title, 200) || p.title}`, retrievedAt: new Date(now()).toISOString(), licenseNote: oneLine([img.license, img.author].filter(Boolean).join(', '), 300) || null });
            }
            const from = [...new Set(sources.map((s) => (s.provenance && s.provenance.provider) || s.source_type))];
            const bundle = importer.validateBundle({
                pages: [{
                    title: p.title, body, summary: clip(out.summary, 290) || null,
                    parent: isMain ? null : v.plan.pages[0].title,
                    infobox, citations: citations.slice(0, 50),
                    message: clip(`Written by AI from ${citations.length} source${citations.length === 1 ? '' : 's'}`, 290),
                }],
                publish: true, on_existing: 'skip', ai_assisted: true,
                source: clip(`OpenVibe.AI research across ${sourceNames(from).join(', ')}`, 190),
            });
            const made = await svc.importPages(space.id, bundle, actor);
            const page = made.created[0] && made.created[0].page;
            if (page) {
                for (const pic of placed.values()) {
                    await svc.attachMedia(page.id, { mediaId: pic.mediaId, alt: pic.alt, caption: pic.caption, role: pic === lead ? 'cover' : 'inline' }, actor, { describe: platform.media.describe })
                        .catch((err) => log.warn(`[Vibe] ${v.id} attach to "${p.title}": ${err && err.message}`));
                }
            }
            v.progress.pages[p.slug] = { status: 'done', sources: citations.length, images: placed.size, run: r.runId };
        } catch (err) {
            if (err && err.status === 429) { v.progress.pages[p.slug] = { ...state, status: 'waiting' }; await save(v); throw err; }
            const tries = (state.tries || 0) + 1;
            log.warn(`[Vibe] ${v.id} page "${p.title}": ${err && err.message}`);
            v.progress.pages[p.slug] = { status: tries >= 2 || (err && err.status && err.status < 500) ? 'failed' : 'waiting', tries, error: oneLine(err && err.message, 200) };
        }
        await save(v);
    }

    return { start, get, mine, recent, tick, startWorker, stopWorker, SIZES, ACTIVE, pagesFor };
}

module.exports = { createVibes, VibeError, normalizePlan, composeBody, contentsOf, citedIndices, creditOf, spaceSlugFor, stripMarkers, SIZES };
