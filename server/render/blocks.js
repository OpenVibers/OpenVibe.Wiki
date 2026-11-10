'use strict';
/**
 * A wiki page body rendered as Markdown plus blocks (openvibe-publishing/blocks).
 *
 * The Markdown stays the source of truth: a revision keeps it, revisions diff it, and a body with no
 * blocks renders exactly as it did before. A body with blocks — infobox, figure, gallery, timeline,
 * quote, callout, stat and the rest — renders server-side to plain HTML, so a reader without
 * JavaScript sees the same page and a crawler reads it.
 *
 * Wiki resolves the things a block names the way it always has: [[Page title]] links (including red
 * links), [[media:med_…]] figures, and the attachments the page owns. A picture that is gone is an
 * explicit placeholder, never a guessed URL.
 */
const blocks = require('openvibe-publishing/blocks');
const { figureHtml } = require('openvibe-publishing/media');
const content = require('../wiki/content');

const UNAVAILABLE = 'This picture is no longer available.';

/**
 * Render a revision's body.
 *
 *   renderBody(source, {
 *     currentSpace, resolve, rel, mediaUrl,
 *     attachments: [{ mediaId, width, height, alt, caption, broken, state }]
 *   })
 *     → { tree, html }
 */
function renderBody(source, { currentSpace, resolve, rel = 'noopener', mediaUrl = null, attachments = [] } = {}) {
    const byId = new Map((attachments || []).map((a) => [a.mediaId, a]));
    const figure = (mediaId, caption) => {
        const a = byId.get(mediaId);
        if (!a || !mediaUrl) return null;
        return figureHtml({ ...a, caption: caption || a.caption }, { urlFor: mediaUrl, unavailableText: UNAVAILABLE });
    };
    const media = (mediaId) => {
        const a = byId.get(mediaId);
        if (!a) return null;
        if (a.broken || a.state === 'broken') return { broken: true };
        return { width: a.width || null, height: a.height || null, alt: a.alt || '', caption: a.caption || null };
    };
    const tree = blocks.parse(source);
    const html = blocks.render(tree, {
        rel,
        // The page owns its h1 (the title): a section's "## Heading" stays an h2.
        headingShift: 1,
        media,
        urlFor: mediaUrl,
        renderText: (value, opts) => content.renderContent(value, {
            currentSpace, resolve, rel: opts.rel,
            media: (mediaId, caption) => figure(mediaId, caption),
        }),
    });
    return { tree, html };
}

/** The blocks of a body, for the API's `blocks` next to `body_markdown`. */
function bodyBlocks(source) {
    return blocks.parse(source);
}

/** The plain text of a body: what a summary, a feed and an AI reader get. */
function bodyText(source) {
    return blocks.toText(blocks.parse(source));
}

module.exports = { renderBody, bodyBlocks, bodyText };
