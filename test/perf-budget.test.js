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
    htmlRawKB: 44,   // 43.3 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 42.9 with the phone pick blocks (2026-10-30); 41.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 37 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 31.5 on 2026-10-22: the home's how-it-works steps, questions (and their FAQPage JSON-LD), links around the site and closing call; 24.9 (fresh database; 2026-09-29 the showcase hero and features with six inline ring icons)
    htmlBrotliKB: 10.3,   // 10.1 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 8.8 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 7.7 (2026-10-22 the richer home); 6.3
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell adds web-runtime, 2026-10-04)
    jsRawKB: 331,   // 328.2 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 324.8 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 323.2 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 321.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 318.1 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 315.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 307.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 300.5 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 293 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 263.4 with shared 4.11.0's seasonal navbar; 254.1 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 246.2 with openvibe-shared 4.2.x (Ask Actor in the navbar, 2026-10-15); 239.1 (197.7 before openvibe-shared/shell's web-runtime.js)
    jsBrotliKB: 80.8,   // 80.2 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 79.5 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 78.2 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 59.1 with openvibe-shared 4.4.0 (every site in the launcher, 2026-10-17); 56.3 (45.6 before web-runtime.js)
    cssFiles: 2,   // 1
    cssRawKB: 48,   // 47.1 with 2026-11-01: openvibe-shared 4.86.0 (2026-11-01); 46.1 with the phone pick and fold rules (2026-10-30); 42.9 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 41.1 touch targets on phones (2026-10-29); 36.2 openvibe-shared 4.26.1 (hero visual); 30.7 with Shared 4.13.0 (2026-10-26: account links); 23.5 on 2026-10-22 (the home's numbers, shelves by site group, ranked pages, questions and links); 19.1 (wiki.css + the cached /shared/showcase.css; 2026-10-15 the home's space cards, shelf and recent list)
    cssBrotliKB: 10,   // 9.7 with the phone pick and fold rules (2026-10-30); 9.1 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 8.6 the home's phone rows and fold (2026-10-29); 6.6–6.7 with Shared 4.13.0; raised from 8 for openvibe-shared v4.39.0 (+1.5 KB raw of kit/room/showcase CSS); measured 8.3
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
