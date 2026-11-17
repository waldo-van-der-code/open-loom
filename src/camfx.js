// Webcam effects for the recording page, in the style of common video-call apps:
// Framing (auto-centre), Studio lighting (auto exposure + soft face light), Studio look (sharpen),
// Portrait touch-up (subtle skin smoothing on the face), background blur. MediaPipe selfie segmenter.
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';
const v = document.getElementById('camvid'), c = document.getElementById('camcv'), ctx = c.getContext('2d', {willReadFrequently: true});
const W = 1280, H = 720; c.width = W; c.height = H;
const mk = (w, h) => { const e = document.createElement('canvas'); e.width = w; e.height = h; return [e, e.getContext('2d')]; };
const [pc, pctx] = mk(W, H);          // sharp person layer
const [sm, smctx] = mk(W, H);         // smoothing layer (face only)
const [bg, bgctx] = mk(W / 4, H / 4); // background, blurred cheaply at quarter size
const [mc, mctx] = mk(1, 1);          // mask (person, soft edge)
const [ec, ectx] = mk(1, 1);          // erase mask (person, dilated)
const [bo, boctx] = mk(W / 4, H / 4); // background only, person cut out
// Studio look: SVG sharpen filter usable from canvas
document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute"><filter id="fxsharp"><feConvolveMatrix order="3" kernelMatrix="0 -0.35 0 -0.35 2.4 -0.35 0 -0.35 0" preserveAlpha="true"/></filter></svg>');
const LOOK = 'contrast(1.05) saturate(1.1) sepia(0.06)';   // warm, slightly punchier colour
const ZOOM = 1.3, TOP_MARGIN = 0.09;
const FX = {blur: true, frame: true, light: true, sharp: true, smooth: true};
let seg = null, last = -1, n = 0, expo = 1.08;
let crop = {x: 0, y: 0, w: W, h: H};
let face = {x: W / 2, y: H * 0.4, r: W * 0.08};   // in video coords
const sync = () => { c.className = v.className; };
new MutationObserver(sync).observe(v, {attributes: true, attributeFilter: ['class']}); sync();
// window.__camfx: 'loading' -> 'ready' | 'failed'. On failure the plain camera stays visible.
window.__camfx = 'loading';
const fail = e => { console.warn('camfx: segmenter unavailable, showing plain camera', e); seg = null; document.body.classList.remove('fx'); window.__camfx = 'failed'; };
// A slow or hanging CDN/GPU init must not leave the page "loading" forever; a late success still turns effects on.
setTimeout(() => { if (window.__camfx === 'loading') { console.warn('camfx: still loading after 15 s, showing plain camera for now'); window.__camfx = 'failed'; } }, 15000);
(async () => {
  try {
    const {FilesetResolver, ImageSegmenter} = await import(MP + '/vision_bundle.mjs');
    const fs = await FilesetResolver.forVisionTasks(MP + '/wasm');
    const make = delegate => ImageSegmenter.createFromOptions(fs, {
      baseOptions: {modelAssetPath: MODEL, delegate},
      runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false});
    try { seg = await make('GPU'); } catch (e) { seg = await make('CPU'); }
    document.body.classList.add('fx'); window.__camfx = 'ready';
  } catch (e) { fail(e); }
})();
const label = () => { const b = document.getElementById('blurb'); if (b) b.textContent = 'Blur: ' + (FX.blur ? 'on' : 'off'); };
// the Blur button is wired in prompter.js: it sends the same "b" key to both windows, so labels stay in sync
addEventListener('keydown', e => { if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'b' || e.key === 'B')) { FX.blur = !FX.blur; label(); } });
window.__fx = FX;
let mirror = true; const setMirror = () => document.body.classList.toggle('mirror', mirror); setMirror();
addEventListener('keydown', e => { if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'm' || e.key === 'M')) { mirror = !mirror; setMirror(); } });

function measure(d, mw, mh) {
  // head top, head width and horizontal centre from the mask (video coords)
  let top = -1, sx = 0, cnt = 0;
  for (let y = 0; y < mh; y++) {
    let row = 0;
    for (let x = 0; x < mw; x++) if (d[y * mw + x] > 0.5) { row++; sx += x; cnt++; }
    if (top < 0 && row > mw * 0.02) top = y;
  }
  if (top < 0 || cnt < mw * mh * 0.02) return null;
  const yr = Math.min(mh - 1, top + Math.round(mh * 0.08));
  let l = -1, r = -1;
  for (let x = 0; x < mw; x++) if (d[yr * mw + x] > 0.5) { if (l < 0) l = x; r = x; }
  const headW = Math.max(mw * 0.06, r - l) / mw * W;
  const hx = l >= 0 ? (l + r) / 2 / mw * W : (sx / cnt) / mw * W;
  const topV = top / mh * H;
  return {hx, topV, headW};
}

function frame() {
  requestAnimationFrame(frame);
  if (!seg || v.readyState < 2 || v.currentTime === last) return;
  last = v.currentTime; n++;
  try { processFrame(); } catch (e) { fail(e); }
}

function processFrame() {
  const res = seg.segmentForVideo(v, performance.now());
  try { processResult(res); } finally { res.close(); }
}

