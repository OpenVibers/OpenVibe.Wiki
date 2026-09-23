'use strict';
/**
 * Space import: the bundle format and its strict validation (the import itself is
 * service.importPages, one transaction).
 *
 * A bundle is JSON, the same page shape as the seed file (seeds/openvibe.json):
 *
 *   {
 *     "pages": [
 *       { "title": "Rye", "body": "Markdown with [[links]]", "summary": "…", "parent": "Bread",
 *         "infobox": [{ "label": "Gluten", "type": "text", "value": "low" }],
 *         "citations": [{ "url": "https://…", "title": "…", "retrievedAt": "2026-09-01" }],
 *         "visibility": "public", "message": "…" }
 *     ],
 *     "publish": false,            // default: every page is created as a draft
 *     "on_existing": "fail",       // "fail" (default: nothing is imported) | "skip" (leave those pages alone)
 *     "source": "my old wiki",     // where the text comes from (shown as "Imported from …")
 *     "original_author": "…",      // optional
 *     "ai_assisted": false         // true: noindex until a person reviews each page, like AI output
 *   }
 *
 * Slugs come from titles exactly as for pages created by hand; `parent` is the title of another page
 * of the bundle or of the space. A `space` key (as in the seed file) is ignored: the target space is
 * the one in the URL. Anything else unknown is refused, so a typo never imports silently.
 */
const content = require('./content');

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_PAGE_BODY = 200000;
const MAX_SUMMARY = 300;
const MAX_MESSAGE = 300;
const MAX_PAGE_CITATIONS = 50;
const MAX_SOURCE_ITEMS = 200;
const BUNDLE_KEYS = new Set(['pages', 'publish', 'on_existing', 'source', 'original_author', 'ai_assisted', 'space']);
const PAGE_KEYS = new Set(['title', 'body', 'summary', 'parent', 'infobox', 'citations', 'visibility', 'message']);
const ON_EXISTING = ['fail', 'skip'];

class ImportError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const bad = (code, message, status = 422) => { throw new ImportError(status, code, message); };
const optString = (v, max, what) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') bad('import.invalid', `${what} must be text`);
    if (v.length > max) bad('import.invalid', `${what} is at most ${max} characters`);
    return v;
};
const optBool = (v, what) => {
    if (v == null) return false;
    if (typeof v !== 'boolean') bad('import.invalid', `${what} must be true or false`);
    return v;
};

/** The bundle as text (the form) → object; enforces the byte limit before parsing. */
function parseBundleText(text) {
    const s = String(text == null ? '' : text);
    if (Buffer.byteLength(s, 'utf8') > MAX_BUNDLE_BYTES) bad('import.too_large', `A bundle is at most ${MAX_BUNDLE_BYTES / 1024 / 1024} MB`, 413);
    if (!s.trim()) bad('import.invalid', 'Paste a bundle: JSON with a "pages" list');
    try { return JSON.parse(s); } catch { return bad('import.invalid_json', 'The bundle is not valid JSON', 400); }
}

/**
 * Validates a bundle object → { pages: [{ title, slug, body, summary, parentSlug, infobox, citations,
 * visibility, message }], publish, onExisting, source, originalAuthor, aiAssisted }. Throws
 * ImportError (422 invalid, 413 too large). Citations are left as given (resolved by the caller).
 */
