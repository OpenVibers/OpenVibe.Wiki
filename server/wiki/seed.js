'use strict';
/**
 * Seed import: an official space and its pages from a JSON file (seeds/openvibe.json).
 *
 * Idempotent: an existing space is reused and a page whose slug exists is left alone (never
 * overwritten), so running it twice changes nothing. Authorship is recorded as `imported` with the
 * truth about where the text comes from: summaries of the cited repository READMEs/STATUS files,
 * written with AI assistance. Every page carries URL citations (permalinks at the commit read, with
 * the retrieval time) on the revision that uses them.
 */
const { pageSlug } = require('./content');

const SYSTEM = Object.freeze({ kind: 'system', service: 'svc:wiki', subject: null });
const IMPORTED = {
    mode: 'imported',
    importedFrom: {
        label: 'the OpenVibe repository README and STATUS files at the cited commits, summarised with AI assistance',
        originalAuthor: 'OpenVibers',
    },
};

function seed(svc, data, { publish = true, log = console } = {}) {
    if (!data || !data.space || !Array.isArray(data.pages)) throw new TypeError('seed data needs { space, pages }');
    let space = svc.findSpace(data.space.slug);
    if (!space) {
        space = svc.createSpace({ slug: data.space.slug, name: data.space.name, description: data.space.description, kind: data.space.kind || 'official', visibility: data.space.visibility || 'public' }, SYSTEM);
        log.log(`[seed] created space ${space.slug}`);
    }
    const bySlug = new Map();
    const created = [];
    const skipped = [];
    // Parents first: a page whose parent is not created yet waits for the next pass.
    let pending = [...data.pages];
    for (let pass = 0; pending.length && pass < 10; pass++) {
        const next = [];
        for (const p of pending) {
            const slug = pageSlug(p.title);
            const existing = svc.findPage(space.id, slug);
            if (existing) { bySlug.set(slug, existing); skipped.push(p.title); continue; }
            let parentId = null;
            if (p.parent) {
                const parent = bySlug.get(pageSlug(p.parent)) || svc.findPage(space.id, pageSlug(p.parent));
                if (!parent) { next.push(p); continue; }
                parentId = parent.id;
            }
            const out = svc.createPage(space.id, {
                title: p.title, body: p.body, summary: p.summary || null, infobox: p.infobox || [], parentId,
                citations: (p.citations || []).map((c) => ({ url: c.url, title: c.title || null, retrievedAt: c.retrievedAt, quote: c.quote ? { text: c.quote } : null, licenseNote: c.licenseNote || null })),
                message: 'Seed import', authorship: IMPORTED,
            }, SYSTEM);
            if (publish) svc.publish(out.page.id, { revision: out.revision.number }, SYSTEM);
            bySlug.set(slug, svc.pageById(out.page.id));
            created.push(p.title);
        }
        pending = next;
    }
    if (pending.length) throw new Error(`seed: parents not found for ${pending.map((p) => p.title).join(', ')}`);
    return { space: svc.findSpace(data.space.slug), created, skipped };
}

module.exports = { seed, SYSTEM, IMPORTED };
