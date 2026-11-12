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
    htmlRawKB: 51, // 51 openvibe-shared v4.228.0 (2026-11-12: measured 50.9, raised by pin-bump from 50.5); 50.5 openvibe-shared v4.202.0 (2026-11-11: measured 50.5, raised by pin-bump from 50); 50: measured 49.6 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 48.2: measured 46.2 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    htmlBrotliKB: 11.5, // 11.5: measured 11.0-11.1 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 11: measured 10.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell adds web-runtime, 2026-10-04)
    jsRawKB: 394.5, // 2026-11-10: openvibe-shared 4.197.0 (the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 393: measured 392.5 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 376.7: measured 368.7 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 94: measured 93.7 KB brotli with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 2,   // 1
    cssRawKB: 58.5, // 58.5 openvibe-shared v4.228.0 (2026-11-12: measured 58.4, raised by pin-bump from 53.6); 53.6: measured 48.6 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 11.3, // 11.3: measured 10.1 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
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
