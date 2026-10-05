'use strict';
/**
 * Capability checks for service tokens. The wiki.* ids in CAPS are released by openvibe-contracts
 * (active, owner wiki), so capabilities.check() decides them; the local fallback below stays for a
 * future wiki.* id proposed in docs/capabilities-proposal/ before a release defines it.
 *
 * openvibe-contracts' capabilities.check() answers capability.unknown for an id that is not in its
 * manifests yet. Until a release defines such an id, a grant of it is decided locally with the
 * library's own matching rule (the exact id, or a `prefix.*` grant covering it). An id the library
 * knows always goes through the library, so the day a release lands nothing changes here.
 */
const { capabilities } = require('openvibe-contracts');

const CAPS = Object.freeze({
    SPACE_CREATE: 'wiki.space.create',
    PAGE_CREATE: 'wiki.page.create',
    PAGE_READ: 'wiki.page.read',
    REVISION_PROPOSE: 'wiki.revision.propose',
    REVISION_PUBLISH: 'wiki.revision.publish',
    REVISION_REVERT: 'wiki.revision.revert',
    CITATION_ATTACH: 'wiki.citation.attach',
    SEARCH_QUERY: 'wiki.search.query',
});
const PROPOSED = new Set(Object.values(CAPS));

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

module.exports = { checkCapability, CAPS, PROPOSED };
