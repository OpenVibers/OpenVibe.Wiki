'use strict';
/**
 * wiki.images.suggest — the article's lead picture and figures, from the wiki.article.images AI task.
 *
 * The order is the plan's: Wikimedia Commons and Openverse first, with the licence and the author kept;
 * OpenVibe.Pics' public gallery next; the page's own Media after that. An AI illustration is made only
 * when nothing real exists, is labelled "Illustration made with <model>", and is never made for an
 * article about a real person. A suggestion is a candidate, not an attachment: the editor picks one,
 * it goes to Media, and only then does it become an attachment.
 */
const { IntegrationError } = require('../integrations/platform');

const TASK = 'wiki.article.images';
const PROVIDERS = ['commons', 'openverse'];
const PERSON_KEYS = /^(born|died|death|birth|date_of_birth|place_of_birth|birth_?(date|place|name)|occupation|nationality|citizenship|spouse|partner|children|parents|mother|father|alma_mater|education|known_for|height|position|office|party|voiced_by|portrayed_by|author|director|actor|actress|singer|musician|writer|artist|politician|person)$/;
const PERSON_TEXT = /\b(was born|is an? (actor|actress|singer|musician|writer|politician|artist|director|author|person|human)|birth name|date of birth|grew up in)\b/i;

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const creditOf = (img) => [oneLine(img.author, 120), oneLine(img.license, 80)].filter(Boolean).join(', ');

