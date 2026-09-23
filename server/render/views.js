'use strict';
/**
 * Page bodies. Every interpolated value goes through openvibe-publishing/ssr's html`` (escaped
 * unless raw()). Forms are plain HTML posts; nothing here needs JavaScript.
 */
const ssr = require('openvibe-publishing/ssr');
const { figureHtml } = require('openvibe-publishing/media');
const { infoboxToText } = require('../wiki/content');

const { html, raw } = ssr;
const t = (v) => raw(ssr.timeTag(v));
const e = encodeURIComponent;
const VIS_LABEL = { public: 'Public', members: 'Members (any signed-in OpenVibe account)', private: 'Private (people with a role in this space)' };

function wpath(space, page) { return `/w/${e(space.slug)}/${e(page.slug)}`; }

/** rel for outbound links (citations, infobox URLs): community spaces add ugc (see service.linkRel). */
function outRel(space) { return space && space.kind === 'official' ? 'noopener nofollow' : 'nofollow ugc noopener'; }

function notice(kind, text) { return html`<p class="wk-notice wk-${kind}" role="status">${text}</p>`; }

function crumbs(items) { return raw(ssr.breadcrumbsHtml(items)); }

function errorBody({ status, title, message }) {
    return html`<section class="wk-error"><h1>${title}</h1><p>${message}</p><p class="wk-muted">HTTP ${String(status)}</p><p><a href="/">Back to the wiki</a></p></section>`;
}

function home({ spaces, recent, actor }) {
    const official = spaces.filter((s) => s.kind === 'official');
    const user = spaces.filter((s) => s.kind === 'user');
    const list = (items) => items.length ? html`<ul class="wk-spaces">${items.map((s) => html`<li><a href="/s/${e(s.slug)}"><strong>${s.name}</strong></a>${s.visibility !== 'public' ? html` <span class="wk-tag">${s.visibility}</span>` : ''}${s.description ? html`<br><span class="wk-muted">${s.description}</span>` : ''}</li>`)}</ul>` : html`<p class="wk-muted">None yet.</p>`;
    return html`<section class="wk-intro"><h1>OpenVibe.Wiki</h1>
<p>Wiki spaces with page trees, revision history, citations and discussion. Official spaces are edited by OpenVibe staff; anyone signed in with an OpenVibe account can start a space of their own.</p>
${actor && actor.subject ? html`<p><a class="wk-button" href="/new-space">Start a space</a></p>` : html`<p><a href="/auth/login?next=%2Fnew-space">Sign in</a> to start a space.</p>`}</section>
<section><h2>Official spaces</h2>${list(official)}</section>
<section><h2>Community spaces</h2>${list(user)}</section>
<section><h2>Recently published</h2>${recent.length ? html`<ul class="wk-recent">${recent.map((r) => html`<li><a href="${wpath(r.space, r.page)}">${r.page.title}</a> <span class="wk-muted">in ${r.space.name} · ${t(r.page.revision_published_at)}</span></li>`)}</ul>` : html`<p class="wk-muted">Nothing published yet.</p>`}
<p><a href="/recent">All recent changes</a> · <a href="/feed.atom">Atom</a> · <a href="/feed.json">JSON Feed</a></p></section>`;
}

function treeHtml(nodes, space) {
    if (!nodes.length) return '';
    return html`<ul class="wk-tree">${nodes.map((n) => html`<li><a href="${wpath(space, n.page)}">${n.page.title}</a>${n.page.state !== 'published' ? html` <span class="wk-tag">${n.page.state}</span>` : ''}${n.page.visibility !== 'public' ? html` <span class="wk-tag">${n.page.visibility}</span>` : ''}${treeHtml(n.children, space)}</li>`)}</ul>`;
}

function spacePage({ space, tree, canEdit, canManage, proposals }) {
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name }])}
<section><h1>${space.name}</h1>
<p class="wk-muted">${space.kind === 'official' ? 'Official space' : 'Community space'} · ${VIS_LABEL[space.visibility]}</p>
${space.description ? html`<p>${space.description}</p>` : ''}
${canEdit ? html`<p><a class="wk-button" href="/s/${e(space.slug)}/new">New page</a>${canManage ? html` <a href="/s/${e(space.slug)}/import">Import pages</a> <a href="/s/${e(space.slug)}/settings">Space settings</a>` : ''}</p>` : ''}
${proposals && proposals.length ? html`<p>${notice('info', `${proposals.length} AI proposal(s) wait for review.`)} <a href="/s/${e(space.slug)}/proposals">Review them</a></p>` : ''}
<h2>Pages</h2>${tree.length ? raw(treeHtml(tree, space)) : html`<p class="wk-muted">No pages yet.</p>`}
</section>`;
}

function infoboxHtml(entries, resolve, rel = 'nofollow ugc noopener') {
    if (!entries.length) return '';
    const cell = (x) => {
        switch (x.type) {
        case 'url': return html`<a href="${x.value}" rel="${rel}">${x.value.replace(/^https?:\/\//, '')}</a>`;
        case 'date': return raw(ssr.timeTag(x.value, { label: String(x.value).slice(0, 10) }) || ssr.escapeHtml(x.value));
        case 'boolean': return x.value ? 'Yes' : 'No';
        case 'number': return String(x.value);
        case 'page': { const r = resolve(x.value); return r.exists ? html`<a href="${r.href}">${x.value}</a>` : html`<span class="ov-redlink">${x.value}</span>`; }
        case 'media': return html`<code>${x.value}</code>`;
        default: return x.value;
        }
    };
    return html`<aside class="wk-infobox" aria-label="Infobox"><table><tbody>${entries.map((x) => html`<tr data-key="${x.key}" data-type="${x.type}"><th scope="row">${x.label}</th><td>${cell(x)}</td></tr>`)}</tbody></table></aside>`;
}

