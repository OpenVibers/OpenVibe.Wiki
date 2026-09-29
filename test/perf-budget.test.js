'use strict';
// Size budgets for openvibe.wiki's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the server as
// it runs (a fresh database), measured without a browser. Budgets sit a little above the 2026-09-26
// measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

const BUDGETS = {
    htmlRawKB: 22,   // measured 17.3 (fresh database)
    htmlBrotliKB: 5.5,   // 4.4
    jsFiles: 4,   // 3
    jsRawKB: 230,   // 197.7
    jsBrotliKB: 53,   // 45.6
    cssFiles: 2,   // 1
    cssRawKB: 7,   // 5.5
    cssBrotliKB: 2,   // 1.5
    externalFiles: 1,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A fresh PGlite database of this run's own in a temp dir (server/db.js WIKI_PGLITE_DIR), never the shared
    // data/pglite the dev server uses. DATABASE_URL/DATABASE_DIRECT_URL are cleared too, so an inherited one
    // cannot point the child at a database other runs are using.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-wiki-budget-'));
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            WIKI_PGLITE_DIR: path.join(dir, 'pglite'), DATABASE_URL: '', DATABASE_DIRECT_URL: '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    // Registered at spawn: a server that already crashed has exited before the finally below, and waiting on
    // once('exit') then would never resolve (an unref'd timer does not hold the loop, so the test would end as a pass).
    const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        // The server bounds its own shutdown at 10 s; wait for the real exit before removing its database.
        let timer;
        await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 12000); })]);
        clearTimeout(timer);
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
