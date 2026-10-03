'use strict';
/**
 * STATUS.json and README name the release each openvibe package is pinned to; package.json is the
 * truth. A pin bump that leaves the prose behind makes downstream repositories advertise a version
 * this one does not run (OpenVibe.Publishing's STATUS.json lists consumers by pinned version).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const status = JSON.parse(fs.readFileSync(path.join(root, 'STATUS.json'), 'utf8'));

/** The tag of a pinned release tarball, e.g. ".../v1.1.0" -> "1.1.0". */
function pinnedTag(name) {
    const url = pkg.dependencies[name];
    assert.ok(url, `package.json does not depend on ${name}`);
    const m = /\/tags\/v(\d+\.\d+\.\d+)$/.exec(url);
    assert.ok(m, `${name} is not pinned to a release tag: ${url}`);
    return m[1];
}

for (const entry of status.packages) {
    const m = /^(\S+) v(\d+\.\d+\.\d+)$/.exec(entry);
    assert.ok(m, `STATUS.json packages entry is not "<name> vX.Y.Z": ${entry}`);
    assert.strictEqual(m[2], pinnedTag(m[1]), `STATUS.json says ${entry}, but package.json pins ${pinnedTag(m[1])}`);
}
assert.ok(/openvibe-contracts v\d+\.\d+\.\d+$/.test(status.contracts), 'STATUS.json contracts names a version');
assert.strictEqual(status.contracts.split(' v')[1], pinnedTag('openvibe-contracts'), 'STATUS.json contracts matches package.json');

console.log('status pins: all checks passed');