function citationsHtml(cites, inspectHref, rel = 'nofollow ugc noopener') {
    const inspect = inspectHref ? html`<p class="wk-muted"><a href="${inspectHref}">Inspect these sources</a> (retrieval times, where each was first cited, what changed between revisions)</p>` : '';
    if (!cites.length) return html`<section class="wk-sources"><h2>Sources</h2><p class="wk-muted">This revision cites no sources.</p>${inspect}</section>`;
    return html`<section class="wk-sources"><h2>Sources</h2><ol>${cites.map((c) => html`<li id="cite-${String(c.id)}">${c.url ? html`<a href="${c.url}" rel="${rel}">${c.title || c.url}</a>` : html`${c.title || 'Sources item'}`}${c.sourceItemId ? html` <span class="wk-muted">(OpenVibe.Sources item <code>${c.sourceItemId}</code>)</span>` : ''}${c.retrievedAt ? html`, retrieved ${t(c.retrievedAt)}` : html`, <span class="wk-muted">retrieval time unknown</span>`}${c.licenseNote ? html` (${c.licenseNote})` : ''}${c.quote && c.quote.text ? html`<blockquote>${c.quote.text}</blockquote>` : ''}</li>`)}</ol>${inspect}</section>`;
}

const CHANGE_LABEL = { kept: 'kept from revision', new: 'new in this revision', restored: 'restored from an older revision' };

/** The citation inspector: one revision's sources in full, and how they changed from the previous one. */
function sourcesPage({ space, page, view: v, citations: cites, previous, dropped, revisions }) {
    const base = wpath(space, page);
    const n = v.revision.number;
    const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
    const rel = outRel(space);
    const row = (c) => html`<tr id="cite-${String(c.id)}">
<td>${c.url ? html`<a href="${c.url}" rel="${rel}">${c.title || c.url}</a><br><span class="wk-muted">${hostOf(c.url) || ''}</span>` : html`${c.title || 'Sources item'}`}${c.quote && c.quote.text ? html`<blockquote>${c.quote.text}</blockquote>` : ''}</td>
<td>${c.sourceItemId ? html`OpenVibe.Sources item <code>${c.sourceItemId}</code><br><span class="wk-muted">URL, title, retrieval time and license from the item's provenance</span>` : 'URL given by the editor'}</td>
<td>${c.retrievedAt ? t(c.retrievedAt) : html`<span class="wk-muted">unknown</span>`}</td>
<td>${c.licenseNote || html`<span class="wk-muted">none recorded</span>`}</td>
<td>${c.firstRevision ? html`<a href="${base}/sources?rev=${String(c.firstRevision)}">revision ${String(c.firstRevision)}</a>, ${t(c.firstAttachedAt)}` : html`<span class="wk-muted">an earlier revision</span>`}</td>
<td>${c.change === 'kept' && previous ? html`${CHANGE_LABEL.kept} ${String(previous)}` : CHANGE_LABEL[c.change]}</td></tr>`;
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }, { name: page.title, url: page.state === 'published' ? base : null }, { name: 'Sources' }])}
<section class="wk-inspector"><h1>Sources of ${v.revision.fields.title || page.title}, revision ${String(n)}</h1>
<p>${v.isPublishedRevision ? 'This is the published revision.' : html`This is not the published revision${page.published_revision && page.state === 'published' ? html` (<a href="${base}/sources">see the published one</a>)` : ''}.`} <a href="${base}?rev=${String(n)}">Read revision ${String(n)}</a> · <a href="${base}/history">history</a></p>
<p class="wk-muted">Every citation belongs to the revision that used it and is never edited. A later revision keeps a source by carrying it forward; a dropped source stays on the older revision.</p>
${cites.length ? html`<table class="wk-citations"><thead><tr><th scope="col">Source</th><th scope="col">Kind</th><th scope="col">Retrieved</th><th scope="col">License</th><th scope="col">First cited in</th><th scope="col">In this revision</th></tr></thead><tbody>${cites.map(row)}</tbody></table>` : html`<p>Revision ${String(n)} cites no sources.</p>`}
${previous ? html`<h2>Dropped since revision ${String(previous)}</h2>${dropped.length ? html`<ul>${dropped.map((c) => html`<li>${c.url ? html`<a href="${c.url}" rel="${rel}">${c.title || c.url}</a>` : html`${c.title || 'Sources item'}`}${c.sourceItemId ? html` <code>${c.sourceItemId}</code>` : ''}${c.retrievedAt ? html`, retrieved ${t(c.retrievedAt)}` : ''}</li>`)}</ul>` : html`<p class="wk-muted">None.</p>`}` : ''}
<h2>Other revisions</h2>
<ul class="wk-revisions">${revisions.map((r) => html`<li>${r.number === n ? html`<strong>Revision ${String(r.number)}</strong>` : html`<a href="${base}/sources?rev=${String(r.number)}">Revision ${String(r.number)}</a>`}${r.published ? ' (published)' : ''} · ${t(r.createdAt)} · ${String(r.citationCount)} source(s)</li>`)}</ul>
</section>`;
}

