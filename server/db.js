'use strict';
/**
 * Wiki's own PostgreSQL database (ADR-035, roadmap WS-X2), through openvibe-sdk/db: async, pooled, one dialect.
 *
 * The schema is migrations/NNNN_*.sql (expand/migrate/contract, ADR-028), applied at boot on the owner's direct
 * connection (DATABASE_DIRECT_URL); the service then serves on the pooled runtime role (DATABASE_URL, PgBouncer in
 * transaction mode). Ambient transactions (openvibe-sdk ≥ 0.18): inside db.tx(fn), plain db calls — the prepared
 * statements in server/wiki/service.js and the openvibe-publishing stores — join the transaction.
 *
 * The ten authority tables of roadmap §15.13:
 *   wiki_spaces            spaces (official editorial spaces and user spaces)
 *   wiki_pages             canonical page identities, slugs, tree, publication state
 *   wiki_page_revisions    immutable revisions            (openvibe-publishing/revisions, prefix wiki_page)
 *   wiki_page_links        [[internal links]] per revision
 *   wiki_page_redirects    every historical path → page   (openvibe-publishing/seo, prefix wiki_page)
 *   wiki_citations         citations per (page, revision) (openvibe-publishing/citations, prefix wiki)
 *   wiki_infobox_values    typed infobox values per (page, revision), append-only
 *   wiki_permissions       space roles: owner / editor / viewer
 *   wiki_watchers          who watches a page (notified through an event, never email)
 *   wiki_ai_proposals      AI-authored draft revisions awaiting a person's decision
 * plus the Publishing helper tables under the same prefixes, wiki_attachment_origins, wiki_module_dirty/_pushes
 * and wiki_event_outbox (openvibe-sdk/events PostgreSQL outbox).
 *
 *   openDb(config)             the serving handle: DATABASE_URL; in development without it, an embedded PGlite
 *                              database in data/pglite (WIKI_PGLITE_DIR overrides it; one process, nothing to install)
 *   migrate(config, {serving}) apply migrations/ with the owner role (DATABASE_DIRECT_URL), then close it
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');
const { createAttachmentStore } = require('openvibe-publishing/media');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');
const { createScheduler } = require('openvibe-publishing/schedule');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');
const seo = require('openvibe-publishing/seo');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

function openDb(config, { registry, log = console } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh wiki)');
        const dir = process.env.WIKI_PGLITE_DIR || DEV_PGLITE;
        log.warn(`[Wiki] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        return createDb({ pglite: dir, service: 'wiki', registry, log });
    }
    return createDb({ url: config.db.url, service: 'wiki', registry, log });
}

/** Apply pending migrations (several processes starting together are safe: the SDK takes an advisory lock). */
async function migrate(config, { serving = null, log = console } = {}) {
    if (serving && serving.store === 'pglite') return serving.migrate({ dir: MIGRATIONS, log });
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'wiki-migrate', max: 1, log });
    try { return await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
}

/** The openvibe-publishing stores bound to this database (their tables are in migrations/). */
function createStores(db, { now = () => Date.now(), scheduleLeaseMs = 60000 } = {}) {
    const revisions = createRevisionStore(db, { prefix: 'wiki_page', now });
    return {
        revisions,
        citations: createCitationStore(db, { prefix: 'wiki', now, revisions }),
        redirects: seo.createRedirectStore(db, { prefix: 'wiki_page', now }),
        reviews: createReviewLog(db, { prefix: 'wiki_page', now }),
        attachments: createAttachmentStore(db, { prefix: 'wiki_page', now }),
        discussions: createDiscussionRefs(db, { prefix: 'wiki', now }),
        scheduler: createScheduler(db, { prefix: 'wiki', now, leaseMs: scheduleLeaseMs }),
        sequencer: createIndexSequencer(db, { prefix: 'wiki', now }),
    };
}

module.exports = { openDb, migrate, createStores, MIGRATIONS };
