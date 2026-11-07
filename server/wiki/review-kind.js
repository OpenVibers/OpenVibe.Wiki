'use strict';
/**
 * Two reviewer kinds in one append-only log (the `wiki_page_reviews` table
 * openvibe-publishing/authorship creates):
 *
 *   person     a signed-in person's approval or rejection (a usr_… subject). The library's
 *              reviews.record() writes these, unchanged.
 *   ai_editor  the orchestrator's service principal — a svc:… principal whose token holds
 *              wiki.review.ai_editor — recorded with its principal, the time and a note.
 *              migrations/0007_review_kinds.sql adds the reviewer_kind column (default 'person').
 *
 * An ai_editor approval publishes and indexes AI-written text exactly as a person's approval
 * does, but it never reads as a person's review: the label is "Checked by OpenVibe's AI editor".
 * Authorship stays the library's: this module only adds the kind to the log's rows and the words
 * that follow from it.
 */
const { ids } = require('openvibe-contracts');

const AI_EDITOR = 'ai_editor';
const PERSON = 'person';
const AI_EDITOR_LABEL = "Checked by OpenVibe's AI editor";
const PRINCIPAL_RE = /^svc:[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const isPersonSubject = (v) => ids.isSubjectId('user', v);

/** 'person' for anything the shared log wrote before the kind column existed. */
function reviewerKind(review) {
    return review && review.reviewerKind === AI_EDITOR ? AI_EDITOR : PERSON;
}

function isPersonReview(review) {
    return Boolean(review && reviewerKind(review) === PERSON && review.decision === 'approved' && isPersonSubject(review.reviewer));
}

function isAiEditorReview(review) {
    return Boolean(review && reviewerKind(review) === AI_EDITOR && review.decision === 'approved' && PRINCIPAL_RE.test(String(review.reviewer)));
}

/** An approving review of either kind: what lets AI-written text be published and indexed. */
function approved(review) {
    return isPersonReview(review) || isAiEditorReview(review);
}

/** The ISO date a review was recorded (YYYY-MM-DD), or null. */
function reviewDate(review) {
    if (!review || !review.reviewedAt) return null;
    const d = new Date(review.reviewedAt);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** "Checked by OpenVibe's AI editor on 2026-11-06", or null when the AI editor did not approve. */
function aiEditorLabel(review) {
    if (!isAiEditorReview(review)) return null;
    const d = reviewDate(review);
    return d ? `${AI_EDITOR_LABEL} on ${d}` : AI_EDITOR_LABEL;
}

/** What the AI editor decided, for the staff queue: the approval label or "Kept hidden by …". */
function aiEditorVerdict(review) {
    if (!review || reviewerKind(review) !== AI_EDITOR) return null;
    const d = reviewDate(review);
    const what = review.decision === 'approved' ? AI_EDITOR_LABEL : "Kept hidden by OpenVibe's AI editor";
    return d ? `${what} on ${d}` : what;
}

/** The public labels for a revision, from the review of each kind: [] when nobody approved it. */
function labelsFor({ person = null, ai_editor = null } = {}) {
    const labels = [];
    if (isPersonReview(person)) labels.push('Reviewed by a person');
    const ai = aiEditorLabel(ai_editor);
    if (ai) labels.push(ai);
    return labels;
}

function shape(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        entityId: row.entityId !== undefined ? row.entityId : row.entity_id,
        revision: Number(row.revision),
        reviewer: row.reviewer,
        reviewerKind: (row.reviewerKind || row.reviewer_kind) === AI_EDITOR ? AI_EDITOR : PERSON,
        decision: row.decision,
        note: row.note,
        reviewedAt: typeof row.reviewedAt === 'string' ? row.reviewedAt : new Date(Number(row.reviewed_at)).toISOString(),
    };
}

function byKind(rows) {
    const out = { person: null, ai_editor: null };
    for (const row of rows) out[row.reviewer_kind === AI_EDITOR ? AI_EDITOR : PERSON] = shape(row);
    return out;
}

/** The newest decision of either kind (the log's latest row decides whether the text is reviewed). */
function latestOf({ person = null, ai_editor = null } = {}) {
    if (!person) return ai_editor || null;
    if (!ai_editor) return person;
    return Number(ai_editor.id) > Number(person.id) ? ai_editor : person;
}

/**
 * The product's review store: the shared log plus kind-aware reads and the ai_editor write.
 * `prefix` names the product's own table (e.g. 'wiki_page' → wiki_page_reviews).
 */
function createReviewKindLog(log, { db, prefix, now = () => Date.now() } = {}) {
    const R = `${prefix}_reviews`;
    const latestStmt = db.prepare(`SELECT * FROM ${R} WHERE entity_id = ? AND revision = ? ORDER BY id DESC LIMIT 1`);
    const latestByKindStmt = db.prepare(`SELECT DISTINCT ON (reviewer_kind) * FROM ${R}
        WHERE entity_id = ? AND revision = ? ORDER BY reviewer_kind, id DESC`);
    const latestManyStmt = db.prepare(`SELECT DISTINCT ON (r.entity_id, r.revision) r.*
        FROM unnest(?::text[], ?::integer[]) AS k(entity_id, revision)
        JOIN ${R} r ON r.entity_id = k.entity_id AND r.revision = k.revision
        ORDER BY r.entity_id, r.revision, r.id DESC`);
    const latestByKindManyStmt = db.prepare(`SELECT DISTINCT ON (r.entity_id, r.revision, r.reviewer_kind) r.*
        FROM unnest(?::text[], ?::integer[]) AS k(entity_id, revision)
        JOIN ${R} r ON r.entity_id = k.entity_id AND r.revision = k.revision
        ORDER BY r.entity_id, r.revision, r.reviewer_kind, r.id DESC`);
    const insertEditor = db.prepare(`INSERT INTO ${R} (entity_id, revision, reviewer, reviewer_kind, decision, note, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`);
    const historyStmt = db.prepare(`SELECT * FROM ${R} WHERE entity_id = ? ORDER BY id LIMIT ?`);

    const number = (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= 2147483647 ? n : null;
    };

    async function latest(entityId, revision) {
        const n = number(revision);
        if (n == null) return null;
        return shape(await latestStmt.get(entityId, n));
    }

    async function latestByKind(entityId, revision) {
        const n = number(revision);
        if (n == null) return { person: null, ai_editor: null };
        return byKind(await latestByKindStmt.all(entityId, n));
    }

    async function latestMany(refs = []) {
        const keys = refs.filter((r) => r && number(r.revision) != null);
        if (!keys.length) return refs.map(() => null);
        const rows = await latestManyStmt.all(keys.map((r) => r.entityId), keys.map((r) => number(r.revision)));
        const by = new Map(rows.map((r) => [`${r.entity_id}\u0000${r.revision}`, shape(r)]));
        return refs.map((r) => (r && by.get(`${r.entityId}\u0000${Number(r.revision)}`)) || null);
    }

    async function latestByKindMany(refs = []) {
        const keys = refs.filter((r) => r && number(r.revision) != null);
        if (!keys.length) return refs.map(() => ({ person: null, ai_editor: null }));
        const rows = await latestByKindManyStmt.all(keys.map((r) => r.entityId), keys.map((r) => number(r.revision)));
        const by = new Map();
        for (const row of rows) {
            const key = `${row.entity_id}\u0000${row.revision}`;
            const out = by.get(key) || { person: null, ai_editor: null };
            out[row.reviewer_kind === AI_EDITOR ? AI_EDITOR : PERSON] = shape(row);
            by.set(key, out);
        }
        return refs.map((r) => (r && by.get(`${r.entityId}\u0000${Number(r.revision)}`)) || { person: null, ai_editor: null });
    }

    /** An ai_editor review: the service principal that made it, never a person's subject. */
    async function recordAiEditor({ entityId, revision, principal, decision, note = null } = {}) {
        const n = number(revision);
        if (n == null) throw new TypeError('revision must be a non-negative integer');
        if (!PRINCIPAL_RE.test(String(principal))) throw new TypeError('principal must be a svc:… principal');
        if (decision !== 'approved' && decision !== 'rejected') throw new TypeError('decision must be approved or rejected');
        return shape(await insertEditor.get(String(entityId), n, String(principal), AI_EDITOR, decision, note == null ? null : String(note).slice(0, 2000), now()));
    }

    /** The shared log's person write, with the kind its row has by default. */
    async function record(args) {
        return shape(await log.record(args));
    }

    async function history(entityId, { limit = 1000 } = {}) {
        const n = Math.max(1, Math.min(10000, Math.floor(Number(limit)) || 1000));
        return (await historyStmt.all(entityId, n)).map(shape);
    }

    return {
        ...log,
        record,
        history,
        latest,
        latestMany,
        latestByKind,
        latestByKindMany,
        recordAiEditor,
    };
}

module.exports = {
    AI_EDITOR, PERSON, AI_EDITOR_LABEL, PRINCIPAL_RE,
    reviewerKind, isPersonReview, isAiEditorReview, approved, reviewDate, aiEditorLabel, aiEditorVerdict, labelsFor, latestOf,
    createReviewKindLog,
};
