'use strict';
/**
 * Page content: [[internal links]], typed infobox values, and rendering to safe HTML.
 *
 * Link syntax (outside code):
 *   [[Title]]                  a page in the same space, slug = slugify(Title)
 *   [[Title|label]]            with its own label
 *   [[space-slug:Title]]       a page in another space (the prefix must look like a space slug:
 *                              lowercase letters, digits and dashes; anything else is part of the title)
 * Markdown itself goes through openvibe-publishing/ssr (escaped first, a fixed tag set, no raw HTML).
 */
const ssr = require('openvibe-publishing/ssr');
const { slugify } = require('openvibe-publishing/taxonomy');

const LINK_RE = /\[\[([^\[\]|\n]{1,200})(?:\|([^\[\]\n]{1,200}))?\]\]/g;
const SPACE_PREFIX_RE = /^([a-z0-9][a-z0-9-]{0,62}):(.+)$/;
const SPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PAGE_SLUG_RE = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}-]{0,79}$/u;
const MAX_LINKS = 500;

class ContentError extends Error {
    constructor(code, message) { super(message); this.status = 422; this.code = code; }
}

function pageSlug(title) {
    try { return slugify(String(title || '').trim()); } catch { throw new ContentError('page.invalid_title', 'A title needs at least one letter or digit'); }
}

function parseTarget(raw, currentSpace) {
    const text = String(raw).trim();
    const m = text.match(SPACE_PREFIX_RE);
    let space = currentSpace;
    let title = text;
    if (m && m[1] !== 'media') { space = m[1]; title = m[2].trim(); }
    let slug;
    try { slug = slugify(title); } catch { return null; }
    return { space, slug, title };
}

/** Run fn over the parts of `source` that are not code (fences and inline code are left alone). */
function mapOutsideCode(source, fn) {
    const lines = String(source == null ? '' : source).split('\n');
    let fence = null;
    return lines.map((line) => {
        const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return line; }
        if (f) { fence = f[1]; return line; }
        return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : fn(part))).join('');
    }).join('\n');
}

/** Every distinct [[link]] in the content: [{ space, slug, title, label }]. */
function extractLinks(source, currentSpace) {
    const seen = new Map();
    mapOutsideCode(source, (text) => {
        text.replace(LINK_RE, (_m, target, label) => {
            const t = parseTarget(target, currentSpace);
            if (t && seen.size < MAX_LINKS) {
                const key = `${t.space}\u0000${t.slug}`;
                if (!seen.has(key)) seen.set(key, { ...t, label: label ? label.trim() : null });
            }
            return '';
        });
        return text;
    });
    return [...seen.values()];
}

/**
 * Markdown + [[links]] → HTML. resolve({ space, slug }) → { href, exists } (exists false = red link;
 * href null = no link at all, e.g. a reader who cannot create the page).
 */
function renderContent(source, { currentSpace, resolve, rel = 'noopener' } = {}) {
    const held = [];
    const withTokens = mapOutsideCode(source, (text) => text.replace(LINK_RE, (m, target, label) => {
        const t = parseTarget(target, currentSpace);
        if (!t) return m;
        const r = resolve(t) || { href: null, exists: false };
        const text2 = (label || t.title).trim();
        let htmlLink;
        if (r.exists) htmlLink = `<a class="ov-wikilink" href="${ssr.escapeHtml(r.href)}">${ssr.escapeHtml(text2)}</a>`;
        else if (r.href) htmlLink = `<a class="ov-wikilink ov-redlink" href="${ssr.escapeHtml(r.href)}" rel="nofollow" title="${ssr.escapeHtml(`${t.title} (page does not exist)`)}">${ssr.escapeHtml(text2)}</a>`;
        else htmlLink = `<span class="ov-wikilink ov-redlink" title="${ssr.escapeHtml(`${t.title} (page does not exist)`)}">${ssr.escapeHtml(text2)}</span>`;
        held.push(htmlLink);
        return `\u0001WL${held.length - 1}\u0001`;
    }));
    const html = ssr.renderMarkdown(withTokens, { rel, headingShift: 0 });
    return html.replace(/\u0001WL(\d+)\u0001/g, (_m, n) => held[Number(n)] || '');
}

// ---- Infobox -----------------------------------------------------------------------------------

const TYPES = ['text', 'number', 'date', 'url', 'boolean', 'page', 'media'];
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MEDIA_RE = /^(med_[0-9A-HJKMNP-TV-Z]{26}|legacy:[a-z][a-z0-9-]{1,39}:(vod|clip|file|paste|thumbnail|avatar):[A-Za-z0-9._/-]{1,200})$/;
const MAX_ENTRIES = 30;