/** True when the page is about a real person: then no AI illustration is ever suggested. */
function aboutPerson(v) {
    const rows = Array.isArray(v.infobox) ? v.infobox : [];
    if (rows.some((r) => PERSON_KEYS.test(String(r.key || r.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')))) return true;
    const text = `${v.revision.fields.title || ''}\n${v.revision.fields.summary || ''}\n${v.revision.content || ''}`;
    return PERSON_TEXT.test(text);
}

function fromResearch(images, limit) {
    const out = [];
    const seen = new Set();
    for (const img of Array.isArray(images) ? images : []) {
        if (!img || !img.url || img.free === false) continue;
        const provider = String(img.provider || '').toLowerCase() === 'openverse' ? 'openverse' : 'commons';
        if (!PROVIDERS.includes(provider)) continue;
        const key = img.source_url || img.url;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            provider, role: out.length ? 'figure' : 'lead',
            url: img.url, page_url: img.source_url || null,
            title: oneLine(img.title, 300) || null, author: oneLine(img.author, 200) || null,
            license: oneLine(img.license, 200) || null, license_url: img.license_url || null,
            width: Number.isInteger(img.width) ? img.width : null, height: Number.isInteger(img.height) ? img.height : null,
            alt: oneLine(img.description || img.title, 400) || null,
            caption: oneLine(img.description || img.title, 400) || null,
            credit: creditOf(img) || null, ai: false,
        });
        if (out.length >= limit) break;
    }
    return out;
}

function fromPics(pictures, limit) {
    return (Array.isArray(pictures) ? pictures : []).slice(0, limit).map((p, i) => ({
        provider: 'pics', role: i === 0 ? 'lead' : 'figure',
        url: (p.links && (p.links.original || p.links.direct)) || null,
        page_url: (p.links && p.links.page) || null,
        title: oneLine(p.title, 300) || null, author: oneLine(p.author, 200) || null,
        license: null, license_url: null,
        width: Number.isInteger(Number(p.width)) ? Number(p.width) : null, height: Number.isInteger(Number(p.height)) ? Number(p.height) : null,
        alt: oneLine(p.alt || p.description || p.title, 400) || null,
        caption: oneLine(p.description || p.title, 400) || null,
        credit: ['OpenVibe.Pics', oneLine(p.author, 120)].filter(Boolean).join(', '), ai: false,
    })).filter((p) => p.url);
}

function fromAttachments(v, mediaUrl) {
    return (v.attachments || []).filter((a) => !a.broken && a.mediaId).map((a, i) => ({
        provider: 'media', role: i === 0 ? 'lead' : 'figure', media_id: a.mediaId,
        url: mediaUrl ? mediaUrl(a.mediaId) : null, page_url: mediaUrl ? mediaUrl(a.mediaId) : null,
        title: oneLine(a.caption, 300) || null, author: null, license: null, license_url: null,
        width: null, height: null, alt: oneLine(a.alt, 400) || null, caption: oneLine(a.caption, 400) || null,
        credit: 'OpenVibe.Media', ai: false,
    }));
}

/** One run of the image task; an AI without the task yet answers 404 and the research workflow is used instead. */
async function runTask(ctx, query, { choice = null, subject = null, limit = 8, provider = null } = {}) {
    const input = { query, images: true, max_images: Math.max(4, limit), content_chars: 800 };
    if (provider) {
        // The task's choice names one engine; the plan asks Commons and Openverse, so each call names its own.
        input.providers = [provider];
        choice = { model: `search/${provider}`, source: 'openvibe' };
    }
    try {
        return { ...(await ctx.platform.ai.runTask(TASK, input, { subject, choice })), task: TASK };
    } catch (err) {
        if (!(err instanceof IntegrationError) || !(err.status === 404 || err.status === 422 || err.code === 'task.not_found')) throw err;
        // Before the AI choices system, the same task is the research workflow with both free picture sources.
        const run = await ctx.platform.ai.run('research.gather', { ...input, providers: PROVIDERS }, { subject });
        return { ...run, task: TASK };
    }
}

async function suggest(ctx, pageId, body = {}, actor) {
    const page = await ctx.svc.pageById(pageId);
    if (!page || page.state === 'deleted') throw Object.assign(new Error('No such page'), { status: 404, code: 'page.not_found' });
    const space = await ctx.svc.spaceById(page.space_id);
    if (!space) throw Object.assign(new Error('No such space'), { status: 404, code: 'space.not_found' });
    await ctx.svc.access.loadRoles(actor, { fresh: true });
    if (!ctx.svc.access.canReadPage(space, page, actor)) throw Object.assign(new Error('No such page'), { status: 404, code: 'page.not_found' });
    if (!ctx.svc.access.canEdit(space, actor)) throw Object.assign(new Error('Only editors of this space can suggest pictures'), { status: 403, code: 'page.forbidden' });

    const v = await ctx.svc.view(space, page, actor);
    const limit = Math.max(1, Math.min(12, Number(body.count) || 8));
    const query = oneLine(body.query || [v.revision.fields.title, v.revision.fields.summary].filter(Boolean).join(' '), 300) || page.title;
    const person = aboutPerson(v);
    const suggestions = [];
    let runId = null;
    let note = null;
    let model = null;

    if (ctx.platform.ai.configured) {
        const found = [];
        // Commons and Openverse, both: the task's choice names one engine, so ask each in turn.
        for (const provider of PROVIDERS) {
            try {
                const run = await runTask(ctx, query, { subject: actor && actor.subject, choice: body.choice, limit, provider: provider === 'openverse' ? 'openverse' : 'commons' });
                runId = run.runId || runId;
                found.push(...fromResearch((run.output && run.output.images) || [], limit));
            } catch (err) {
                ctx.log && ctx.log.warn && ctx.log.warn(`[Wiki] images ${pageId}: ${provider}: ${err && err.message}`);
            }
        }
        suggestions.push(...found);
    } else {
        note = 'OpenVibe.AI is not configured here: only Pics and the page\'s own Media are suggested.';
    }

    const seen = new Set(suggestions.map((s) => s.page_url || s.url));
    if (ctx.platform.pics.configured && suggestions.length < limit) {
        try {
            const pictures = await ctx.platform.pics.search(query, { limit: limit - suggestions.length });
            for (const p of fromPics(pictures, limit - suggestions.length)) {
                if (seen.has(p.page_url || p.url)) continue;
                seen.add(p.page_url || p.url);
                suggestions.push(p);
            }
        } catch (err) {
            ctx.log && ctx.log.warn && ctx.log.warn(`[Wiki] images ${pageId}: Pics: ${err && err.message}`);
        }
    }
    for (const a of fromAttachments(v, ctx.platform.media.publicUrl)) {
        if (seen.has(a.page_url || a.url)) continue;
        seen.add(a.page_url || a.url);
        suggestions.push(a);
    }

    // An AI illustration only when nothing real exists, and never of a real person.
    if (!suggestions.length && person) {
        note = 'This article is about a real person: no AI illustration is suggested.';
    } else if (!suggestions.length && body.allow_ai !== false && ctx.platform.ai.configured) {
        try {
            const run = await ctx.platform.ai.run('ai.image', {
                prompt: `A plain editorial illustration for a wiki article titled "${oneLine(v.revision.fields.title, 200)}". ${oneLine(v.revision.fields.summary, 300)} No people, no faces, no real person, no text.`,
                n: 1,
            }, { subject: actor && actor.subject });
            model = run.model || null;
            const image = run.output && Array.isArray(run.output.images) ? run.output.images[0] : null;
            if (image) {
                const label = model || 'AI';
                suggestions.push({
                    provider: 'ai', role: 'lead', url: image.url || null, page_url: null,
                    title: `Illustration for ${oneLine(v.revision.fields.title, 200)}`, author: null,
                    license: null, license_url: null, width: null, height: null,
                    alt: `An illustration for the article ${oneLine(v.revision.fields.title, 200)}`,
                    caption: `Illustration for ${oneLine(v.revision.fields.title, 200)}`,
                    credit: `Illustration made with ${label}`, ai: true, model,
                    data_url: image.b64 ? `data:image/png;base64,${image.b64}` : null,
                });
                runId = run.runId || runId;
            }
        } catch (err) {
            note = `No illustration could be made: ${oneLine(err && err.message, 200)}`;
        }
    } else if (!suggestions.length) {
        note = note || 'No licensed picture was found.';
    }

    return {
        article_id: page.id, task: TASK, query, subject_is_person: person, run_id: runId, note,
        suggestions: suggestions.slice(0, limit).map((s, i) => ({ ...s, role: i === 0 ? 'lead' : 'figure' })),
    };
}

module.exports = { suggest, aboutPerson, TASK, PROVIDERS };
