#!/usr/bin/env node
'use strict';
/**
 * Import the official "OpenVibe" space (seeds/openvibe.json) into Wiki's database.
 *
 *   npm run seed                      # create + publish (idempotent: existing pages are left alone)
 *   npm run seed -- --draft           # create as drafts, publish later from the page settings
 *   npm run seed -- --file other.json
 *
 * Uses DATABASE_URL (and DATABASE_DIRECT_URL to migrate) like the server. Events for the new pages go to the outbox and are delivered
 * by the server's relay (EVENTS_URL) the next time it runs.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { load } = require('../server/config');
const { openDb, migrate, createStores } = require('../server/db');
const { createPlatform } = require('../server/integrations/platform');
const { createWikiService } = require('../server/wiki/service');
const { seed } = require('../server/wiki/seed');

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const file = fileArg >= 0 ? args[fileArg + 1] : path.join(__dirname, '..', 'seeds', 'openvibe.json');
const config = load();
(async () => {
    const db = openDb(config);
    await migrate(config, { serving: db });
    const stores = createStores(db);
    const platform = createPlatform({ config, db });
    const svc = createWikiService({ db, stores, outbox: platform.outbox, config });
    const out = await seed(svc, JSON.parse(fs.readFileSync(file, 'utf8')), { publish: !args.includes('--draft') });
    console.log(`[seed] space ${out.space.slug}: ${out.created.length} created, ${out.skipped.length} already there; ${await platform.outbox.pending()} event(s) waiting in the outbox`);
    await db.close();
})().catch((err) => { console.error(`[seed] ${err.message}`); process.exit(1); });
