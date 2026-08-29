// Automated accessibility audit: boots the production build against a fresh
// seeded database, drives a real Chromium through the four primary screens
// (plus the lineage panel state), injects axe-core, and fails on any
// WCAG 2.0/2.1 A or AA violation. Run with: npm run test:a11y
// (requires `npm run build` first and a Playwright Chromium — see README).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const PORT = 5606;
const BASE = `http://localhost:${PORT}`;

if (!fs.existsSync(path.resolve('client/dist/index.html'))) {
  console.error('client/dist not found — run `npm run build` first.');
  process.exit(1);
}

const tmpDb = path.join(os.tmpdir(), `quarry-a11y-${Date.now()}.db`);
const server = spawn('npx', ['tsx', 'server/index.ts'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), QUARRY_DB: tmpDb },
  stdio: 'pipe',
});
server.stderr.on('data', (d) => process.stderr.write(d));

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/meta`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not become ready');
};

let failed = false;
try {
  await waitForServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const freshRes = await fetch(`${BASE}/api/issues?q=handshake+timeouts+reconnect+storms&limit=1`);
  const freshKey = (await freshRes.json()).issues[0]?.key ?? 'RELAY-1';

  const targets = [
    { name: 'Triage', path: '/' },
    { name: 'Board', path: '/board' },
    { name: `Issue (${freshKey})`, path: `/issue/${freshKey}`, prep: async () => {
        const btn = page.getByRole('button', { name: 'Scan ancestry' });
        if (await btn.count()) {
          await btn.click();
          await page.waitForTimeout(1600);
        }
      } },
    { name: 'Analytics', path: '/analytics' },
    { name: 'Products', path: '/products' },
  ];

  for (const t of targets) {
    await page.goto(BASE + t.path, { waitUntil: 'load' });
    await page.waitForTimeout(900);
    if (t.prep) await t.prep();
    await page.evaluate(axeSource);
    const result = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      return await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
    });
    if (result.violations.length === 0) {
      console.log(`✔ ${t.name}: 0 violations (${result.passes.length} rules passed)`);
    } else {
      failed = true;
      console.error(`✖ ${t.name}: ${result.violations.length} violation(s)`);
      for (const v of result.violations) {
        console.error(`   [${v.impact}] ${v.id}: ${v.help}`);
        for (const n of v.nodes.slice(0, 4)) console.error(`      ${n.target.join(' ')}`);
      }
    }
  }
  await browser.close();
} catch (err) {
  failed = true;
  console.error('a11y run failed:', err);
} finally {
  server.kill();
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(tmpDb + s)) fs.rmSync(tmpDb + s);
}

process.exit(failed ? 1 : 0);
