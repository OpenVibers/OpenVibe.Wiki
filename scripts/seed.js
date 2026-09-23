#!/usr/bin/env node
'use strict';
/**
 * Import the official "OpenVibe" space (seeds/openvibe.json) into Wiki's database.
 *
 *   npm run seed                      # create + publish (idempotent: existing pages are left alone)
 *   npm run seed -- --draft           # create as drafts, publish later from the page settings
 *   npm run seed -- --file other.json
 *
 * Uses WIKI_DB_PATH like the server. Events for the new pages go to the outbox and are delivered
 * by the server's relay (EVENTS_URL) the next time it runs.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { load } = require('../server/config');
const { openDb, createStores } = require('../server/db');
const { createPlatform } = require('../server/integrations/platform');
const { createWikiService } = require('../server/wiki/service');
const { seed } = require('../server/wiki/seed');

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const file = fileArg >= 0 ? args[fileArg + 1] : path.join(__dirname, '..', 'seeds', 'openvibe.json');
const config = load();
const db = openDb(config.dbPath);
const stores = createStores(db);
const platform = createPlatform({ config, db });
const svc = createWikiService({ db, stores, outbox: platform.outbox, config });
const out = seed(svc, JSON.parse(fs.readFileSync(file, 'utf8')), { publish: !args.includes('--draft') });
console.log(`[seed] space ${out.space.slug}: ${out.created.length} created, ${out.skipped.length} already there; ${platform.outbox.pending()} event(s) waiting in the outbox`);
db.close();
