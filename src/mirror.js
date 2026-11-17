// The stage window mirrors only the live demo iframe from the script page (tab capture, cropped to #demo),
// so clicks made in the script page's demo show up on stage. Chrome captures a tab at 2x even on a 1x
// screen, which keeps the mirrored demo sharp on a Retina display. No-op when there is no #demo.
(() => {
if (!document.getElementById('demo')) return;
const STAGE = new URLSearchParams(location.search).has('stage');
const ch = new BroadcastChannel('open-loom-mirror-' + window.OPEN_LOOM.slug);
const TITLE = window.OPEN_LOOM.title + ' [script]';   // = <title> of the script page: the tab to pick in Chrome's dialog (the stage's own title never contains it)
if (!STAGE) {
  // only the live demo iframe is mirrored; slides and camera are drawn natively in the stage window
  const send = () => { const r = document.getElementById('demo').getBoundingClientRect();
    ch.postMessage({rect: r.width > 0 ? {x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight} : null}); };
  addEventListener('resize', send); setInterval(send, 250); send();
  // Own camera preview in the left gutter, outside the mirrored demo, so you still see yourself
  const pv = document.createElement('canvas'); pv.id = 'campv'; document.body.appendChild(pv);
  const pctx = pv.getContext('2d');
  const place = () => { const r = document.getElementById('stage').getBoundingClientRect();
    const d = Math.max(120, Math.min(300, r.left - 40)); pv.width = pv.height = d * devicePixelRatio;
    Object.assign(pv.style, {width: d + 'px', height: d + 'px', left: Math.max(10, (r.left - d) / 2) + 'px', top: (r.top + r.height / 2 - d / 2) + 'px'}); };
  (function drawPv() { requestAnimationFrame(drawPv); if (!document.body.classList.contains('nocam')) return;
    const src = [document.getElementById('camcv'), document.getElementById('camvid')].find(e => e && (e.width || e.videoWidth) && (e.id !== 'camcv' || document.body.classList.contains('fx')));
    if (!src) return; const w = src.videoWidth || src.width, h = src.videoHeight || src.height, sq = Math.min(w, h);
    pctx.save(); if (document.body.classList.contains('mirror')) { pctx.translate(pv.width, 0); pctx.scale(-1, 1); }
    pctx.drawImage(src, (w - sq) / 2, (h - sq) / 2, sq, sq, 0, 0, pv.width, pv.height); pctx.restore(); })();
  addEventListener('resize', place);
  ch.onmessage = e => { if (e.data.stageOpen) { document.body.classList.add('nocam'); place(); send(); } };
} else {
  // the script page may not be listening yet: repeat until it answers with its first rect message
  let acked = false;
  const hello = () => { if (!acked) ch.postMessage({stageOpen: 1}); };
  hello(); setInterval(hello, 1000);
  const scr = document.getElementById('v-scr');
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; window.__mirv = v;
  const c = document.createElement('canvas'); c.id = 'mirc'; scr.appendChild(c);
  const ctx = c.getContext('2d'); let rect = null, on = false;
  ch.onmessage = e => { if ('rect' in e.data) { rect = e.data.rect; acked = true; } };
  const btn = document.createElement('button'); btn.id = 'mirb';
  btn.textContent = 'Click, then under Chrome Tab pick "' + TITLE + '"'; document.body.appendChild(btn);
  btn.onclick = async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({video: {frameRate: 30, cursor: 'always', width: {ideal: 8192}, height: {ideal: 8192}, displaySurface: 'browser'}, audio: false, monitorTypeSurfaces: 'exclude', surfaceSwitching: 'exclude', selfBrowserSurface: 'exclude', preferCurrentTab: false});
      const surf = s.getVideoTracks()[0].getSettings().displaySurface;
      if (surf && surf !== 'browser') { s.getTracks().forEach(t => t.stop()); btn.textContent = 'That was a window: click again and pick the Chrome Tab "' + TITLE + '"'; return; }
      v.srcObject = s; await v.play(); on = true; btn.remove(); document.body.classList.add('mirroring'); window.__mirror = 'on';
      s.getVideoTracks()[0].onended = () => { on = false; document.body.classList.remove('mirroring'); btn.textContent = 'Mirroring stopped: click to start again'; document.body.appendChild(btn); };
    } catch (err) { btn.textContent = 'Mirroring cancelled: click to try again'; }
  };
  (function draw() {
    requestAnimationFrame(draw);
    if (!on || !rect || !v.videoWidth) return;
    // the captured frame can be letterboxed if its aspect differs from the viewport: uniform scale plus centred offsets
    const k = Math.min(v.videoWidth / rect.vw, v.videoHeight / rect.vh);
    const ox = (v.videoWidth - rect.vw * k) / 2, oy = (v.videoHeight - rect.vh * k) / 2;
    const sw = Math.round(rect.w * k), sh = Math.round(rect.h * k);
    if (c.width !== sw || c.height !== sh) { c.width = sw; c.height = sh; }
    ctx.drawImage(v, ox + rect.x * k, oy + rect.y * k, rect.w * k, rect.h * k, 0, 0, sw, sh);
  })();
}
})();