const UNAVAILABLE = {
    deleted: 'This media was deleted from OpenVibe.Media and is no longer available.',
    forbidden: 'This media is no longer shared publicly in OpenVibe.Media, so it is not shown here.',
    not_found: 'This media is no longer available.',
};

function mediaHtml(attachments, urlFor) {
    if (!attachments.length) return '';
    return html`<section class="wk-media"><h2>Media</h2>${attachments.map((a) => raw(figureHtml(a, { urlFor, unavailableText: UNAVAILABLE[a.brokenReason] || UNAVAILABLE.not_found })))}</section>`;
}

function discussionHtml(d, { space, page, actor }) {
    const head = html`<h2>Discussion</h2>`;
    if (!d || d.state === 'not_public') return html`<section class="wk-discussion">${head}<p class="wk-muted">Discussion is only open on public, published pages.</p></section>`;
    if (d.state === 'unavailable') return html`<section class="wk-discussion">${head}<p class="wk-notice wk-warn">The discussion (held by OpenVibe.Community) could not be loaded right now${d.reason ? html`: ${d.reason}` : ''}.</p></section>`;
    const comments = (d.comments || []).filter((c) => !c.deleted);
    const form = actor && actor.subject
        ? html`<form method="post" action="${wpath(space, page)}/discuss" class="wk-form"><label for="wk-comment">Add a comment (posted to OpenVibe.Community as you)</label><textarea id="wk-comment" name="message" rows="3" maxlength="5000" required></textarea><button type="submit">Comment</button></form>`
        : html`<p><a href="/auth/login?next=${e(wpath(space, page))}">Sign in</a> to comment.</p>`;
    return html`<section class="wk-discussion" id="discussion">${head}
${comments.length ? html`<ul class="wk-comments">${comments.map((c) => html`<li><strong>${c.display_name || 'Someone'}</strong> <span class="wk-muted">${t(c.created_at)}${c.origin === 'ai' ? ' · AI' : ''}</span><p>${c.message}</p></li>`)}</ul>` : html`<p class="wk-muted">No comments yet.</p>`}
${form}</section>`;
}

function articlePage(v, { html: contentHtml, discussion, actor, mediaUrl, resolve, flash }) {
    const { space, page, revision: rev } = v;
    const base = wpath(space, page);
    const trail = [{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }];
    if (v.parent) trail.push({ name: v.parent.title, url: wpath(space, v.parent) });
    trail.push({ name: rev.fields.title || page.title });
    const banners = [];
    if (flash) banners.push(notice('ok', flash));
    if (page.state !== 'published') banners.push(notice('warn', `This page is ${page.state === 'scheduled' ? 'scheduled, not published yet' : page.state}. Only editors of the space can see it.`));
    else if (!v.isPublishedRevision) banners.push(notice('warn', `You are looking at revision ${rev.number}, not the published revision ${page.published_revision}.`));
    else if (v.canEdit && v.headNumber > rev.number) banners.push(html`<p class="wk-notice wk-info" role="status">Revision ${String(v.headNumber)} is newer than the published one and only editors can see it. <a href="${base}?rev=${String(v.headNumber)}">View it</a> · <a href="${base}/diff/${String(rev.number)}/${String(v.headNumber)}">compare</a></p>`);
    if (v.disclosure) banners.push(html`<p class="wk-notice wk-ai" role="note"><strong>${v.disclosure.short}.</strong> ${v.disclosure.long}</p>`);
    if (v.proposal && v.proposal.status === 'pending') banners.push(notice('info', 'This revision is an AI proposal waiting for a person to approve or reject it.'));
    if (v.canEdit && v.decision && !v.decision.indexable && page.state === 'published') banners.push(html`<p class="wk-notice wk-info">Search engines are told not to index this page: ${v.decision.reasons.map((r) => r.code + (r.detail ? ` (${r.detail})` : '')).join(', ')}.</p>`);
    const actions = [html`<a href="${base}/history">History</a>`];
    if (v.canEdit) actions.unshift(html`<a href="${base}/edit">Edit</a>`), actions.push(html`<a href="${base}/settings">Page settings</a>`);
    return html`${crumbs(trail)}
<article class="wk-article" data-page-id="${page.id}" data-revision="${String(rev.number)}">
<header><h1>${rev.fields.title || page.title}</h1><nav class="wk-actions" aria-label="Page actions">${actions.map((a, i) => html`${i ? ' · ' : ''}${a}`)}</nav></header>
${banners}
${raw(infoboxHtml(v.infobox, resolve, outRel(space)))}
<div class="wk-content">${raw(contentHtml)}</div>
${raw(mediaHtml(v.attachments, mediaUrl))}
${raw(citationsHtml(v.citations, `${base}/sources${v.isPublishedRevision ? '' : `?rev=${rev.number}`}`, outRel(space)))}
${v.children.length ? html`<section><h2>Subpages</h2><ul>${v.children.map((c) => html`<li><a href="${wpath(space, c)}">${c.title}</a></li>`)}</ul></section>` : ''}
${v.backlinks.length ? html`<section><h2>What links here</h2><ul>${v.backlinks.map((b) => html`<li><a href="${wpath(b.space, b.page)}">${b.page.title}</a>${b.space.id !== space.id ? html` <span class="wk-muted">(${b.space.name})</span>` : ''}</li>`)}</ul></section>` : ''}
<footer class="wk-meta"><p>Revision ${String(rev.number)}${rev.kind === 'revert' ? html` (a revert to revision ${String(rev.revertedTo)})` : ''}, saved ${t(rev.createdAt)}${page.published_at ? html` · first published ${t(page.published_at)}` : ''} · <a href="${base}/history">history</a> · <a href="${base}.json">JSON</a></p>
${actor && actor.subject ? html`<form method="post" action="${base}/watch" class="wk-inline"><input type="hidden" name="on" value="${v.watching ? '0' : '1'}"><button type="submit">${v.watching ? 'Stop watching' : 'Watch this page'}</button></form>` : ''}</footer>
</article>
${raw(discussionHtml(discussion, { space, page, actor }))}`;
}

