'use strict';
/**
 * A migrated database for one test run (ADR-035), from openvibe-sdk/testing: PGlite by default; with
 * WIKI_TEST_STORE=pg (npm run test:pg) the PostgreSQL + PgBouncer containers (openvibe-sdk scripts/test-services.sh
 * up), with roles and a schema of this run's own, shaped as OpenVibe.Host's roles/data/add-service.sh makes them.
 */
const { createTestDb, createTestValkey, pgAvailable, valkeyAvailable } = require('openvibe-sdk/testing');
const { MIGRATIONS } = require('../server/db');

const testDb = ({ store = process.env.WIKI_TEST_STORE || 'pglite', max = 4 } = {}) => createTestDb({ migrations: MIGRATIONS, store, service: 'wiki', max });
const testValkey = () => createTestValkey({ prefix: 'wiki' });

module.exports = { testDb, testValkey, pgAvailable, valkeyAvailable };