function validateBundle(input) {
    const b = Array.isArray(input) ? { pages: input } : input;
    if (!b || typeof b !== 'object' || Array.isArray(b)) bad('import.invalid', 'A bundle is a JSON object with a "pages" list');
    for (const k of Object.keys(b)) if (!BUNDLE_KEYS.has(k)) bad('import.unknown_field', `Unknown bundle field "${k}"`);
    if (!Array.isArray(b.pages) || !b.pages.length) bad('import.invalid', 'A bundle needs a non-empty "pages" list');
    if (b.pages.length > MAX_PAGES) bad('import.too_many_pages', `A bundle holds at most ${MAX_PAGES} pages`);
    const onExisting = b.on_existing == null || b.on_existing === '' ? 'fail' : b.on_existing;
    if (!ON_EXISTING.includes(onExisting)) bad('import.invalid', `on_existing is one of ${ON_EXISTING.join(', ')}`);
    const out = {
        publish: optBool(b.publish, 'publish'),
        onExisting,
        source: optString(b.source, 200, 'source'),
        originalAuthor: optString(b.original_author, 120, 'original_author'),
        aiAssisted: optBool(b.ai_assisted, 'ai_assisted'),
        pages: [],
    };
    const seen = new Map();
    b.pages.forEach((p, i) => {
        const where = `page ${i + 1}`;
        if (!p || typeof p !== 'object' || Array.isArray(p)) bad('import.invalid', `${where} is not an object`);
        for (const k of Object.keys(p)) if (!PAGE_KEYS.has(k)) bad('import.unknown_field', `${where}: unknown field "${k}"`);
        if (typeof p.title !== 'string' || !p.title.trim()) bad('import.invalid', `${where} needs a title`);
        const title = p.title.replace(/\s+/g, ' ').trim();
        if (title.length > 200) bad('import.invalid', `${where}: a title is at most 200 characters`);
        let slug;
        try { slug = content.pageSlug(title); } catch (err) { bad('import.invalid', `${where} ("${title}"): ${err.message}`); }
        if (seen.has(slug)) bad('import.duplicate_slug', `"${title}" and "${seen.get(slug)}" would both be /${slug}`);
        seen.set(slug, title);
        if (typeof p.body !== 'string') bad('import.invalid', `${where} ("${title}"): body must be Markdown text`);
        if (p.body.length > MAX_PAGE_BODY) bad('import.page_too_large', `${where} ("${title}"): a page is at most ${MAX_PAGE_BODY} characters`, 413);
        let parentSlug = null;
        if (p.parent != null && p.parent !== '') {
            if (typeof p.parent !== 'string') bad('import.invalid', `${where} ("${title}"): parent is a page title`);
            try { parentSlug = content.pageSlug(p.parent); } catch { bad('import.invalid', `${where} ("${title}"): parent "${p.parent}" is not a page title`); }
            if (parentSlug === slug) bad('import.invalid_parent', `${where} ("${title}") cannot be its own parent`);
        }
        if (p.infobox != null && !Array.isArray(p.infobox)) bad('import.invalid', `${where} ("${title}"): infobox must be a list`);
        if (p.citations != null && !Array.isArray(p.citations)) bad('import.invalid', `${where} ("${title}"): citations must be a list`);
        if (p.visibility != null && !['public', 'members', 'private'].includes(p.visibility)) bad('import.invalid', `${where} ("${title}"): visibility is public, members or private`);
        if ((p.citations || []).length > MAX_PAGE_CITATIONS) bad('import.invalid', `${where} ("${title}"): at most ${MAX_PAGE_CITATIONS} citations per page`);
        out.pages.push({
            title, slug, body: p.body, parentSlug,
            summary: optString(p.summary, MAX_SUMMARY, `${where} summary`),
            infobox: p.infobox || [], citations: p.citations || [],
            visibility: p.visibility || 'public',
            message: optString(p.message, MAX_MESSAGE, `${where} message`),
        });
    });
    const cites = out.pages.flatMap((p) => p.citations);
    // Every Sources item citation is one call to OpenVibe.Sources before the import.
    const items = cites.filter((c) => c && typeof c === 'object' && (c.source_item_id || c.sourceItemId)).length;
    if (items > MAX_SOURCE_ITEMS) bad('import.too_many_citations', `A bundle cites at most ${MAX_SOURCE_ITEMS} OpenVibe.Sources items`);
    return out;
}

module.exports = { parseBundleText, validateBundle, ImportError, MAX_BUNDLE_BYTES, MAX_PAGES, MAX_PAGE_BODY };
