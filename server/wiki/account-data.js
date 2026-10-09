'use strict';

/**
 * Account export and deletion → Wiki (ADR-033; openvibe-sdk/account-data). What Wiki holds about a person:
 *
 *   their own, deleted       drafts, page watches, the roles they hold in spaces, and the wiki.projects module state
 *   their user spaces        a space they own (kind 'user') is deleted the way its owner would delete it
 *                            (service.deleteSpace as the system actor: unpublished, its pages leave Search and the
 *                            sitemap), and its owner and creator become 'deleted'
 *   contributions elsewhere  stay, made authorless: pages (created_by), AI proposals (proposed_by), attachments
 *                            (attached_by) become 'deleted'; reviewed_by, granted_by, media_owner and purged_by become
 *                            NULL; revisions and citations are append-only, so only inside the erasure transaction
 *                            (wiki.account_erasure, migrations/0002_account_erasure.sql) may a revision's author become
 *                            NULL (and their id leave meta.authorship.authors) or a citation's attached_by become NULL
 *   kept                     page reviews: a person's approval is what lets reviewed text stay published
 *                            (openvibe-publishing/authorship), counted as retained
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const SYSTEM = Object.freeze({ kind: 'system', service: 'svc:wiki', subject: null });
const anonymize = { anonymize: {} };

const TABLES = [
    { table: 'wiki_page_drafts', subject: 'owner', file: 'drafts.json', columns: ['entity_id', 'base_revision', 'content', 'fields', 'created_at', 'updated_at'] },
    { table: 'wiki_watchers', subject: 'subject', file: 'watching.json', columns: ['page_id', 'created_at'] },
    { table: 'wiki_permissions', subject: 'subject', file: 'roles.json', columns: ['space_id', 'role', 'granted_at'], order: 'granted_at' },
    { table: 'wiki_permissions', subject: 'granted_by', file: null, erase: anonymize },
    { table: 'wiki_ai_proposals', subject: 'reviewed_by', file: null, erase: anonymize },
    { table: 'wiki_attachment_origins', subject: 'media_owner', file: null, erase: anonymize },
    { table: 'wiki_page_revision_purges', subject: 'purged_by', file: null, erase: anonymize },
    { table: 'wiki_citation_purges', subject: 'purged_by', file: null, erase: anonymize },
    { table: 'wiki_page_reviews', subject: 'reviewer', file: 'reviews.json', columns: ['entity_id', 'revision', 'decision', 'note', 'reviewed_at'], order: 'reviewed_at', erase: { keep: 'a person\'s approval is what lets reviewed text stay published' } },
];

async function extraExport(db, subject) {
    const files = [];
    const spaces = await db.many(`SELECT id, slug, name, description, kind, visibility, created_at, updated_at, deleted_at FROM wiki_spaces
        WHERE owner = $1 OR created_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (spaces.length) files.push({ name: 'spaces.json', content: spaces });
    const pages = await db.many(`SELECT id, space_id, slug, title, state, visibility, created_at, updated_at FROM wiki_pages
        WHERE created_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (pages.length) files.push({ name: 'pages.json', content: pages });
    const revisions = await db.many(`SELECT entity_id, number, kind, content, fields, message, created_at FROM wiki_page_revisions
        WHERE author = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (revisions.length) files.push({ name: 'revisions.json', content: revisions });
    const proposals = await db.many(`SELECT id, page_id, space_id, revision, status, note, created_at FROM wiki_ai_proposals
        WHERE proposed_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (proposals.length) files.push({ name: 'ai-proposals.json', content: proposals });
    return files;
}

/** The account-data handle over Wiki's database and service (service.deleteSpace for the person's own spaces). */
function create({ db, svc, log = console } = {}) {
    async function extraErase(t, subjects, counts) {
        // Their own user spaces go the way their owner would delete them (a savepoint inside this transaction).
        const spaces = await t.many("SELECT id FROM wiki_spaces WHERE kind = 'user' AND owner = ANY($1::text[]) AND deleted_at IS NULL", [subjects]);
        for (const s of spaces) await svc.deleteSpace(s.id, SYSTEM);
        counts.add(counts.erased, 'wiki_spaces', spaces.length);
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE wiki_spaces SET owner = 'deleted' WHERE owner = ANY($1::text[])", [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE wiki_spaces SET created_by = 'deleted' WHERE created_by = ANY($1::text[])", [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE wiki_pages SET created_by = 'deleted' WHERE created_by = ANY($1::text[])", [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE wiki_ai_proposals SET proposed_by = 'deleted' WHERE proposed_by = ANY($1::text[])", [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec("UPDATE wiki_attachment_origins SET attached_by = 'deleted' WHERE attached_by = ANY($1::text[])", [subjects]));
        // Only this transaction may take a person's id out of the append-only rows; the setting ends with it.
        await t.value("SELECT set_config('wiki.account_erasure', 'on', true)");
        counts.add(counts.retained, 'tombstones', await t.exec('UPDATE wiki_page_revisions SET author = NULL WHERE author = ANY($1::text[])', [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec(`UPDATE wiki_page_revisions
            SET meta = jsonb_set(meta, '{authorship,authors}', COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(meta->'authorship'->'authors') a
                WHERE NOT ((a #>> '{}') = ANY($1::text[]))), '[]'::jsonb))
            WHERE jsonb_typeof(meta->'authorship'->'authors') = 'array' AND (meta->'authorship'->'authors') ?| $1::text[]`, [subjects]));
        counts.add(counts.retained, 'tombstones', await t.exec('UPDATE wiki_citations SET attached_by = NULL WHERE attached_by = ANY($1::text[])', [subjects]));
        await t.value("SELECT set_config('wiki.account_erasure', 'off', true)");
        // Last: deleteSpace marked the owner for a wiki.projects push; nothing about them is pushed again.
        counts.add(counts.erased, 'wiki_module_dirty', await t.exec('DELETE FROM wiki_module_dirty WHERE subject = ANY($1::text[])', [subjects]));
        counts.add(counts.erased, 'wiki_module_pushes', await t.exec('DELETE FROM wiki_module_pushes WHERE subject = ANY($1::text[])', [subjects]));
    }
    return createAccountData({
        db, service: 'wiki', tables: TABLES, extraExport, extraErase, log,
        note: 'Your own user spaces are deleted. What you wrote in other spaces stays without your name; reviews you approved stay attributed.',
    });
}

module.exports = { create, TABLES, TOPICS, SYSTEM };