function historyPage({ space, page, list, canEdit }) {
    const base = wpath(space, page);
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }, { name: page.title, url: page.state === 'published' ? base : null }, { name: 'History' }])}
<section><h1>History of ${page.title}</h1>
<p class="wk-muted">Every revision is kept. A revert adds a new revision; nothing is rewritten.</p>
<form method="get" action="${base}/compare" class="wk-form wk-compare">
<table class="wk-history"><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Revision</th><th scope="col">Saved</th><th scope="col">By</th><th scope="col">Kind</th><th scope="col">Note</th></tr></thead><tbody>
${list.map((r, i) => html`<tr${r.published ? raw(' class="wk-live"') : ''}><td><input type="radio" name="a" value="${String(r.number)}" aria-label="Compare from revision ${String(r.number)}"${i === 1 ? raw(' checked') : ''}></td><td><input type="radio" name="b" value="${String(r.number)}" aria-label="Compare to revision ${String(r.number)}"${i === 0 ? raw(' checked') : ''}></td>
<td><a href="${base}?rev=${String(r.number)}">${String(r.number)}</a>${r.published ? html` <span class="wk-tag">published</span>` : ''}</td>
<td>${t(r.createdAt)}</td><td>${r.author || ''}</td>
<td>${r.kind}${r.meta && r.meta.authorship && r.meta.authorship.mode !== 'human' ? html` · ${r.meta.authorship.mode === 'ai' ? 'AI-generated' : r.meta.authorship.mode}` : ''}${r.proposal ? html` · proposal ${r.proposal.status}` : ''}</td>
<td>${r.message || ''} <a class="wk-muted" href="${base}/sources?rev=${String(r.number)}">${String(r.citationCount)} source(s)</a>
${r.aiAssisted ? html` <span class="wk-tag">${r.needsReview ? 'AI-assisted, not yet reviewed' : (r.review && r.review.decision === 'approved' ? 'reviewed by a person' : 'AI-assisted')}</span>` : ''}
${canEdit && !r.published ? html` <a href="${base}/revert?to=${String(r.number)}">revert to this</a>` : ''}
${canEdit && !r.published && (!r.proposal || r.proposal.status === 'approved') ? html` <a href="${base}/publish?rev=${String(r.number)}">publish this</a>` : ''}</td></tr>`)}
</tbody></table>
${list.length > 1 ? html`<p><button type="submit">Compare selected revisions</button></p>` : ''}
</form>
${canEdit && list.some((r) => r.needsReview) ? html`<h2>Waiting for a person's review</h2>
<p class="wk-muted">These revisions were written with AI assistance. Search engines are told not to index them, and they stay out of sitemaps, feeds and search, until a person checks them against their sources.</p>
<ul class="wk-review">${list.filter((r) => r.needsReview).map((r) => html`<li><a href="${base}?rev=${String(r.number)}">Revision ${String(r.number)}</a>${r.published ? ' (published)' : ''}${r.review ? html` · last review: ${r.review.decision === 'rejected' ? 'needs changes' : r.review.decision}` : ''}
<form method="post" action="${base}/review" class="wk-inline"><input type="hidden" name="revision" value="${String(r.number)}"><label class="wk-sr" for="wk-note-${String(r.number)}">Review note</label><input id="wk-note-${String(r.number)}" type="text" name="note" maxlength="2000" placeholder="Note (optional)"> <button type="submit" name="decision" value="approved">Reviewed — correct</button> <button type="submit" name="decision" value="rejected">Needs changes</button></form></li>`)}</ul>` : ''}
</section>`;
}

function diffPage({ space, page, diff }) {
    const base = wpath(space, page);
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }, { name: page.title, url: base }, { name: 'History', url: `${base}/history` }, { name: `Revision ${diff.from} → ${diff.to}` }])}
<section><h1>Changes to ${page.title}: revision ${String(diff.from)} → ${String(diff.to)}</h1>
<p><a href="${base}?rev=${String(diff.from)}">View revision ${String(diff.from)}</a> · <a href="${base}?rev=${String(diff.to)}">View revision ${String(diff.to)}</a> · <a href="${base}/diff/${String(diff.from)}/${String(diff.to)}?mode=line">line diff</a> · <a href="${base}/diff/${String(diff.from)}/${String(diff.to)}">word diff</a></p>
${diff.fields.length ? html`<h2>Fields</h2><table class="wk-fields"><thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${diff.fields.map((f) => html`<tr><th scope="row">${f.field}</th><td><pre>${JSON.stringify(f.from, null, 1)}</pre></td><td><pre>${JSON.stringify(f.to, null, 1)}</pre></td></tr>`)}</tbody></table>` : ''}
<h2>Text</h2><p class="wk-muted">Removed text is struck through, added text is underlined.</p>
${raw(ssr.diffHtml(diff.content))}
</section>`;
}

