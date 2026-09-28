'use strict';
/**
 * OpenVibe.Wiki entry point.
 *
 *   node server/index.js            (systemd: openvibe-wiki.service, port 4800)
 *
 * start() is also what the tests use: it takes a config (server/config.js load()) plus injectable
 * clock/fetch/log/keys, and returns handles to every part. Workers (scheduled publication, the
 * Events outbox relay, the Media attachment check) run only when asked (`workers: true`).
 */
const { load } = require('./config');
const { openDb, migrate, createStores } = require('./db');
const { createPlatform } = require('./integrations/platform');
const { createWikiService } = require('./wiki/service');
const { createKeyStore } = require('./auth/keys');
const { createViewerResolver } = require('./auth/viewer');
const { createApp } = require('./app');

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, tokens = null, publicKey = null, log = console, listen = true, workers = listen, rateLimits = true, limitsNow = null } = {}) {
    config = config || load();
    // PostgreSQL (ADR-035): migrate on the owner's direct connection, then serve on the pooled runtime role.
    // Tests hand in a migrated database of their own (test/db-helper.js).
    const db = givenDb || openDb(config, { log });
    if (!givenDb) await migrate(config, { serving: db, log });
    const stores = createStores(db, { now });
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null;
    const platform = createPlatform({ config, db, fetchImpl, tokens, now, log });
    const svc = createWikiService({ db, stores, outbox: platform.outbox, config, community: platform.community, vip: platform.vip, now, log });
    const reconciled = await svc.reconcileIndex();
    if (reconciled.sent) log.log(`[Wiki] re-sent ${reconciled.sent} Search document(s) whose indexability changed`);
    const keys = createKeyStore({ config, fetchImpl, log, publicKey });
    keys.ensure().catch(() => {});
    const viewers = createViewerResolver({ keys, config });
    const app = createApp({ config, svc, viewers, platform, keys, db, valkey, log, rateLimits, fetchImpl, limitsNow });

    const timers = [];
    if (workers) {
        let scheduling = false;
        timers.push(setInterval(async () => {
            if (scheduling) return;
            scheduling = true;
            try {
                const out = await svc.runSchedule();
                for (const j of out.failed) log.warn(`[Wiki] scheduled ${j.action} of ${j.entityId} r${j.revision} failed: ${j.lastError}`);
            } catch (err) { log.warn(`[Wiki] schedule worker: ${err.message}`); } finally { scheduling = false; }
        }, config.scheduleIntervalMs));
        if (platform.media.configured) {
            timers.push(setInterval(() => svc.verifyAllMedia(platform.media.resolve).catch((err) => log.warn(`[Wiki] media check: ${err.message}`)), config.mediaVerifyIntervalMs));
        }
        if (platform.eventsConfigured) platform.outbox.start();
        timers.push(setInterval(() => platform.outbox.refreshCounts().catch(() => {}), 30 * 1000));
        // wiki.projects on Network (Contracts 0.41.0): people whose spaces or roles changed, every minute.
        const projects = require('./integrations/projects-module').createProjectsModule({ db, config, tokens: platform.tokenClient, fetchImpl, now, log });
        if (projects.enabled) timers.push(setInterval(() => projects.drain().catch((err) => log.warn(`[Wiki] wiki.projects: ${err.message}`)), 60 * 1000));
        for (const t of timers) if (t.unref) t.unref();
    }

    let server = null;
    if (listen) {
        await new Promise((resolve) => { server = app.listen(config.port, config.host, resolve); });
        server.keepAliveTimeout = 65000;
        log.log(`[Wiki] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl}`);
    }

    async function stop() {
        for (const t of timers) clearInterval(t);
        await platform.outbox.stop();
        if (server) await new Promise((resolve) => server.close(resolve));
        if (!givenDb) await db.close();
        if (valkey) await valkey.close().catch(() => {});
    }
    return { app, db, svc, stores, platform, keys, viewers, server, config, stop };
}

module.exports = { start };

if (require.main === module) {
    require('dotenv').config();
    start().then((h) => {
        const shutdown = (signal) => {
            console.log(`[Wiki] ${signal} — closing`);
            h.stop().finally(() => process.exit(0));
            setTimeout(() => process.exit(0), 10000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }).catch((err) => {
        console.error('[Wiki] failed to start:', err);
        process.exit(1);
    });
}
