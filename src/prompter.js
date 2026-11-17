// open-loom runtime: script page and stage window (?stage=1).
// Config comes from build.py as window.OPEN_LOOM = {title, slug, demo, segments}.
(() => {
const CFG = window.OPEN_LOOM, SEGS = CFG.segments;
const $ = x => document.getElementById(x), inner = $('inner'), stage = $('stage');
const STAGE = new URLSearchParams(location.search).has('stage');

// scale the 1280x720 stage to its box
function fit() { inner.style.transform = `scale(${stage.clientWidth / 1280})`; }
addEventListener('resize', fit);
if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);

// views the markup does not contain: camera placeholder, and the live demo iframe if any segment needs it
const camView = document.createElement('section');
camView.className = 'view camv'; camView.id = 'v-cam';
camView.innerHTML = '<b>ON CAMERA</b><span>Look into the lens</span>';
inner.appendChild(camView);
let scr = null;
if (SEGS.some(s => s.view === 'screen')) {
  scr = document.createElement('section');
  scr.className = 'view scr'; scr.id = 'v-scr';
  const ifr = document.createElement('iframe');
  ifr.id = 'demo'; ifr.src = CFG.demo;
  // same-origin demo: keys pressed after clicking into the demo still drive the script (cross-origin cannot be reached)
  ifr.addEventListener('load', () => { try { ifr.contentWindow.addEventListener('keydown', onKey); } catch (e) {} });
  scr.appendChild(ifr); inner.appendChild(scr);
}
const viewId = s => s.view === 'slide' ? 'v-' + s.id : s.view === 'camera' ? 'v-cam' : 'v-scr';

// click steps per segment: one per distinct reveal position (fraction of the text)
SEGS.forEach(s => {
  const fs = new Set();
  if (s.view === 'slide') $(viewId(s)).querySelectorAll('.rv[data-at]').forEach(r => { if (isFinite(+r.dataset.f)) fs.add(+r.dataset.f); });
  s.steps = [...fs].sort((a, b) => a - b);
});

let cur = 0, step = 0, camFull = null, applying = false;
const cv = $('camvid');

async function camOn() {
  try {
    const st = await navigator.mediaDevices.getUserMedia({video: {width: 1280, height: 720}, audio: false});
    cv.srcObject = st; cv.classList.add('on'); $('camb').textContent = 'Camera on'; applying = true; render(); applying = false;
  } catch (e) { $('camb').textContent = 'Camera blocked: allow camera access for this page'; }
}
$('camb').onclick = e => { e.target.blur(); camOn(); };

const bc = new BroadcastChannel('open-loom-' + CFG.slug);
bc.onmessage = e => {
  const m = e.data;
  if (m.key) { dispatchEvent(new KeyboardEvent('keydown', {key: m.key, bubbles: true})); return; }
  if (m.state) { applying = true; cur = m.state.cur; step = m.state.step; camFull = m.state.camFull; render(); applying = false; }
  if (m.hello && !STAGE) render();   // a stage window just opened: send it the current state
};

const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function render() {
  const s = SEGS[cur], th = step === 0 ? -1 : s.steps[step - 1];
  document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
  const v = $(viewId(s)); v.classList.add('on');
  v.querySelectorAll('.rv[data-at]').forEach(r => { if (isFinite(+r.dataset.f)) r.classList.toggle('hide', +r.dataset.f > th + 1e-9); });
  // script text with a click marker before every reveal phrase
  const txt = s.say;
  const marks = s.steps.map((f, i) => ({p: Math.round(f * txt.length), i})).sort((a, b) => b.p - a.p);
  const parts = []; let last = txt.length;
  marks.forEach(m => {
    parts.unshift(esc(txt.slice(m.p, last)));
    parts.unshift(`<span class="mk ${m.i < step ? 'done' : m.i === step ? 'next' : ''}">▸${m.i + 1}</span>`);
    last = m.p;
  });
  parts.unshift(esc(txt.slice(0, last)));
  $('say').innerHTML = parts.join('');
  const sl = document.querySelector('.sl'), nm = document.querySelector('#say .mk.next') || [...document.querySelectorAll('#say .mk.done')].pop();
  sl.scrollTop = (step === 0 || !nm) ? 0 : Math.max(0, nm.offsetTop - sl.offsetTop - 60);
  // webcam: full frame on camera segments, bubble elsewhere (V toggles)
  const full = camFull === null ? s.view === 'camera' : camFull;
  cv.classList.toggle('full', full); cv.classList.toggle('bub', !full);
  const cue = s.view === 'screen' && s.cue ? s.cue : '';
  $('cue').style.display = cue ? 'block' : 'none'; $('cue').textContent = cue ? 'In the demo: ' + cue : '';
  $('ttl').textContent = (cur + 1) + '. ' + s.title;
  $('vw').textContent = s.view === 'camera' ? 'camera, full frame' : s.view;
  $('pos').textContent = `segment ${cur + 1}/${SEGS.length} · click ${step}/${s.steps.length}`;
  const nx = SEGS[cur + 1];
  $('nexts').textContent = nx ? `Next: ${cur + 2}. ${nx.title} (${nx.view})` : 'Last segment';
  if (!applying) bc.postMessage({state: {cur, step, camFull}});
}
function fwd() {
  camFull = null; const s = SEGS[cur];
  if (step < s.steps.length) step++; else if (cur < SEGS.length - 1) { cur++; step = 0; }
  render();
}
function back() {
  camFull = null;
  if (step > 0) step--; else if (cur > 0) { cur--; step = SEGS[cur].steps.length; }
  render();
}
$('nx').onclick = e => { e.target.blur(); fwd(); };
$('bk').onclick = e => { e.target.blur(); back(); };
// blur and mirror toggles run in both windows: the key is broadcast, then applied here too
const sendKey = k => { bc.postMessage({key: k}); dispatchEvent(new KeyboardEvent('keydown', {key: k})); };
$('blurb').onclick = e => { e.target.blur(); sendKey('b'); };
function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && t.closest && t.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]')) return;   // typing in the demo
  if (e.isTrusted && ['b', 'B', 'm', 'M'].includes(e.key)) bc.postMessage({key: e.key});   // blur and mirror: both windows
  if (['ArrowRight', ' ', 'PageDown', 'ArrowDown'].includes(e.key)) { e.preventDefault(); fwd(); }
  else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); back(); }
  else if (e.key === 'v' || e.key === 'V') { const s = SEGS[cur]; camFull = !(camFull === null ? s.view === 'camera' : camFull); render(); }
  else if (e.key === 'Home') { cur = 0; step = 0; camFull = null; render(); }
}
addEventListener('keydown', onKey);
$('stageb').onclick = e => { e.target.blur(); window.open(location.pathname + '?stage=1', 'open-loom-stage-' + CFG.slug, 'width=1280,height=760'); };

// test hooks
window.__openloom = {
  get cur() { return cur; }, get step() { return step; }, get steps() { return SEGS[cur].steps.length; },
  next: fwd, back,
};

fit();
if (STAGE) {
  document.body.classList.add('stagemode'); document.title = '[stage] record this window'; fit();
  applying = true; render(); applying = false;   // follower: do not overwrite the script page with its initial state
  camOn(); bc.postMessage({hello: 1});
} else render();
})();
