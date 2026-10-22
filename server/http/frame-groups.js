'use strict';
/**
 * The OpenVibe Frame's site groups ("Watch & stream", "Build & automate", …) as the Network's /api/chrome lists them for
 * the launcher, so the home can shelve the official wiki's product pages the way the launcher groups the sites.
 *
 *   const groups = createFrameGroups({ url: config.frameUrl });
 *   await groups.get()   →  { groups: [{ id, name }], hosts: Map(hostname → group id) }  or null
 *
 * One read per 30 minutes. A stale copy is served while a refresh runs behind it; only the first view after boot waits,
 * and never longer than the timeout. Off (no url), unreachable or malformed: null, and the home shows one flat shelf.
 */
function createFrameGroups({ url, fetchImpl = globalThis.fetch, ttlMs = 30 * 60 * 1000, retryMs = 60 * 1000, timeoutMs = 1500, now = Date.now } = {}) {
    let cached = null;
    let nextAt = 0;
    let pending = null;

    async function load() {
        const r = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) throw new Error(`the frame answered ${r.status}`);
        const d = await r.json();
        const groups = (Array.isArray(d && d.groups) ? d.groups : [])
            .filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string' && g.id && g.name)
            .slice(0, 12).map((g) => ({ id: g.id.slice(0, 20), name: g.name.slice(0, 40) }));
        const hosts = new Map();
        for (const n of Array.isArray(d && d.nav) ? d.nav : []) {
            if (!n || typeof n.group !== 'string' || typeof n.url !== 'string') continue;
            try { hosts.set(new URL(n.url).hostname, n.group.slice(0, 20)); } catch { /* not a URL */ }
        }
        return groups.length && hosts.size ? { groups, hosts } : null;
    }

    function refresh() {
        if (!pending) {
            pending = load().then((v) => { cached = v || cached; nextAt = now() + (v ? ttlMs : retryMs); return cached; },
                () => { nextAt = now() + retryMs; return cached; })
                .finally(() => { pending = null; });
        }
        return pending;
    }

    return {
        async get() {
            if (!url) return null;
            if (now() < nextAt) return cached;
            const p = refresh();
            return cached || await p;
        },
    };
}

module.exports = { createFrameGroups };
