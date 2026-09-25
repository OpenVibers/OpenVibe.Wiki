'use strict';
/**
 * wiki.projects on OpenVibe.Network (openvibe-contracts 0.41.0 user module, roadmap WS-B task 9): the
 * spaces a person owns or edits, for other sites. Only public spaces are named; the others are counted
 * (private_count). Wiki's spaces and roles stay the truth.
 *
 * A space or role change marks the people concerned in wiki_module_dirty inside its own transaction
 * (server/wiki/service.js); drain() writes each marked person's record as the owning service (grant wiki
 * network.modules.write on wiki.projects) and clears the mark. Written only when it changed
 * (wiki_module_pushes keeps a hash); someone who never had a space gets no record. Off without the
 * service principal; a failed write keeps the mark for the next drain.
 */
const crypto = require('crypto');

const NS = 'wiki.projects';
const MAX_SPACES = 50;

/** The record for one person: { spaces: [{ slug, name, role }], private_count }. */
function summarize(db, subject) {
    const rows = db.prepare(`SELECT s.slug, s.name, s.visibility,
            CASE WHEN p.role = 'owner' OR s.owner = @subject THEN 'owner' ELSE p.role END AS role
        FROM wiki_spaces s LEFT JOIN wiki_permissions p ON p.space_id = s.id AND p.subject = @subject
        WHERE s.deleted_at IS NULL AND (s.owner = @subject OR p.role IN ('owner', 'editor'))
        ORDER BY role = 'owner' DESC, s.name COLLATE NOCASE`).all({ subject });
    const pub = rows.filter((r) => r.visibility === 'public');
    return {
        spaces: pub.slice(0, MAX_SPACES).map((r) => ({ slug: r.slug, name: String(r.name).slice(0, 120), role: r.role })),
        private_count: rows.length - pub.length,
    };
}

function createProjectsModule({ db, config, tokens, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const enabled = !!tokens;
    const base = String(config.networkInternalUrl || config.networkUrl || '').replace(/\/+$/, '');
    const stats = { written: 0, unchanged: 0, failed: 0, lastError: null };
    let draining = false;

    async function put(subject, data) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders({ audience: 'openvibe.network' })) };
        const res = await fetchImpl(`${base}/internal/modules/${NS}/${encodeURIComponent(subject)}`, { method: 'PUT', headers, body: JSON.stringify({ data }), signal: AbortSignal.timeout(8000) });
        if (res.status === 401) tokens.invalidate({ audience: 'openvibe.network' });
        if (!res.ok) throw new Error(`Network answered ${res.status}`);
    }

    /** Write every marked person's record. → how many were written */
    async function drain({ limit = 200 } = {}) {
        if (!enabled || draining) return 0;
        draining = true;
        let written = 0;
        try {
            for (const { subject, marked_at: markedAt } of db.prepare('SELECT subject, marked_at FROM wiki_module_dirty ORDER BY marked_at LIMIT ?').all(limit)) {
                const clear = () => db.prepare('DELETE FROM wiki_module_dirty WHERE subject = ? AND marked_at = ?').run(subject, markedAt);
                const data = summarize(db, subject);
                const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
                const last = db.prepare('SELECT hash FROM wiki_module_pushes WHERE subject = ?').get(subject);
                if ((last && last.hash === hash) || (!last && !data.spaces.length && !data.private_count)) { stats.unchanged++; clear(); continue; }
                try { await put(subject, data); } catch (err) { stats.failed++; stats.lastError = err.message; continue; }
                db.prepare(`INSERT INTO wiki_module_pushes (subject, hash, pushed_at) VALUES (?, ?, ?)
                    ON CONFLICT (subject) DO UPDATE SET hash = excluded.hash, pushed_at = excluded.pushed_at`).run(subject, hash, now());
                clear();
                stats.written++; written++;
            }
        } finally { draining = false; }
        return written;
    }

    return { enabled, drain, stats: () => ({ enabled, ...stats }) };
}

module.exports = { NS, summarize, createProjectsModule };