function citationRows(n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
        rows.push(html`<fieldset class="wk-cite"><legend>New source ${String(i + 1)}</legend>
<label>URL <input type="url" name="cite_url_${String(i)}" placeholder="https://…"></label>
<label>Title <input type="text" name="cite_title_${String(i)}" maxlength="500"></label>
<label>Retrieved on <input type="date" name="cite_retrieved_${String(i)}"></label>
<label>Quote (optional) <input type="text" name="cite_quote_${String(i)}" maxlength="1000"></label>
<label>or an OpenVibe.Sources item id <input type="text" name="cite_item_${String(i)}" pattern="itm_[0-9A-Z]{26}" placeholder="itm_…"></label></fieldset>`);
    }
    return rows;
}

function editPage({ space, page = null, values, error = null, preview = null, citations = [], parents = [], baseRevision = 0, expectedRevision = null }) {
    const isNew = !page;
    const action = isNew ? `/s/${e(space.slug)}/new` : `${wpath(space, page)}/edit`;
    const title = isNew ? `New page in ${space.name}` : `Editing ${page.title}`;
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }, ...(page ? [{ name: page.title, url: wpath(space, page) }] : []), { name: isNew ? 'New page' : 'Edit' }])}
<section><h1>${title}</h1>
${error ? notice('error', error) : ''}
${preview ? html`<section class="wk-preview" aria-label="Preview"><h2>Preview (not saved)</h2><div class="wk-content">${raw(preview)}</div></section>` : ''}
<form method="post" action="${action}" class="wk-form wk-edit">
<input type="hidden" name="expected_revision" value="${String(expectedRevision == null ? baseRevision : expectedRevision)}">
<input type="hidden" name="base_revision" value="${String(baseRevision)}">
<label>Title <input type="text" name="title" required maxlength="200" value="${values.title || ''}"></label>
${isNew ? html`<label>Parent page <select name="parent_id"><option value="">(top level)</option>${parents.map((p) => html`<option value="${p.id}"${values.parent_id === p.id ? raw(' selected') : ''}>${p.title}</option>`)}</select></label>
<label>Visibility <select name="visibility">${['public', 'members', 'private'].map((v) => html`<option value="${v}"${(values.visibility || 'public') === v ? raw(' selected') : ''}>${VIS_LABEL[v]}</option>`)}</select></label>` : ''}
<label>Summary (one sentence, optional) <input type="text" name="summary" maxlength="300" value="${values.summary || ''}"></label>
<label>Text (Markdown; link pages with [[Page title]] or [[space:Page title|label]]) <textarea name="body" rows="22">${values.body || ''}</textarea></label>
<label>Infobox (one row per line: <code>Label | type | value</code>; types: text, number, date, url, boolean, page, media) <textarea name="infobox" rows="5">${values.infobox || ''}</textarea></label>
${citations.length ? html`<fieldset><legend>Sources of revision ${String(baseRevision)} (untick to drop from the new revision; they stay on the old one)</legend>${citations.map((c) => html`<label class="wk-check"><input type="checkbox" name="keep_citation" value="${String(c.id)}"${values.keep && !values.keep.includes(String(c.id)) ? '' : raw(' checked')}> ${c.title || c.url || c.sourceItemId}${c.retrievedAt ? html`, retrieved ${t(c.retrievedAt)}` : ''}</label>`)}</fieldset>` : ''}
${citationRows(2)}
<label>Edit note <input type="text" name="message" maxlength="300" value="${values.message || ''}"></label>
<p class="wk-buttons"><button type="submit" name="op" value="preview">Preview</button> <button type="submit" name="op" value="save">Save revision</button> <button type="submit" name="op" value="publish">Save and publish</button></p>
</form></section>`;
}

function formValuesFromRevision(rev, page) {
    return { title: rev ? rev.fields.title : (page ? page.title : ''), summary: rev ? rev.fields.summary || '' : '', body: rev ? rev.content : '', infobox: rev ? infoboxToText(rev.fields.infobox || []) : '' };
}

function newSpacePage({ values = {}, error = null, staff = false }) {
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: 'New space' }])}
<section><h1>Start a space</h1>${error ? notice('error', error) : ''}
<form method="post" action="/new-space" class="wk-form">
<label>Name <input type="text" name="name" required maxlength="120" value="${values.name || ''}"></label>
<label>Address (optional; lowercase letters, digits and dashes) <input type="text" name="slug" maxlength="63" pattern="[a-z0-9][a-z0-9-]{1,62}" value="${values.slug || ''}"></label>
<label>Description <input type="text" name="description" maxlength="1000" value="${values.description || ''}"></label>
<label>Visibility <select name="visibility">${['public', 'members', 'private'].map((v) => html`<option value="${v}"${(values.visibility || 'public') === v ? raw(' selected') : ''}>${VIS_LABEL[v]}</option>`)}</select></label>
${staff ? html`<label class="wk-check"><input type="checkbox" name="official" value="1"> Official (editorial) space</label>` : ''}
<p><button type="submit">Create space</button></p></form></section>`;
}