function processResult(res) {
  const m = res.confidenceMasks[0], mw = m.width, mh = m.height, d = m.getAsFloat32Array();
  const p = measure(d, mw, mh);
  // Framing: smooth crop around the head
  let t = {x: 0, y: 0, w: W, h: H};
  if (p && FX.frame) {
    const w = W / ZOOM, h = H / ZOOM;
    t = {x: Math.max(0, Math.min(W - w, p.hx - w / 2)), y: Math.max(0, Math.min(H - h, p.topV - TOP_MARGIN * h)), w, h};
  }
  for (const k of ['x', 'y', 'w', 'h']) crop[k] += (t[k] - crop[k]) * 0.06;
  if (p) { const tf = {x: p.hx, y: p.topV + 0.62 * p.headW, r: 0.5 * p.headW}; for (const k of ['x', 'y', 'r']) face[k] += (tf[k] - face[k]) * 0.2; }
  // mask with a firmer edge, so the blur does not leave a halo
  if (mc.width !== mw || mc.height !== mh) { mc.width = ec.width = mw; mc.height = ec.height = mh; }
  const img = mctx.createImageData(mw, mh), er = ectx.createImageData(mw, mh);
  for (let i = 0; i < d.length; i++) { let a = (d[i] - 0.35) / 0.3; a = a < 0 ? 0 : a > 1 ? 1 : a; img.data[i * 4 + 3] = a * a * (3 - 2 * a) * 255; er.data[i * 4 + 3] = d[i] > 0.12 ? 255 : 0; }
  mctx.putImageData(img, 0, 0); ectx.putImageData(er, 0, 0);
  const kx = v.videoWidth / W, ky = v.videoHeight / H;
  const S = [crop.x * kx, crop.y * ky, crop.w * kx, crop.h * ky];
  const toOut = (x, y) => [(x - crop.x) / crop.w * W, (y - crop.y) / crop.h * H];
  const [fx, fy] = toOut(face.x, face.y), fr = face.r / crop.w * W;
  const BASE = `brightness(${(FX.light ? expo : 1).toFixed(3)}) ${LOOK}`;
  // 1) background
  if (FX.blur) {
    // background with the person erased (dilated), blurred as normalized convolution: no dark halo
    const q = bg.width / W;
    boctx.globalCompositeOperation = 'copy'; boctx.filter = 'none'; boctx.drawImage(v, ...S, 0, 0, bo.width, bo.height);
    boctx.globalCompositeOperation = 'destination-out'; boctx.filter = 'blur(1.5px)';
    boctx.drawImage(ec, crop.x / W * mw, crop.y / H * mh, crop.w / W * mw, crop.h / H * mh, -2, -2, bo.width + 4, bo.height + 4);
    boctx.globalCompositeOperation = 'source-over'; boctx.filter = 'none';
    bgctx.globalCompositeOperation = 'copy'; bgctx.filter = 'blur(3px)'; bgctx.drawImage(v, ...S, -4, -4, bg.width + 8, bg.height + 8);
    bgctx.globalCompositeOperation = 'source-over'; bgctx.filter = 'blur(4px)';
    for (let i = 0; i < 6; i++) bgctx.drawImage(bo, -4, -4, bg.width + 8, bg.height + 8);
    bgctx.filter = 'none';
    ctx.save(); ctx.filter = BASE; ctx.drawImage(bg, 0, 0, W, H); ctx.restore();
  } else { ctx.save(); ctx.filter = BASE; ctx.drawImage(v, ...S, 0, 0, W, H); ctx.restore(); }
  // 2) person, sharpened (Studio look)
  pctx.globalCompositeOperation = 'copy'; pctx.filter = 'blur(2px)';
  pctx.drawImage(mc, crop.x / W * mw, crop.y / H * mh, crop.w / W * mw, crop.h / H * mh, 0, 0, W, H);
  pctx.filter = FX.sharp ? 'url(#fxsharp)' : 'none'; pctx.globalCompositeOperation = 'source-in'; pctx.drawImage(v, ...S, 0, 0, W, H);
  pctx.filter = 'none';
  ctx.save(); ctx.filter = BASE; ctx.drawImage(pc, 0, 0); ctx.restore();
  // 3) Portrait touch-up (subtle): softened copy blended over the face only
  if (FX.smooth && p) {
    smctx.globalCompositeOperation = 'copy'; smctx.filter = 'blur(2.2px)'; smctx.drawImage(c, 0, 0);
    smctx.filter = 'none'; smctx.globalCompositeOperation = 'destination-in';
    const g = smctx.createRadialGradient(fx, fy, fr * 0.2, fx, fy, fr * 1.15);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    smctx.fillStyle = g; smctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = 0.38; ctx.drawImage(sm, 0, 0); ctx.restore();
  }
  // 4) Studio lighting: soft key light on the face + gentle vignette
  if (FX.light && p) {
    ctx.save(); ctx.globalCompositeOperation = 'soft-light';
    const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr * 2.4);
    g.addColorStop(0, 'rgba(255,240,225,0.55)'); g.addColorStop(1, 'rgba(255,240,225,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
    ctx.save(); const vg = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.45, W / 2, H * 0.45, H * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.18)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H); ctx.restore();
    // auto exposure: aim the face at a mid-bright level
    if (n % 10 === 0) {
      const s = Math.max(4, Math.round(fr * 0.5)), x0 = Math.round(Math.max(0, Math.min(W - s, fx - s / 2))), y0 = Math.round(Math.max(0, Math.min(H - s, fy - s / 2)));
      const px = ctx.getImageData(x0, y0, s, s).data; let L = 0;
      for (let i = 0; i < px.length; i += 16) L += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      L /= (px.length / 16) * 255;
      const target = 0.62, want = Math.max(0.9, Math.min(1.45, expo * (target / Math.max(0.05, L))));
      expo += (want - expo) * 0.25;
    }
  }
}
requestAnimationFrame(frame);
