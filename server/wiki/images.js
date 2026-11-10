'use strict';
/**
 * wiki.images.suggest — the article's lead picture and figures, from the shared AI image task
 * (image.picture, rich-content plan §4/§5).
 *
 * Find: Wikimedia Commons and Openverse first, with the licence and the author kept. The task stores each
 * picture in OpenVibe.Media (the wiki tenant), so a suggestion already names its Media object instead of an
 * external URL. OpenVibe.Pics' public gallery and the page's own Media come next. Make: an AI illustration
 * only when nothing real exists, labelled "Illustration made with <model>", and never for an article about a
 * real person. A suggestion is a candidate, not an attachment: the editor picks one and attaches it.
 */
const TASK = 'image.picture';
const PROVIDERS = ['commons', 'openverse'];
const PERSON_KEYS = /^(born|died|death|birth|date_of_birth|place_of_birth|birth_?(date|place|name)|occupation|nationality|citizenship|spouse|partner|children|parents|mother|father|alma_mater|education|known_for|height|position|office|party|voiced_by|portrayed_by|author|director|actor|actress|singer|musician|writer|artist|politician|person)$/;
const PERSON_TEXT = /\b(was born|is an? (actor|actress|singer|musician|writer|politician|artist|director|author|person|human)|birth name|date of birth|grew up in)\b/i;

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const creditOf = (img) => [oneLine(img.author, 120), oneLine(img.license, 80)].filter(Boolean).join(', ');
const sourceOf = (provider) => (String(provider || '').toLowerCase().startsWith('openverse') ? 'openverse' : 'commons');

/** True when the page is about a real person: then no AI illustration is ever suggested. */
function aboutPerson(v) {
    const rows = Array.isArray(v.infobox) ? v.infobox : [];
    if (rows.some((r) => PERSON_KEYS.test(String(r.key || r.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')))) return true;
    const text = `${v.revision.fields.title || ''}\n${v.revision.fields.summary || ''}\n${v.revision.content || ''}`;
    return PERSON_TEXT.test(text);
}

/** The image task's Media references -> the suggestions the editor already knows. */
function fromTask(media, limit) {
    const out = [];
    const seen = new Set();
    for (const m of Array.isArray(media) ? media : []) {
        if (!m || !m.media_id) continue;
        const ai = m.ai === true;
        const key = m.media_id;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            provider: ai ? 'ai' : sourceOf(m.provider), role: out.length ? 'figure' : 'lead',
            media_id: m.media_id, url: m.url || null, page_url: ai ? null : (m.source_url || null),
            title: oneLine(m.title, 300) || null, author: oneLine(m.author, 200) || null,
            license: oneLine(m.license, 200) || null, license_url: m.license_url || null,
            width: Number.isInteger(m.width) ? m.width : null, height: Number.isInteger(m.height) ? m.height : null,
            alt: oneLine(m.alt || m.title, 400) || null,
            caption: oneLine(m.caption || m.title, 500) || null,
            credit: oneLine(m.credit, 300) || creditOf(m) || null,
            ai, model: m.model || null, data_url: null,
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

/** One run of the shared image task; the task stores the picture in Media for the wiki tenant. */
async function runTask(ctx, input, { subject = null } = {}) {
    return { ...(await ctx.platform.ai.runTask(TASK, input, { subject })), task: TASK };
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
        // Find: Commons and Openverse through the one task, with the owner's engine order and guest rule.
        try {
            const run = await runTask(ctx, {
                mode: 'find', query, count: limit, media_app: 'wiki',
                ...(Array.isArray(body.providers) && body.providers.length ? { providers: body.providers.filter((p) => PROVIDERS.includes(p)) } : {}),
            }, { subject: actor && actor.subject });
            runId = run.runId || runId;
            suggestions.push(...fromTask((run.output && run.output.media) || [], limit));
            note = (run.output && run.output.note) || null;
        } catch (err) {
            ctx.log && ctx.log.warn && ctx.log.warn(`[Wiki] images ${pageId}: ${err && err.message}`);
            note = 'The image task could not find a licensed picture.';
        }
    } else {
        note = 'OpenVibe.AI is not configured here: only Pics and the page\'s own Media are suggested.';
    }

    const seen = new Set(suggestions.map((s) => s.media_id || s.page_url || s.url));
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
        if (seen.has(a.media_id || a.page_url || a.url)) continue;
        seen.add(a.media_id || a.page_url || a.url);
        suggestions.push(a);
    }

    // An AI illustration only when nothing real exists, and never of a real person. The shared task's make
    // mode is off until the owner picks an image model, so an unconfigured model answers 503 and is reported.
    if (!suggestions.length && person) {
        note = 'This article is about a real person: no AI illustration is suggested.';
    } else if (!suggestions.length && body.allow_ai !== false && ctx.platform.ai.configured) {
        try {
            const run = await runTask(ctx, {
                mode: 'make', media_app: 'wiki', n: 1,
                prompt: `A plain editorial illustration for a wiki article titled "${oneLine(v.revision.fields.title, 200)}". ${oneLine(v.revision.fields.summary, 300)} No people, no faces, no real person, no text.`,
            }, { subject: actor && actor.subject });
            runId = run.runId || runId;
            const made = fromTask((run.output && run.output.media) || [], 1);
            if (made.length) {
                model = made[0].model || null;
                made[0].role = 'lead';
                made[0].caption = `Illustration for ${oneLine(v.revision.fields.title, 200)} (Illustration made with ${model || 'AI'})`;
                made[0].credit = `Illustration made with ${model || 'AI'}`;
                suggestions.push(made[0]);
            } else {
                note = 'No illustration could be made.';
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

module.exports = { suggest, aboutPerson, fromTask, TASK, PROVIDERS };
