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
const { createIndexNow } = require('openvibe-shared/indexnow');
const { gracefulStop } = require('openvibe-sdk/service');
const { load } = require('./config');
const { openDb, migrate, createStores } = require('./db');
const { createPlatform } = require('./integrations/platform');
const { createWikiService } = require('./wiki/service');
const { createKeyStore } = require('./auth/keys');
const { createViewerResolver } = require('./auth/viewer');
const { createApp } = require('./app');
const accountDataLib = require('./wiki/account-data');
const { createNetworkSender, startSubscriptions } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service, plan T1): the job timers and the Events outbox relay stop taking new
 * work, then the HTTP server drains (in-flight requests get 8 s), then the database and Valkey close — today's
 * order. Past the 10 s deadline the process exits 0, as the hand-rolled timer did. `closeDb` is false when a
 * test handed in its own database (start's `givenDb`), which stays open. `exit` and `signals` are injectable
 * so a test can watch the stop and no test process installs signal handlers.
 */
function createLifecycle({ server, db, valkey = null, platform, timers = [], closeDb = true, exit, signals, log, extra = [] } = {}) {
    return gracefulStop({
        name: 'Wiki', server, log, drainMs: 8000, deadlineMs: 10000, deadlineExitCode: 0, exit, signals,
        stop: [
            () => timers.forEach(clearInterval),
            () => platform.outbox.stop(),
            ...extra,
        ],
        close: [
            () => { if (closeDb) return db.close(); },
            () => { if (valkey) return valkey.close(); },
        ],
    });
}

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, tokens = null, publicKey = null, log = console, listen = true, workers = listen, rateLimits = true, limitsNow = null, indexnow: givenIndexNow = null, signals = false, exit = () => {}, accountSend: givenSend = null } = {}) {
    config = config || load();
    // PostgreSQL (ADR-035): migrate on the owner's direct connection, then serve on the pooled runtime role.
    // Tests hand in a migrated database of their own (test/db-helper.js).
    const db = givenDb || openDb(config, { log });
    if (!givenDb) await migrate(config, { serving: db, log });
    const stores = createStores(db, { now });
    // IndexNow (openvibe-shared/indexnow): created once at boot from INDEXNOW_KEY. Unset → off, nothing
    // mounted and nothing sent; a test or a drill injects its own (a spy, or the module's own no-key
    // state) through `indexnow`, and the outbound POST goes through `fetchImpl`, this process's stub.
    // A set-but-invalid key (the module refuses anything but 8–128 hex/alnum) is a configuration
    // mistake, not a reason to leave the wiki down: warn and run with IndexNow off, exactly as unset.
    let indexnow = givenIndexNow;
    if (!indexnow) {
        const logIndexNow = (...a) => (log.warn || console.warn)(...a);
        try {
            indexnow = createIndexNow({ host: config.baseUrl, key: config.indexnow.key, fetch: fetchImpl, log: logIndexNow });
        } catch (err) {
            logIndexNow(`[Wiki] ${err.message} — IndexNow is off until INDEXNOW_KEY is fixed`);
            indexnow = createIndexNow({ host: config.baseUrl, key: '', fetch: fetchImpl, log: logIndexNow });
        }
    }
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null;
    const platform = createPlatform({ config, db, fetchImpl, tokens, now, log });
    const svc = createWikiService({ db, stores, outbox: platform.outbox, config, community: platform.community, vip: platform.vip, now, log, indexnow });
    const reconciled = await svc.reconcileIndex();
    if (reconciled.sent) log.log(`[Wiki] re-sent ${reconciled.sent} Search document(s) whose indexability changed`);
    const keys = createKeyStore({ config, fetchImpl, log, publicKey });
    keys.ensure().catch(() => {});
    const viewers = createViewerResolver({ keys, config });
    // Account export and deletion (ADR-033): the table map over the service, and the sender to Network's internal routes
    // with Wiki's own client-credentials token (a test hands in a stand-in).
    const accountData = accountDataLib.create({ db, svc, log });
    const accountSend = givenSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : null);
    const app = createApp({ config, svc, viewers, platform, keys, db, valkey, log, rateLimits, fetchImpl, limitsNow, indexnow, accountData, accountSend });

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
    let subscriptions = null;
    if (listen) {
        await new Promise((resolve) => { server = app.listen(config.port, config.host, resolve); });
        server.keepAliveTimeout = 65000;
        log.log(`[Wiki] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl}`);
        // The two account subscriptions at OpenVibe.Events, created when missing; off without EVENTS_URL,
        // WIKI_EVENTS_SECRET or the client secret.
        subscriptions = startSubscriptions({
            eventsUrl: config.eventsUrl, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: (config.eventsSecrets || [])[0],
            networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl, log,
        });
    }

    const lifecycle = createLifecycle({ server, db, valkey, platform, timers, closeDb: !givenDb, signals, exit, log, extra: [() => { if (subscriptions) subscriptions.stop(); }] });

    async function stop() {
        return lifecycle.stop('stop');
    }
    return { app, db, svc, stores, platform, keys, viewers, server, config, indexnow, timers, lifecycle, stop };
}

module.exports = { start, createLifecycle };

if (require.main === module) {
    require('dotenv').config();
    start({ signals: true, exit: (code) => process.exit(code) }).catch((err) => {
        console.error('[Wiki] failed to start:', err);
        process.exit(1);
    });
}
