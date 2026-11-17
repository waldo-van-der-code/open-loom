// Headed check of the tab-capture mirror (needs a desktop; not part of test:e2e).
// The stage window must mirror the script page's demo iframe, not the stage itself.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SCRIPT_TITLE = 'open-loom demo [script]';
let browser;
try {
  browser = await chromium.launch({ headless: false, args: [
    '--window-position=-2400,0', '--window-size=1280,800',   // off-screen so the headed windows do not cover the desktop
    '--use-fake-device-for-media-stream',   // no --use-fake-ui-for-media-stream: it would make getDisplayMedia capture the stage itself
    '--auto-select-tab-capture-source-by-title=' + SCRIPT_TITLE, '--enable-usermedia-screen-capturing',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(base + '/prompter.html');
  check(await page.title() === SCRIPT_TITLE, 'script page title is ' + SCRIPT_TITLE);
  for (let i = 0; i < 12; i++) {   // advance to the screen segment
    if (await page.evaluate(() => document.querySelector('.view.on')?.id) === 'v-scr') break;
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150);
  }
  const [stage] = await Promise.all([page.waitForEvent('popup'), page.click('#stageb')]);
  stage.on('pageerror', e => errs.push('stage: ' + e));
  await stage.waitForLoadState();
  await stage.waitForFunction(() => document.querySelector('.view.on')?.id === 'v-scr', null, { timeout: 8000 });
  check(!(await stage.title()).includes(SCRIPT_TITLE), 'stage title does not contain the script title (' + await stage.title() + ')');
  await stage.waitForSelector('#mirb', { state: 'visible' });
  await stage.click('#mirb');
  await stage.waitForFunction(() => window.__mirror === 'on', null, { timeout: 10000 }).catch(() => {});
  check(await stage.evaluate(() => window.__mirror) === 'on', 'mirror is on');
  await page.bringToFront();   // keep the captured script tab in front so it keeps painting
  await stage.waitForTimeout(2500);
  // the mirrored canvas, centre region: luminance stats
  const stats = await stage.evaluate(() => {
    const c = document.getElementById('mirc');
    if (!c || !c.width) return null;
    const x0 = Math.round(c.width * 0.25), y0 = Math.round(c.height * 0.25), w = Math.round(c.width / 2), h = Math.round(c.height / 2);
    const d = c.getContext('2d').getImageData(x0, y0, w, h).data;
    let light = 0, n = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { n++; r += d[i]; g += d[i + 1]; b += d[i + 2]; if (d[i] + d[i + 1] + d[i + 2] > 600) light++; }
    return { w: c.width, h: c.height, light: light / n, avg: [r / n, g / n, b / n] };
  });
  check(!!stats, 'mirror canvas has content');
  if (stats) {
    console.log('mirror centre stats:', JSON.stringify(stats));
    check(stats.light > 0.5, `centre region is mostly light like demo.html (${(stats.light * 100).toFixed(0)}% light; the stage's own frame is black)`);
    // compare with a screenshot of the demo iframe on the script page
    const shot = (await page.locator('#demo').screenshot()).toString('base64');
    const ref = await stage.evaluate(async b64 => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
      const x = t.getContext('2d'); x.drawImage(img, 0, 0);
      const w = Math.round(img.width / 2), h = Math.round(img.height / 2);
      const d = x.getImageData(Math.round(img.width / 4), Math.round(img.height / 4), w, h).data;
      let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { n++; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      return [r / n, g / n, b / n];
    }, shot);
    const diff = Math.max(...ref.map((v, i) => Math.abs(v - stats.avg[i])));
    check(diff < 40, `mirrored centre colour matches the demo iframe (max channel diff ${diff.toFixed(1)})`);
  }
  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
  failures.push('exception: ' + (e && e.stack || e)); console.error(e);
} finally {
  if (browser) await browser.close();
  server.kill();
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nmirror check passed');
