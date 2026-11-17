// End-to-end test: builds the example, serves it, and drives it in headless Chromium with a fake webcam.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = path.join(ROOT, 'examples', 'hello');
const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.error('FAIL: ' + msg); } else console.log('ok:   ' + msg); };

const build = spawnSync('python3', [path.join(ROOT, 'build.py'), PROJECT], { stdio: 'inherit' });
if (build.status !== 0) { console.error('build failed'); process.exit(1); }

const port = await new Promise((res, rej) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const server = spawn('python3', ['-m', 'http.server', String(port), '-b', '127.0.0.1', '-d', path.join(PROJECT, 'dist')], { stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { await fetch(base + '/prompter.html'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
  const errors = [];
  const watch = (page, label) => {
    page.on('pageerror', e => errors.push(`${label} pageerror: ${e.message}`));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      // blocked or offline CDN fetches for the optional webcam effects only log "Failed to load resource"
      if (/Failed to load resource/.test(m.text()) && !(m.location().url || '').startsWith(base)) return;
      errors.push(`${label} console: ${m.text()}`);
    });
    page.on('response', r => { if (r.url().startsWith(base) && r.status() >= 400) errors.push(`${label} HTTP ${r.status()} ${r.url()}`); });
  };

  const page = await ctx.newPage();
  watch(page, 'script');
  await page.goto(base + '/prompter.html');
  const segs = await page.evaluate(() => window.OPEN_LOOM.segments.map(s => ({ id: s.id, view: s.view })));
  const viewOf = s => s.view === 'slide' ? 'v-' + s.id : s.view === 'camera' ? 'v-cam' : 'v-scr';
  const state = p => p.evaluate(() => ({ cur: __openloom.cur, step: __openloom.step, steps: __openloom.steps, on: [...document.querySelectorAll('.view.on')].map(v => v.id) }));

  // camera on, wait for the effects layer, screenshot of the slide segment
  await page.click('#camb');
  await page.waitForFunction(() => document.getElementById('camvid').srcObject, null, { timeout: 10000 });
  check(await page.evaluate(() => !!document.getElementById('camvid').srcObject), '#camvid has a srcObject after clicking the camera button');
  let fx = 'timeout';
  try {
    await page.waitForFunction(() => ['ready', 'failed'].includes(window.__camfx), null, { timeout: 25000 });
    fx = await page.evaluate(() => window.__camfx);
  } catch {}
  check(fx === 'ready' || fx === 'failed', `window.__camfx settled (${fx})`);
  await page.waitForTimeout(1500);
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  for (let k = await page.evaluate(() => __openloom.steps); k > 0; k--) await page.keyboard.press('ArrowRight');   // all reveals visible
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot.png') });
  await page.keyboard.press('Home');

  // stage window follows the script page
  const stage = await ctx.newPage();
  watch(stage, 'stage');
  await stage.goto(base + '/prompter.html?stage=1');
  await stage.waitForFunction(() => document.body.classList.contains('stagemode'));
  await page.bringToFront();
  await page.keyboard.press('ArrowRight');
  await stage.waitForFunction(() => __openloom.step === 1, null, { timeout: 5000 }).catch(() => {});
  const ss = await state(stage);
  check(ss.cur === 0 && ss.step === 1, `stage window follows ArrowRight (cur=${ss.cur} step=${ss.step})`);
  await page.keyboard.press('Home');

  // walk through every step of every segment
  let guard = 0;
  for (let i = 0; i < segs.length; i++) {
    let st = await state(page);
    check(st.cur === i && st.on.length === 1 && st.on[0] === viewOf(segs[i]), `segment ${i} (${segs[i].id}) shows ${viewOf(segs[i])} (got ${st.on})`);
    for (let k = 0; k < st.steps; k++) {
      await page.keyboard.press('ArrowRight');
      const s2 = await state(page);
      check(s2.cur === i && s2.step === k + 1, `segment ${i} step ${k + 1}/${st.steps}`);
      if (++guard > 100) throw new Error('step loop runaway');
    }
    if (i < segs.length - 1) await page.keyboard.press('ArrowRight');
  }
  const last = await state(page);
  check(last.cur === segs.length - 1 && last.step === last.steps, 'reached the last step of the last segment');
  await page.keyboard.press('ArrowRight');
  check((await state(page)).cur === segs.length - 1, 'ArrowRight at the end stays on the last segment');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Home');
  check((await state(page)).cur === 0, 'Home returns to the first segment');

  // Blur button goes through the same broadcast as the B key: both windows stay in sync
  await page.click('#blurb');
  await stage.waitForFunction(() => document.getElementById('blurb').textContent === 'Blur: off', null, { timeout: 3000 }).catch(() => {});
  check(await page.evaluate(() => document.getElementById('blurb').textContent) === 'Blur: off'
    && await stage.evaluate(() => document.getElementById('blurb').textContent) === 'Blur: off', 'Blur button toggles both windows');
  await page.keyboard.press('b');
  await stage.waitForFunction(() => document.getElementById('blurb').textContent === 'Blur: on', null, { timeout: 3000 }).catch(() => {});
  check(await page.evaluate(() => document.getElementById('blurb').textContent) === 'Blur: on'
    && await stage.evaluate(() => document.getElementById('blurb').textContent) === 'Blur: on', 'B key after the button toggles both windows back');
  // keys keep working after clicking into the same-origin demo iframe
  await page.keyboard.press('Home');
  for (let i = 0; i < 20 && segs[(await state(page)).cur].view !== 'screen'; i++) await page.keyboard.press('ArrowRight');
  const before = await state(page);
  await page.frameLocator('#demo').locator('nav button').nth(1).click();
  await page.keyboard.press('ArrowRight');
  const after = await state(page);
  check(after.cur !== before.cur || after.step !== before.step, `ArrowRight after clicking inside the demo advances (${before.cur}/${before.step} -> ${after.cur}/${after.step})`);
  await page.keyboard.press('Home');

  check(errors.length === 0, 'no console or page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  failures.push('exception: ' + (e && e.stack || e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  server.kill();
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nall e2e checks passed');
