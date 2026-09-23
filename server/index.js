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
const { openDb, createStores } = require('./db');
const { createPlatform } = require('./integrations/platform');
const { createWikiService } = require('./wiki/service');
const { createKeyStore } = require('./auth/keys');
const { createViewerResolver } = require('./auth/viewer');
const { createApp } = require('./app');

async function start({ config, now = () => Date.now(), fetchImpl = globalThis.fetch, tokens = null, publicKey = null, log = console, listen = true, workers = listen, rateLimits = true } = {}) {
    config = config || load();
    const db = openDb(config.dbPath);
    const stores = createStores(db, { now });
    const platform = createPlatform({ config, db, fetchImpl, tokens, now, log });
    const svc = createWikiService({ db, stores, outbox: platform.outbox, config, community: platform.community, now, log });
    const reconciled = svc.reconcileIndex();
    if (reconciled.sent) log.log(`[Wiki] re-sent ${reconciled.sent} Search document(s) whose indexability changed`);
    const keys = createKeyStore({ config, fetchImpl, log, publicKey });
    keys.ensure().catch(() => {});
    const viewers = createViewerResolver({ keys, config });
    const app = createApp({ config, svc, viewers, platform, keys, db, log, rateLimits, fetchImpl });

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
        db.close();
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