const IMPORT_EXAMPLE = JSON.stringify({ pages: [
    { title: 'Bread', body: 'All about bread. See [[Rye]].', summary: 'One sentence.' },
    { title: 'Rye', parent: 'Bread', body: 'Rye bread is dense.', infobox: [{ label: 'Gluten', type: 'text', value: 'low' }], citations: [{ url: 'https://example.org/rye', title: 'Rye', retrievedAt: '2026-09-01' }] },
] }, null, 2);

function importPage({ space, values = {}, error = null, result = null }) {
    const base = `/s/${e(space.slug)}`;
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: base }, { name: 'Import' }])}
<section><h1>Import pages into ${space.name}</h1>
${error ? notice('error', `${error} Nothing was imported.`) : ''}
${result ? html`${notice('ok', `Imported ${result.created.length} page(s)${result.published ? ' and published them' : ' as drafts'}${result.skipped.length ? `; left ${result.skipped.length} existing page(s) alone` : ''}.`)}
<ul>${result.created.map((c) => html`<li><a href="${wpath(space, c.page)}">${c.page.title}</a> <span class="wk-tag">${c.page.state}</span></li>`)}</ul>
${result.skipped.length ? html`<p>Left alone: ${result.skipped.map((x, i) => html`${i ? ', ' : ''}${x.title} (${x.reason})`)}</p>` : ''}` : ''}
<p>Paste a bundle: JSON with a <code>pages</code> list (the same shape as the wiki's seed file). Each page has a <code>title</code> and a Markdown <code>body</code>, and optionally <code>summary</code>, <code>parent</code> (the title of another page), <code>infobox</code>, <code>citations</code> and <code>visibility</code>. Everything is checked first and imported in one step: if one page is invalid, nothing is imported. At most 200 pages and 2 MB.</p>
<details><summary>Example</summary><pre>${IMPORT_EXAMPLE}</pre></details>
<form method="post" action="${base}/import" class="wk-form">
<label>Bundle (JSON) <textarea name="bundle" rows="18" required>${values.bundle || ''}</textarea></label>
<label>Where the text comes from (shown on each page as "Imported from …") <input type="text" name="source" maxlength="200" value="${values.source || ''}"></label>
<label>Pages that already exist <select name="on_existing"><option value="fail"${values.on_existing !== 'skip' ? raw(' selected') : ''}>stop: import nothing</option><option value="skip"${values.on_existing === 'skip' ? raw(' selected') : ''}>leave them alone, import the rest</option></select></label>
<label class="wk-check"><input type="checkbox" name="publish" value="1"${values.publish ? raw(' checked') : ''}> Publish the imported pages (otherwise they are drafts only editors see)</label>
<label class="wk-check"><input type="checkbox" name="ai_assisted" value="1"${values.ai_assisted ? raw(' checked') : ''}> The text was written with AI assistance (search engines skip each page until a person reviews it)</label>
<p><button type="submit">Import</button></p></form></section>`;
}

function spaceSettingsPage({ space, roles, error = null, flash = null }) {
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }, { name: 'Settings' }])}
<section><h1>Settings of ${space.name}</h1>${error ? notice('error', error) : ''}${flash ? notice('ok', flash) : ''}
<form method="post" action="/s/${e(space.slug)}/settings" class="wk-form">
<label>Name <input type="text" name="name" maxlength="120" value="${space.name}"></label>
<label>Description <input type="text" name="description" maxlength="1000" value="${space.description || ''}"></label>
<label>Visibility <select name="visibility">${['public', 'members', 'private'].map((v) => html`<option value="${v}"${space.visibility === v ? raw(' selected') : ''}>${VIS_LABEL[v]}</option>`)}</select></label>
<p class="wk-muted">Making a space members-only or private removes its pages from sitemaps, feeds and OpenVibe.Search.</p>
<p><button type="submit" name="op" value="settings">Save settings</button></p></form>
<h2>Roles</h2>
<table><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Since</th><th scope="col"></th></tr></thead><tbody>
${roles.map((r) => html`<tr><td><code>${r.subject}</code></td><td>${r.role}</td><td>${t(r.granted_at)}</td><td><form method="post" action="/s/${e(space.slug)}/settings" class="wk-inline"><input type="hidden" name="op" value="role"><input type="hidden" name="subject" value="${r.subject}"><input type="hidden" name="role" value=""><button type="submit">Remove</button></form></td></tr>`)}
</tbody></table>
<form method="post" action="/s/${e(space.slug)}/settings" class="wk-form"><input type="hidden" name="op" value="role">
<label>Person (usr_… subject id) <input type="text" name="subject" required pattern="usr_[0-9A-Z]{26}"></label>
<label>Role <select name="role"><option value="editor">editor</option><option value="viewer">viewer</option><option value="owner">owner</option></select></label>
<p><button type="submit">Grant role</button></p></form>
<h2>Import</h2><p><a href="/s/${e(space.slug)}/import">Import pages from a bundle</a></p>
<h2>Delete</h2><form method="post" action="/s/${e(space.slug)}/settings" class="wk-form"><input type="hidden" name="op" value="delete"><label class="wk-check"><input type="checkbox" name="confirm" value="yes" required> Delete this space and take every page offline (addresses answer 410 Gone)</label><p><button type="submit">Delete space</button></p></form>
</section>`;
}