function keyFromLabel(label) {
    return String(label).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'n$1').slice(0, 40);
}

/**
 * Validate and normalise infobox entries [{ key?, label, type, value }] → typed entries.
 * Nothing is coerced silently: a value that does not fit its type is an error.
 */
function normalizeInfobox(entries) {
    if (entries == null) return [];
    if (!Array.isArray(entries)) throw new ContentError('infobox.invalid', 'infobox must be a list');
    if (entries.length > MAX_ENTRIES) throw new ContentError('infobox.too_many', `at most ${MAX_ENTRIES} infobox rows`);
    const out = [];
    const keys = new Set();
    for (const [i, e] of entries.entries()) {
        const where = `infobox row ${i + 1}`;
        if (!e || typeof e !== 'object') throw new ContentError('infobox.invalid', `${where} is not an object`);
        const label = String(e.label == null ? '' : e.label).trim().slice(0, 80);
        const key = e.key == null || e.key === '' ? keyFromLabel(label) : String(e.key);
        if (!KEY_RE.test(key)) throw new ContentError('infobox.invalid_key', `${where}: key must match ${KEY_RE}`);
        if (keys.has(key)) throw new ContentError('infobox.duplicate_key', `${where}: key "${key}" appears twice`);
        keys.add(key);
        const type = String(e.type || 'text');
        if (!TYPES.includes(type)) throw new ContentError('infobox.invalid_type', `${where}: type must be one of ${TYPES.join(', ')}`);
        const v = e.value;
        let value;
        switch (type) {
        case 'number': {
            const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
            if (!Number.isFinite(n)) throw new ContentError('infobox.invalid_value', `${where}: "${v}" is not a number`);
            value = n;
            break;
        }
        case 'boolean': {
            if (v === true || v === 'true' || v === 'yes') value = true;
            else if (v === false || v === 'false' || v === 'no') value = false;
            else throw new ContentError('infobox.invalid_value', `${where}: a boolean is true/false or yes/no`);
            break;
        }
        case 'date': {
            const s = String(v == null ? '' : v).trim();
            if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) || Number.isNaN(Date.parse(s))) {
                throw new ContentError('infobox.invalid_value', `${where}: a date is YYYY-MM-DD or an ISO 8601 instant`);
            }
            value = s;
            break;
        }
        case 'url': {
            let u;
            try { u = new URL(String(v)); } catch { throw new ContentError('infobox.invalid_value', `${where}: not an absolute URL`); }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ContentError('infobox.invalid_value', `${where}: only http(s) URLs`);
            value = u.toString();
            break;
        }
        case 'media': {
            const s = String(v == null ? '' : v).trim();
            if (!MEDIA_RE.test(s)) throw new ContentError('infobox.invalid_value', `${where}: a Media object id (med_…)`);
            value = s;
            break;
        }
        case 'page': {
            const s = String(v == null ? '' : v).trim();
            if (!s || s.length > 200 || /[\[\]|\n]/.test(s)) throw new ContentError('infobox.invalid_value', `${where}: a page title`);
            value = s;
            break;
        }
        default: {
            const s = String(v == null ? '' : v).trim();
            if (!s) throw new ContentError('infobox.invalid_value', `${where}: empty value`);
            value = s.slice(0, 500);
        }
        }
        out.push({ key, label: label || key, type, value });
    }
    return out;
}

/** The no-JS form's textarea: one row per line, "Label | type | value" (type optional → text). */
function parseInfoboxText(text) {
    const rows = [];
    for (const [i, raw] of String(text || '').split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split('|').map((s) => s.trim());
        if (parts.length === 2) rows.push({ label: parts[0], type: 'text', value: parts[1] });
        else if (parts.length >= 3) rows.push({ label: parts[0], type: parts[1].toLowerCase(), value: parts.slice(2).join('|').trim() });
        else throw new ContentError('infobox.invalid', `infobox line ${i + 1}: write "Label | type | value"`);
    }
    return normalizeInfobox(rows);
}

function infoboxToText(entries) {
    return (entries || []).map((e) => `${e.label} | ${e.type} | ${e.value}`).join('\n');
}

module.exports = {
    ContentError, pageSlug, parseTarget, extractLinks, renderContent, mapOutsideCode,
    normalizeInfobox, parseInfoboxText, infoboxToText, keyFromLabel,
    TYPES, SPACE_SLUG_RE, PAGE_SLUG_RE, MEDIA_RE,
};
