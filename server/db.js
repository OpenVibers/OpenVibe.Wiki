'use strict';
/**
 * Wiki's own SQLite database (one per service, WAL, created on boot, idempotent).
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
 *
 * The Publishing packages add their helper tables under the same prefix (wiki_page_drafts,
 * wiki_page_reviews, wiki_page_attachments, wiki_schedule_jobs, wiki_discussion_refs,
 * wiki_index_revisions, the purge audit tables) and the SDK outbox keeps wiki_event_outbox.
 * wiki_attachment_origins records who attached each Media object and the read rights checked then.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');
const { createAttachmentStore } = require('openvibe-publishing/media');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');
const { createScheduler } = require('openvibe-publishing/schedule');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');
const seo = require('openvibe-publishing/seo');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wiki_spaces (
    id           TEXT PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    description  TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('official','user')),
    visibility   TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','members','private')),
    owner        TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);

CREATE TABLE IF NOT EXISTS wiki_pages (
    id                  TEXT PRIMARY KEY,
    space_id            TEXT NOT NULL REFERENCES wiki_spaces(id),
    slug                TEXT NOT NULL,
    title               TEXT NOT NULL,
    parent_id           TEXT REFERENCES wiki_pages(id),
    position            INTEGER NOT NULL DEFAULT 0,
    state               TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','scheduled','published','unpublished','deleted')),
    visibility          TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','members','private')),
    noindex             INTEGER NOT NULL DEFAULT 0,
    published_revision  INTEGER,
    published_at        INTEGER,
    revision_published_at INTEGER,
    created_by          TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    UNIQUE (space_id, slug)
);
CREATE INDEX IF NOT EXISTS wiki_pages_parent ON wiki_pages (space_id, parent_id, position);
CREATE INDEX IF NOT EXISTS wiki_pages_updated ON wiki_pages (updated_at);

CREATE TABLE IF NOT EXISTS wiki_page_links (
    from_page_id     TEXT NOT NULL,
    from_revision    INTEGER NOT NULL,
    target_space     TEXT NOT NULL,
    target_slug      TEXT NOT NULL,
    label            TEXT,
    PRIMARY KEY (from_page_id, from_revision, target_space, target_slug)
);
CREATE INDEX IF NOT EXISTS wiki_page_links_target ON wiki_page_links (target_space, target_slug);

CREATE TABLE IF NOT EXISTS wiki_infobox_values (
    page_id       TEXT NOT NULL,
    revision      INTEGER NOT NULL,
    position      INTEGER NOT NULL,
    key           TEXT NOT NULL,
    label         TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('text','number','date','url','boolean','page','media')),
    value_text    TEXT,
    value_number  REAL,
    PRIMARY KEY (page_id, revision, key)
);
CREATE TRIGGER IF NOT EXISTS wiki_infobox_values_no_update BEFORE UPDATE ON wiki_infobox_values
BEGIN SELECT RAISE(ABORT, 'wiki_infobox_values rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS wiki_infobox_values_no_delete BEFORE DELETE ON wiki_infobox_values
WHEN NOT EXISTS (SELECT 1 FROM wiki_page_revision_purges WHERE entity_id = OLD.page_id)
BEGIN SELECT RAISE(ABORT, 'wiki_infobox_values rows are never deleted outside a recorded purge'); END;
CREATE TRIGGER IF NOT EXISTS wiki_page_links_no_update BEFORE UPDATE ON wiki_page_links
BEGIN SELECT RAISE(ABORT, 'wiki_page_links rows are immutable'); END;

CREATE TABLE IF NOT EXISTS wiki_permissions (
    space_id    TEXT NOT NULL REFERENCES wiki_spaces(id),
    subject     TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
    granted_by  TEXT,
    granted_at  INTEGER NOT NULL,
    PRIMARY KEY (space_id, subject)
);
CREATE INDEX IF NOT EXISTS wiki_permissions_subject ON wiki_permissions (subject);

-- People whose wiki.projects user module (Network) needs writing again: marked in the same transaction as
-- the space or role change, drained by server/integrations/projects-module.js.
CREATE TABLE IF NOT EXISTS wiki_module_dirty (
    subject     TEXT PRIMARY KEY,
    marked_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wiki_module_pushes (
    subject     TEXT PRIMARY KEY,
    hash        TEXT NOT NULL,
    pushed_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wiki_watchers (
    page_id     TEXT NOT NULL REFERENCES wiki_pages(id),
    subject     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (page_id, subject)
);

CREATE TABLE IF NOT EXISTS wiki_ai_proposals (
    id             TEXT PRIMARY KEY,
    page_id        TEXT NOT NULL REFERENCES wiki_pages(id),
    space_id       TEXT NOT NULL REFERENCES wiki_spaces(id),
    revision       INTEGER NOT NULL,
    base_revision  INTEGER NOT NULL,
    workflow_id    TEXT NOT NULL,
    run_id         TEXT NOT NULL,
    stub_provider  INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    proposed_by    TEXT NOT NULL,
    note           TEXT,
    reviewed_by    TEXT,
    review_note    TEXT,
    reviewed_at    INTEGER,
    created_at     INTEGER NOT NULL,
    UNIQUE (page_id, revision)
);
CREATE INDEX IF NOT EXISTS wiki_ai_proposals_status ON wiki_ai_proposals (status, created_at);

-- Who attached a Media object to a page, and what Media said about it at that moment (the read
-- rights that were checked). One row per attachment, written with it and never changed.
CREATE TABLE IF NOT EXISTS wiki_attachment_origins (
    attachment_id     INTEGER PRIMARY KEY,
    page_id           TEXT NOT NULL,
    media_id          TEXT NOT NULL,
    attached_by       TEXT NOT NULL,
    media_owner       TEXT,
    media_visibility  TEXT NOT NULL CHECK (media_visibility IN ('public','unlisted','private')),
    attached_at       INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS wiki_attachment_origins_no_update BEFORE UPDATE ON wiki_attachment_origins
BEGIN SELECT RAISE(ABORT, 'wiki_attachment_origins rows are immutable'); END;
`;

function openDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return db;
}

/**
 * Creates every table (package tables first: the infobox purge trigger references
 * wiki_page_revision_purges) and returns the package stores bound to this database.
 */
function createStores(db, { now = () => Date.now(), scheduleLeaseMs = 60000 } = {}) {
    const revisions = createRevisionStore(db, { prefix: 'wiki_page', now });
    db.exec(SCHEMA);
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

module.exports = { openDb, createStores, SCHEMA };