function pageSettingsPage({ space, page, v, parents, error = null, flash = null, canManage }) {
    const base = wpath(space, page);
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }, { name: page.title, url: base }, { name: 'Settings' }])}
<section><h1>Settings of ${page.title}</h1>${error ? notice('error', error) : ''}${flash ? notice('ok', flash) : ''}
<p>State: <strong>${page.state}</strong>${page.published_revision ? html` · published revision ${String(page.published_revision)}` : ''} · visibility ${page.visibility} (space: ${space.visibility})</p>
<h2>Publish</h2>
<form method="post" action="${base}/settings" class="wk-form"><input type="hidden" name="op" value="publish">
<label>Revision <input type="number" name="revision" min="1" value="${String(v.headNumber)}"></label>
<p><button type="submit">Publish now</button></p></form>
<form method="post" action="${base}/settings" class="wk-form"><input type="hidden" name="op" value="schedule">
<label>Revision <input type="number" name="revision" min="1" value="${String(v.headNumber)}"></label>
<label>Publish at (UTC) <input type="datetime-local" name="run_at" required></label>
<p><button type="submit">Schedule</button></p></form>
${v.jobs.length ? html`<ul>${v.jobs.map((j) => html`<li>${j.action} revision ${String(j.revision)} at ${t(j.runAt)} (${j.status})</li>`)}</ul>` : ''}
${page.state === 'published' ? html`<form method="post" action="${base}/settings" class="wk-form"><input type="hidden" name="op" value="unpublish"><p><button type="submit">Unpublish</button></p></form>` : ''}
<h2>Move or rename</h2>
<form method="post" action="${base}/settings" class="wk-form"><input type="hidden" name="op" value="move">
<label>Address <input type="text" name="slug" value="${page.slug}" required></label>
<label>Parent <select name="parent_id"><option value="">(top level)</option>${parents.filter((p) => p.id !== page.id).map((p) => html`<option value="${p.id}"${page.parent_id === p.id ? raw(' selected') : ''}>${p.title}</option>`)}</select></label>
<p class="wk-muted">The old address keeps working as a permanent redirect.</p>
<p><button type="submit">Move</button></p></form>
<h2>Media attachments</h2>
<p class="wk-muted">Attach public or unlisted OpenVibe.Media objects you can read; every reader of this page sees them. Attachments stay when someone else edits the page; if Media deletes an object or makes it private, the page shows a placeholder instead.</p>
${v.attachments.length ? html`<ul>${v.attachments.map((a) => html`<li><code>${a.mediaId}</code> ${a.state}${a.brokenReason ? ` (${a.brokenReason})` : ''}${a.attachedBy ? html` <span class="wk-muted">attached by <code>${a.attachedBy}</code></span>` : ''} <form method="post" action="${base}/settings" class="wk-inline"><input type="hidden" name="op" value="detach"><input type="hidden" name="attachment_id" value="${String(a.id)}"><button type="submit">Detach</button></form></li>`)}</ul>` : html`<p class="wk-muted">No media attached.</p>`}
<form method="post" action="${base}/settings" class="wk-form"><input type="hidden" name="op" value="attach">
<label>OpenVibe.Media object id <input type="text" name="media_id" required placeholder="med_…"></label>
<label>Alt text <input type="text" name="alt" maxlength="1000"></label>
<label>Caption <input type="text" name="caption" maxlength="2000"></label>
<p><button type="submit">Attach</button> <button type="submit" name="op" value="verify" formnovalidate>Check attachments against Media</button></p></form>
${canManage ? html`<h2>Visibility</h2><form method="post" action="${base}/settings" class="wk-form"><input type="hidden" name="op" value="visibility">
<label>Visibility <select name="visibility">${['public', 'members', 'private'].map((x) => html`<option value="${x}"${page.visibility === x ? raw(' selected') : ''}>${VIS_LABEL[x]}</option>`)}</select></label>
<label class="wk-check"><input type="checkbox" name="noindex" value="1"${page.noindex ? raw(' checked') : ''}> Ask search engines not to index this page</label>
<p><button type="submit">Save</button></p></form>
<h2>Delete</h2><form method="post" action="${base}/settings" class="wk-form"><input type="hidden" name="op" value="delete"><label class="wk-check"><input type="checkbox" name="confirm" value="yes" required> Delete this page (its address answers 410 Gone; history is kept)</label><p><button type="submit">Delete page</button></p></form>` : ''}
</section>`;
}

function revertPage({ space, page, to, head }) {
    const base = wpath(space, page);
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }, { name: page.title, url: base }, { name: 'Revert' }])}
<section><h1>Revert ${page.title} to revision ${String(to)}</h1>
<p>This adds revision ${String(head + 1)} with the text, infobox and sources of revision ${String(to)}. Nothing is deleted; <a href="${base}/diff/${String(head)}/${String(to)}">see what changes</a>.</p>
<form method="post" action="${base}/revert" class="wk-form"><input type="hidden" name="to" value="${String(to)}"><input type="hidden" name="expected_revision" value="${String(head)}">
<label>Note <input type="text" name="message" maxlength="300"></label>
${page.state === 'published' ? html`<p class="wk-muted">The page is published, so the revert is published at once.</p>` : ''}
<p><button type="submit">Revert</button></p></form></section>`;
}

