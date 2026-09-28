#!/usr/bin/env node
'use strict';
/**
 * The one-time move of Wiki's SQLite database (WIKI_DB_PATH) into its PostgreSQL schema (ADR-035; the procedure
 * is openvibe-sdk docs/migrating-to-postgresql.md, section 6, carried out by openvibe-sdk/db runSqliteMigration).
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json]
 *
 * Applies migrations/ as the owner (DATABASE_DIRECT_URL), copies every table into emptied tables, verifies row
 * counts and checksums, and exits 1 unless everything verified. The SQLite file is opened read-only. In
 * production it runs once, from the new release's directory, as the service user with the service's
 * environment, while the service is stopped (the write freeze), before the PostgreSQL release starts.
 *
 * Every table keeps its name and columns. What the SQLite file holds that PostgreSQL does not take:
 *   the SDK's SQLite outbox bookkeeping becomes the PostgreSQL outbox's (wiki_event_outbox: same rows; lease
 *   columns start empty), and SQLite's own tables (sqlite_sequence) are not copied.
 */
require('dotenv').config();
const { runSqliteMigration } = require('openvibe-sdk/db');
const { load } = require('../server/config');
const { MIGRATIONS } = require('../server/db');

const TABLES = {};

if (require.main === module) {
    const config = load();
    runSqliteMigration({ service: 'wiki', sqlite: config.dbPath, directUrl: config.db.directUrl, migrations: MIGRATIONS, tables: TABLES })
        .then((code) => process.exit(code), (err) => { console.error(`migrate-to-postgres failed: ${err.message}`); process.exit(1); });
}

module.exports = { TABLES };
