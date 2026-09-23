'use strict';
/**
 * The proposals for OpenVibe.Contracts are valid against the contracts' own schemas and match
 * what the code enforces: every guarded capability has a manifest, every manifest is guarded,
 * and the service manifest lists them all with the events the code produces.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { PROPOSED } = require('../server/auth/capabilities');

const DOCS = path.join(__dirname, '..', 'docs');
const dir = path.join(DOCS, 'capabilities-proposal');
const ids = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const v = contracts.validate('capabilities.capability@1', m);
    assert.ok(v.valid, `${f}: ${JSON.stringify(v.errors)}`);
    assert.strictEqual(`${m.id}.json`, f);
    assert.strictEqual(m.owner, 'wiki');
    assert.ok(m.id.split('.').length === 3, `${m.id} has three segments`);
    ids.push(m.id);
}
assert.deepStrictEqual([...ids].sort(), [...PROPOSED].sort());

// Every guard('…') in the API is a proposed capability, and every proposed capability is guarded.
const api = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'api.js'), 'utf8');
const guarded = new Set([...api.matchAll(/guard\('([a-z.]+)'\)/g)].map((m) => m[1]));
assert.deepStrictEqual([...guarded].sort(), [...PROPOSED].sort());

const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'service-manifest-proposal.json'), 'utf8'));
const v = contracts.validate('registry.service-manifest@1', manifest);
assert.ok(v.valid, JSON.stringify(v.errors));
assert.strictEqual(manifest.id, 'wiki');
assert.deepStrictEqual([...manifest.capabilities].sort(), [...PROPOSED].sort());

// Events the code emits (literal types in the service + the Publishing hooks' page/index events).
const service = fs.readFileSync(path.join(__dirname, '..', 'server', 'wiki', 'service.js'), 'utf8');
const literal = [...service.matchAll(/event_type: '(wiki\.[a-z_.]+)'/g)].map((m) => m[1]);
const produced = new Set([...literal, 'wiki.page.published', 'wiki.page.updated', 'wiki.page.unpublished', 'wiki.page.deleted', 'wiki.index_document.upserted', 'wiki.index_document.deleted']);
assert.deepStrictEqual([...manifest.eventsProduced].sort(), [...produced].sort());
for (const t of produced) assert.ok(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/.test(t), t);

// The §15.13 minimum set is covered.
for (const need of ['wiki.space.create', 'wiki.page.create', 'wiki.page.read', 'wiki.revision.propose', 'wiki.revision.publish', 'wiki.revision.revert', 'wiki.citation.attach']) assert.ok(ids.includes(need), need);
for (const need of ['wiki.space.updated', 'wiki.revision.created', 'wiki.page.published', 'wiki.page.updated', 'wiki.page.deleted']) assert.ok(produced.has(need), need);
console.log('proposals ok');