function confirmPublishPage({ space, page, rev }) {
    const base = wpath(space, page);
    return html`<section><h1>Publish revision ${String(rev)} of ${page.title}?</h1><form method="post" action="${base}/settings" class="wk-form"><input type="hidden" name="op" value="publish"><input type="hidden" name="revision" value="${String(rev)}"><p><button type="submit">Publish</button> <a href="${base}/history">Cancel</a></p></form></section>`;
}

function proposalsPage({ space, items }) {
    return html`${crumbs([{ name: 'Wiki', url: '/' }, { name: space.name, url: `/s/${e(space.slug)}` }, { name: 'AI proposals' }])}
<section><h1>AI proposals in ${space.name}</h1>
<p class="wk-muted">AI workflows propose revisions; nothing they write is published until a person approves it here.</p>
${items.length ? html`<ul class="wk-proposals">${items.map(({ proposal: p, page }) => html`<li><a href="${wpath(space, page)}?rev=${String(p.revision)}">${page.title}, revision ${String(p.revision)}</a> by workflow <code>${p.workflow_id}</code> (run <code>${p.run_id}</code>)${p.stub_provider ? ' · stub provider' : ''} ${t(p.created_at)}
${p.base_revision ? html` · <a href="${wpath(space, page)}/diff/${String(p.base_revision)}/${String(p.revision)}">diff against revision ${String(p.base_revision)}</a>` : ''}
${p.note ? html`<br><span class="wk-muted">${p.note}</span>` : ''}
<form method="post" action="/proposals/${p.id}" class="wk-inline"><input type="hidden" name="decision" value="approved"><button type="submit">Approve and publish</button></form>
<form method="post" action="/proposals/${p.id}" class="wk-inline"><input type="hidden" name="decision" value="rejected"><button type="submit">Reject</button></form></li>`)}</ul>` : html`<p>No proposals wait for review.</p>`}
</section>`;
}

function searchPage({ query, results }) {
    return html`<section><h1>Search</h1>
<form action="/search" method="get" class="wk-form" role="search"><label>Words <input type="search" name="q" value="${query || ''}"></label><button type="submit">Search</button></form>
${query ? (results.length ? html`<ol class="wk-results">${results.map((r) => html`<li><a href="${wpath(r.space, r.page)}">${r.page.title}</a> <span class="wk-muted">${r.space.name}</span><br>${r.summary}</li>`)}</ol>` : html`<p>No published page matches.</p>`) : ''}
</section>`;
}

function recentPage({ items }) {
    return html`<section><h1>Recent changes</h1>
<p>Public pages by the time their current revision was published. <a href="/feed.atom">Atom</a> · <a href="/feed.json">JSON Feed</a></p>
${items.length ? html`<ol class="wk-recent">${items.map((r) => html`<li><a href="${wpath(r.space, r.page)}">${r.page.title}</a> revision ${String(r.page.published_revision)} · ${r.space.name} · ${t(r.page.revision_published_at)}</li>`)}</ol>` : html`<p class="wk-muted">Nothing published yet.</p>`}
</section>`;
}

function signInPage({ next, message }) {
    return html`<section><h1>Sign in</h1><p>${message}</p><p><a class="wk-button" href="/auth/login?next=${e(next || '/')}">Sign in with OpenVibe</a></p></section>`;
}

module.exports = {
    home, spacePage, articlePage, historyPage, sourcesPage, diffPage, editPage, formValuesFromRevision, newSpacePage,
    spaceSettingsPage, importPage, pageSettingsPage, revertPage, confirmPublishPage, proposalsPage, searchPage, recentPage,
    signInPage, errorBody, wpath, VIS_LABEL,
};
