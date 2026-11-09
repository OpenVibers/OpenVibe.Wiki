'use strict';
/**
 * The wiki writer — OpenVibe.AI's content.wiki workflow, filed as a draft revision for a person.
 *
 * The workflow researches with web search plus the sources the article already cites, writes a citation
 * on every sentence and fills the infobox from structured facts. This module only turns that answer into
 * the Markdown a revision keeps: it composes the sentences, maps the cited ordinals back to their sources,
 * and files the revision through wiki.revision.propose. Nothing here publishes: the proposal waits in the
 * review queue for a person.
 */
const crypto = require('crypto');
const content = require('./content');

const WORKFLOW = 'content.wiki';
const MAX_BODY = 200000;

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** One sentence must cite at least one source: the writer's own promise, checked before the draft is filed. */
function citedSentences(list, where) {
    const out = [];
    for (const [i, s] of (Array.isArray(list) ? list : []).entries()) {
        const text = oneLine(s && s.text, 2000);
        if (!text) continue;
        if (!s || !Array.isArray(s.citations) || !s.citations.length) {
            throw Object.assign(new Error(`${where} sentence ${i + 1} cites no source`), { status: 502, code: 'wiki.citations_missing' });
        }
        out.push({ text, citations: [...new Set(s.citations.filter((n) => Number.isInteger(n) && n >= 0))] });
    }
    return out;
}

/** The Markdown of the writer's answer: the lead, then each section's cited sentences as one paragraph. */
function composeBody(out) {
    const parts = [];
    const lead = citedSentences(out.lead, 'lead').map((s) => s.text).join(' ');
    if (lead) parts.push(lead);
    for (const section of Array.isArray(out.sections) ? out.sections : []) {
        const heading = oneLine(section && section.heading, 160).replace(/^#+\s*/, '');
        const sentences = citedSentences(section && section.sentences, `section "${heading}"`).map((s) => s.text).join(' ');
        if (heading && sentences) parts.push(`## ${heading}\n\n${sentences}`);
    }
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The infobox rows, typed as the wiki stores them; a value that does not fit its type becomes text. */
function composeInfobox(rows) {
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const label = oneLine(row && row.label, 80);
        const value = row && row.value;
        if (!label || value == null || oneLine(value, 500) === '') continue;
        const wanted = ['text', 'number', 'date', 'url', 'boolean', 'page', 'media'].includes(row.type) ? row.type : 'text';
        for (const type of [wanted, 'text']) {
            try {
                const [entry] = content.normalizeInfobox([{ label, type, value }]);
                if (entry) { out.push(entry); break; }
            } catch { /* try the next type */ }
        }
        if (out.length >= 14) break;
    }
    // One row per key: the first the writer gave wins.
    return out.filter((row, i) => out.findIndex((x) => x.key === row.key) === i);
}

/** Every citation ordinal the writer used, mapped to the run's sources. */
function citedSources(out, citations) {
    const used = new Set();
    const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== 'object') return;
        for (const [k, x] of Object.entries(v)) {
            if (k === 'citations' && Array.isArray(x)) x.forEach((n) => { if (Number.isInteger(n) && n >= 0) used.add(n); });
            else walk(x);
        }
    };
    walk(out);
    return [...used].sort((a, b) => a - b)
        .map((n) => (Array.isArray(citations) ? citations.find((c) => c && c.ordinal === n) : null))
        .filter((c) => c && c.url)
        .map((c) => ({
            url: c.url,
            title: oneLine(c.title, 300) || c.url,
            retrievedAt: c.retrieved_at || new Date().toISOString(),
            licenseNote: oneLine((c.provenance && (c.provenance.license || c.provenance.licence)) || '', 300) || null,
        }));
}

async function draft(ctx, pageId, body = {}, actor) {
    const page = await ctx.svc.pageById(pageId);
    if (!page || page.state === 'deleted') throw Object.assign(new Error('No such page'), { status: 404, code: 'page.not_found' });
    const space = await ctx.svc.spaceById(page.space_id);
    if (!space) throw Object.assign(new Error('No such space'), { status: 404, code: 'space.not_found' });
    await ctx.svc.access.loadRoles(actor, { fresh: true });
    if (!ctx.svc.access.canReadPage(space, page, actor)) throw Object.assign(new Error('No such page'), { status: 404, code: 'page.not_found' });
    if (!ctx.svc.access.canEdit(space, actor)) throw Object.assign(new Error('Only editors of this space can write this article'), { status: 403, code: 'page.forbidden' });
    if (!ctx.platform.ai.configured) throw Object.assign(new Error('The wiki writer needs OpenVibe.AI (OV_AI_INTERNAL_URL)'), { status: 503, code: 'ai.unavailable' });

    const v = await ctx.svc.view(space, page, actor);
    const title = v.revision.fields.title || page.title;
    const instruction = oneLine(body.instruction, 4000) || 'Write or improve this article from its sources.';
    // The sources the article already cites go in with the research, so nothing it says before is lost.
    const sources = v.citations.filter((c) => c.url).slice(0, 40).map((c) => {
        // The AI source schema takes strings, never null: leave an unknown field out.
        const source = { source_type: 'wiki', url: c.url, title: c.title || c.url };
        if (c.retrievedAt) source.retrieved_at = c.retrievedAt;
        if (c.quote && c.quote.text) source.content = c.quote.text;
        return source;
    });
    const key = crypto.createHash('sha256').update(JSON.stringify({ page: page.id, head: v.revision.number, instruction })).digest('hex').slice(0, 24);
    const run = await ctx.platform.ai.run(WORKFLOW, {
        title, topic: title, space: space.name, instruction, sources,
        query: title, outline: [], pages: [], lang: 'en',
    }, {
        subject: actor && actor.subject,
        choice: body.choice || null,
        idempotencyKey: `wiki-draft:${page.id}:${key}`,
        totalMs: 300000,
    });
    const out = run.output || {};
    const text = composeBody(out);
    if (text.length < 200) throw Object.assign(new Error('The sources did not say enough to write this article'), { status: 422, code: 'wiki.page_too_thin' });
    if (text.length > MAX_BODY) throw Object.assign(new Error('The draft is too long'), { status: 422, code: 'wiki.page_too_long' });
    const citations = citedSources(out, run.citations);
    if (!citations.length) throw Object.assign(new Error('The writer cited no source with a URL'), { status: 502, code: 'wiki.citations_missing' });
    const infobox = composeInfobox(out.infobox);
    const summary = oneLine(out.summary, 300) || null;
    const filed = await ctx.svc.propose({
        space: space.id, pageId: page.id, title, body: text, summary, infobox,
        citations: citations.slice(0, 50),
        workflow: { id: WORKFLOW, runId: run.runId, model: run.model || null },
        expectedRevision: v.revision.number,
        note: `Written by AI from ${citations.length} source${citations.length === 1 ? '' : 's'}`,
    }, { kind: 'system', service: 'svc:wiki', subject: null });
    return {
        proposal: filed.proposal, revision: filed.revision, run_id: run.runId, model: run.model || null,
        provider: run.provider || null, sources: citations.slice(0, 50),
    };
}

module.exports = { draft, composeBody, composeInfobox, citedSources, WORKFLOW };
