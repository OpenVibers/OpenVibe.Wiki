'use strict';
/**
 * Scheduled publication is idempotent across worker restarts: scheduling twice makes one job, a
 * worker that dies mid-job leaves the lease to expire and the next process finishes it, and
 * re-running a job that already took effect changes nothing (no second publication event, no new
 * index revision).
 */
const assert = require('assert');
const H = require('./helpers');

(async () => {
    let clock = Date.parse('2026-10-01T08:00:00Z');
    const now = () => clock;
    const h1 = await H.boot({ now });
    const dbPath = h1.dbPath;
    const editor = { kind: 'user', subject: H.subject(), staff: false };
    const space = h1.svc.createSpace({ name: 'Diary', slug: 'diary' }, editor);
    const { page } = h1.svc.createPage(space.id, { title: 'Launch notes', body: H.LONG, citations: [{ url: 'https://example.org/x', retrievedAt: '2026-09-30T00:00:00Z' }] }, editor);
    const runAt = '2026-10-01T09:00:00Z';

    const a = h1.svc.schedulePublish(page.id, { revision: 1, runAt }, editor);
    const b = h1.svc.schedulePublish(page.id, { revision: 1, runAt }, editor);
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false, 'the same schedule twice is one job');
    assert.strictEqual(a.job.id, b.job.id);
    assert.strictEqual(h1.svc.pageById(page.id).state, 'scheduled');
    assert.strictEqual((await H.req(h1, 'GET', '/w/diary/launch-notes')).status, 404, 'scheduled is not public yet');

    // Not due yet: nothing happens.
    let out = await h1.svc.runSchedule({ worker: 'w1' });
    assert.strictEqual(out.done.length, 0);

    // Due: worker w1 claims it and "crashes" before completing (lease taken, never completed).
    clock = Date.parse('2026-10-01T09:00:01Z');
    const claimed = h1.stores.scheduler.claim({ worker: 'w1' });
    assert.strictEqual(claimed.length, 1);
    await h1.stop();

    // A new process on the same database. Inside the lease nothing runs twice.
    const h2 = await H.boot({ now, dbPath });
    out = await h2.svc.runSchedule({ worker: 'w2' });
    assert.strictEqual(out.done.length, 0, 'the lease still belongs to w1');
    // After the lease expires the new worker publishes.
    clock += 61000;
    out = await h2.svc.runSchedule({ worker: 'w2' });
    assert.strictEqual(out.done.length, 1);
    assert.deepStrictEqual(out.done[0].result, { published: 1 });
    let p = h2.svc.pageById(page.id);
    assert.strictEqual(p.state, 'published');
    assert.strictEqual(p.published_revision, 1);
    assert.strictEqual(p.published_at, clock);
    const publishedAt = p.published_at;
    assert.strictEqual((await H.req(h2, 'GET', '/w/diary/launch-notes')).status, 200);

    const count = (h) => {
        const all = H.outbox(h).filter((e) => e.subject.id === page.id);
        return { published: all.filter((e) => e.event_type === 'wiki.page.published').length, index: all.filter((e) => e.event_type === 'wiki.index_document.upserted').length };
    };
    const once = count(h2);
    assert.deepStrictEqual(once, { published: 1, index: 1 });

    // Re-running the same job (a replay after a crash between publish and complete) is a no-op.
    const replay = await h2.stores.scheduler.runDue({ worker: 'w3', handler: async () => ({}) }); // nothing due any more
    assert.strictEqual(replay.done.length, 0);
    h2.stores.scheduler.schedule({ entityId: page.id, action: 'publish', runAt, revision: 1, key: 'replay-of-the-same-job' });
    clock += 1000;
    out = await h2.svc.runSchedule({ worker: 'w3' });
    assert.deepStrictEqual(out.done[0].result, { noop: true });
    assert.deepStrictEqual(count(h2), once, 'no second publication event and no new index revision');
    p = h2.svc.pageById(page.id);
    assert.strictEqual(p.published_at, publishedAt, 'the first publication time is kept');
    await h2.stop();

    // A third restart: still exactly one publication.
    const h3 = await H.boot({ now, dbPath });
    out = await h3.svc.runSchedule({ worker: 'w4' });
    assert.strictEqual(out.done.length, 0);
    assert.deepStrictEqual(count(h3), once);
    // Deleting a page cancels its pending jobs.
    h3.svc.schedulePublish(page.id, { revision: 1, runAt: '2026-12-01T00:00:00Z' }, editor);
    h3.svc.deletePage(page.id, { kind: 'user', subject: editor.subject });
    assert.ok(h3.svc.jobs(page.id).filter((j) => j.status === 'pending').length === 0);
    await h3.stop();
    console.log('schedule ok');
})().catch((err) => { console.error(err); process.exit(1); });
