'use strict';
/**
 * Seed import: an official space and its pages from a JSON file (seeds/openvibe.json).
 *
 * Idempotent: an existing space is reused and a page whose slug exists is left alone (never
 * overwritten), so running it twice changes nothing. Authorship is recorded as `imported` with the
 * truth about where the text comes from: summaries of the cited repository READMEs/STATUS files,
 * written with AI assistance (`importedFrom.aiAssisted`). Pages are published and readable with that
 * disclosure, but the gate keeps them noindex (out of sitemaps, feeds and Search) until a person
 * reviews each revision (service.reviewRevision). Every page carries URL citations (permalinks at the commit read, with
 * the retrieval time) on the revision that uses them.
 *
 * With { revise: true } an existing page whose title, body, summary, infobox or citations differ
 * from the seed gets ONE new published revision through the editor's own path (service.editPage +
 * service.publish), keeping the seed's imported/AI-assisted authorship marking. A page with no
 * change gets no revision, so a second revise run is a no-op.
 */
const { pageSlug, normalizeInfobox } = require('./content');

const SYSTEM = Object.freeze({ kind: 'system', service: 'svc:wiki', subject: null });
const IMPORTED = {
    mode: 'imported',
    importedFrom: {
        label: 'the OpenVibe repository README and STATUS files at the cited commits, summarised with AI assistance',
        originalAuthor: 'OpenVibers',
        // Generated text: held noindex (the gate's ai_generated_unreviewed) until a person reviews it.
        aiAssisted: true,
    },
};

/** The seed's citations in the shape createPage/editPage take. */
function citationInputs(cites) {
    return (cites || []).map((c) => ({ url: c.url, title: c.title || null, retrievedAt: c.retrievedAt, quote: c.quote ? { text: c.quote } : null, licenseNote: c.licenseNote || null }));
}

/** Key-order-independent JSON, for comparing values that round-tripped through jsonb (which sorts keys). */
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
    return JSON.stringify(value === undefined ? null : value);
}

/** One citation as stored vs as seeded: the fields that decide "same source". */
function citationKey(c) {
    return JSON.stringify({
        url: c.url ? new URL(c.url).toString() : null,
        title: c.title || null,
        retrievedAt: c.retrievedAt || null,
        quote: c.quote ? String(typeof c.quote === 'string' ? c.quote : c.quote.text) : null,
        licenseNote: c.licenseNote || null,
    });
}

/** Whether the current head revision already carries exactly what the seed says. */
function sameRevision(head, cites, def) {
    if (head.content !== (def.body == null ? '' : def.body)) return false;
    const fields = head.fields || {};
    if ((fields.title || null) !== def.title) return false;
    if ((fields.summary || null) !== (def.summary || null)) return false;
    if (stable(fields.infobox || []) !== stable(normalizeInfobox(def.infobox || []))) return false;
    const seeded = citationInputs(def.citations);
    if (cites.length !== seeded.length) return false;
    return cites.every((c, i) => citationKey(c) === citationKey(seeded[i]));
}

/**
 * Create one new published revision when the seed differs from the page's head revision. Returns
 * true when a revision was created (published when `publish`).
 */
async function revisePage(svc, page, def, { publish, log }) {
    const head = (await svc.history(page, { limit: 1, actor: SYSTEM }))[0];
    if (!head) return false;
    const cites = await svc.citationsOf(page, head.number);
    if (sameRevision(head, cites, def)) return false;
    const out = await svc.editPage(page.id, {
        expectedRevision: head.number,
        title: def.title,
        body: def.body,
        summary: def.summary || null,
        infobox: def.infobox || [],
        citations: citationInputs(def.citations),
        keepCitations: 'none',   // the seed states the whole list; never duplicate the old one
        message: 'Seed import',
        authorship: IMPORTED,    // the seed's own marking, kept exactly (system actor only)
        allowUnchanged: true,    // a change to the citations alone still needs a new revision
    }, SYSTEM);
    if (!out.created) return false;
    if (publish) await svc.publish(page.id, { revision: out.revision.number }, SYSTEM);
    log.log(`[seed] revised ${def.title} → revision ${out.revision.number}`);
    return true;
}

async function seed(svc, data, { publish = true, revise = false, log = console } = {}) {
    if (!data || !data.space || !Array.isArray(data.pages)) throw new TypeError('seed data needs { space, pages }');
    let space = await svc.findSpace(data.space.slug);
    if (!space) {
        space = await svc.createSpace({ slug: data.space.slug, name: data.space.name, description: data.space.description, kind: data.space.kind || 'official', visibility: data.space.visibility || 'public' }, SYSTEM);
        log.log(`[seed] created space ${space.slug}`);
    }
    const bySlug = new Map();
    const created = [];
    const skipped = [];
    const existing = [];
    // Parents first: a page whose parent is not created yet waits for the next pass.
    let pending = [...data.pages];
    for (let pass = 0; pending.length && pass < 10; pass++) {
        const next = [];
        for (const p of pending) {
            const slug = pageSlug(p.title);
            const found = await svc.findPage(space.id, slug);
            if (found) { bySlug.set(slug, found); skipped.push(p.title); existing.push({ def: p, page: found }); continue; }
            let parentId = null;
            if (p.parent) {
                const parent = bySlug.get(pageSlug(p.parent)) || await svc.findPage(space.id, pageSlug(p.parent));
                if (!parent) { next.push(p); continue; }
                parentId = parent.id;
            }
            const out = await svc.createPage(space.id, {
                title: p.title, body: p.body, summary: p.summary || null, infobox: p.infobox || [], parentId,
                citations: citationInputs(p.citations),
                message: 'Seed import', authorship: IMPORTED,
            }, SYSTEM);
            if (publish) await svc.publish(out.page.id, { revision: out.revision.number }, SYSTEM);
            bySlug.set(slug, await svc.pageById(out.page.id));
            created.push(p.title);
        }
        pending = next;
    }
    if (pending.length) throw new Error(`seed: parents not found for ${pending.map((p) => p.title).join(', ')}`);
    // Revise existing pages in place: one new published revision each, only where the seed changed.
    const revised = [];
    const unchanged = [];
    if (revise) {
        for (const { def, page } of existing) {
            if (page.state === 'deleted') { unchanged.push(def.title); continue; }
            (await revisePage(svc, page, def, { publish, log }) ? revised : unchanged).push(def.title);
        }
    }
    return { space: await svc.findSpace(data.space.slug), created, skipped, revised, unchanged };
}

module.exports = { seed, SYSTEM, IMPORTED };
