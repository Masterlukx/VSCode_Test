'use strict';

/* ================================================================
   Cap Collector – scan bottle caps, detect duplicates, keep new ones.
   Everything runs on the phone: photos + fingerprints live in IndexedDB.
   ================================================================ */

const $ = (id) => document.getElementById(id);

const CAP_SIZE = 256;        // stored image size (px)
const GUIDE = 0.8;           // guide circle diameter relative to viewfinder
const FEAT_VERSION = 1;      // bump when the fingerprint algorithm changes
const RINGS = 24, ANGLES = 64, SMALL = 96;
const HUE_BINS = 12;

/* ---------------------------- Storage ---------------------------- */

const store = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('cap-collector', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('caps', { keyPath: 'id' });
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction('caps', mode);
      const result = fn(t.objectStore('caps'));
      t.oncomplete = () => resolve(result && result.result);
      t.onerror = () => reject(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  put(cap) { return this.tx('readwrite', (s) => s.put(cap)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

let caps = [];               // all caps, oldest first
const urlCache = new Map();  // id -> object URL for thumbnails

function capUrl(cap) {
  if (!urlCache.has(cap.id)) urlCache.set(cap.id, URL.createObjectURL(cap.image));
  return urlCache.get(cap.id);
}
function capNumber(cap) { return caps.indexOf(cap) + 1; }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

const settings = {
  get threshold() { return Number(localStorage.getItem('threshold') || 72); },
  set threshold(v) { localStorage.setItem('threshold', String(v)); },
};

/* ------------------------- Fingerprinting -------------------------
   Each cap gets three descriptors:
   - polar:  luminance sampled on a polar grid (rings x angles). A rotated cap
             is just a circular shift along the angle axis, so we can compare
             two caps at every rotation and take the best one.
   - ring:   average luminance per ring (rotation-invariant, cheap pre-filter)
   - hist:   hue/saturation colour histogram (rotation-invariant)          */

function computeFeatures(src) {
  const c = document.createElement('canvas');
  c.width = c.height = SMALL;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, SMALL, SMALL);
  const px = ctx.getImageData(0, 0, SMALL, SMALL).data;

  const lum = new Float32Array(SMALL * SMALL);
  const hist = new Float32Array(HUE_BINS * 2 + 3);
  const cx = SMALL / 2, R = SMALL / 2;
  let histCount = 0;

  for (let y = 0; y < SMALL; y++) {
    for (let x = 0; x < SMALL; x++) {
      const i = y * SMALL + x, r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cx;
      if (dx * dx + dy * dy > (0.9 * R) ** 2) continue;
      // HSV
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      const v = max / 255, s = max === 0 ? 0 : d / max;
      if (s < 0.25 || v < 0.15) {
        hist[HUE_BINS * 2 + (v < 0.35 ? 0 : v < 0.7 ? 1 : 2)]++;
      } else {
        let h;
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        const hb = Math.floor((h / 6) * HUE_BINS) % HUE_BINS;
        hist[hb * 2 + (s < 0.6 ? 0 : 1)]++;
      }
      histCount++;
    }
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= histCount || 1;

  const sample = (x, y) => {
    x = Math.min(Math.max(x, 0), SMALL - 1.001); y = Math.min(Math.max(y, 0), SMALL - 1.001);
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * SMALL + x0;
    return lum[i] * (1 - fx) * (1 - fy) + lum[i + 1] * fx * (1 - fy) +
           lum[i + SMALL] * (1 - fx) * fy + lum[i + SMALL + 1] * fx * fy;
  };

  const polar = new Float32Array(RINGS * ANGLES);
  const ring = new Float32Array(RINGS);
  for (let r = 0; r < RINGS; r++) {
    const rad = R * (0.06 + 0.84 * (r + 0.5) / RINGS);
    let sum = 0;
    for (let a = 0; a < ANGLES; a++) {
      const th = (2 * Math.PI * a) / ANGLES;
      const v = sample(cx + rad * Math.cos(th) - 0.5, cx + rad * Math.sin(th) - 0.5);
      polar[r * ANGLES + a] = v;
      sum += v;
    }
    ring[r] = sum / ANGLES;
  }
  normalize(polar);
  normalize(ring);
  return { v: FEAT_VERSION, polar, ring, hist };
}

// zero mean, unit length -> dot product == normalized cross-correlation
function normalize(arr) {
  let mean = 0;
  for (const v of arr) mean += v;
  mean /= arr.length;
  let norm = 0;
  for (let i = 0; i < arr.length; i++) { arr[i] -= mean; norm += arr[i] * arr[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < arr.length; i++) arr[i] /= norm;
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function histSim(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.min(a[i], b[i]); return s; }

// best correlation over all rotations
function rotationCorr(a, b) {
  let best = -1;
  for (let k = 0; k < ANGLES; k++) {
    let s = 0;
    for (let r = 0; r < RINGS; r++) {
      const base = r * ANGLES;
      for (let t = 0; t < ANGLES; t++) s += a[base + t] * b[base + ((t + k) & (ANGLES - 1))];
    }
    if (s > best) best = s;
  }
  return best;
}

function findMatches(feat, limit = 6) {
  // Stage 1: cheap rotation-invariant score over everything
  const coarse = caps.map((cap) => ({
    cap,
    c: 0.6 * histSim(feat.hist, cap.feat.hist) + 0.4 * Math.max(0, dot(feat.ring, cap.feat.ring)),
  }));
  coarse.sort((x, y) => y.c - x.c);
  // Stage 2: full rotation-aware comparison on the best candidates
  return coarse.slice(0, 60).map(({ cap }) => {
    const color = histSim(feat.hist, cap.feat.hist);
    const shape = Math.max(0, rotationCorr(feat.polar, cap.feat.polar));
    return { cap, score: Math.round(100 * (0.45 * color + 0.55 * shape)) };
  }).sort((x, y) => y.score - x.score).slice(0, limit);
}

/* ---------------------------- Views ---------------------------- */

function show(view) {
  for (const v of ['scan', 'adjust', 'result', 'collection']) $('view-' + v).hidden = v !== view;
  if (view === 'scan') startCamera(); else stopCamera();
  if (view === 'collection') renderGrid();
  window.scrollTo(0, 0);
}

function updateCount() { $('count').textContent = caps.length; }

function busy(on) { $('busy').hidden = !on; }

/* ---------------------------- Camera ---------------------------- */

let stream = null, torchOn = false;

async function startCamera() {
  if (stream) return;
  const msg = $('cam-msg');
  msg.hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'Live camera not available here – use the Photo button.';
    msg.hidden = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    // the user may have left the scan view while we were waiting
    if ($('view-scan').hidden) { stopCamera(); return; }
    $('video').srcObject = stream;
    const track = stream.getVideoTracks()[0];
    const tc = track.getCapabilities ? track.getCapabilities() : {};
    $('torch').hidden = !tc.torch;
    if (tc.torch && torchOn) track.applyConstraints({ advanced: [{ torch: true }] });
  } catch (err) {
    stream = null;
    msg.textContent = 'Camera blocked or unavailable (' + err.name + '). Allow camera access, or use the Photo button.';
    msg.hidden = false;
  }
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('video').srcObject = null;
}

$('torch').onclick = async () => {
  if (!stream) return;
  torchOn = !torchOn;
  try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }); } catch {}
  $('torch').classList.toggle('on', torchOn);
};

// crop the circle area from the live video
$('shutter').onclick = () => {
  const video = $('video');
  if (!stream || !video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const d = GUIDE * Math.min(vw, vh);
  const out = makeCapCanvas((ctx) => ctx.drawImage(video, (vw - d) / 2, (vh - d) / 2, d, d, 0, 0, CAP_SIZE, CAP_SIZE));
  checkCap(out);
};

// fill a CAP_SIZE canvas and blank everything outside the circle
function makeCapCanvas(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = CAP_SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CAP_SIZE, CAP_SIZE);
  ctx.save();
  ctx.beginPath();
  ctx.arc(CAP_SIZE / 2, CAP_SIZE / 2, CAP_SIZE / 2, 0, Math.PI * 2);
  ctx.clip();
  draw(ctx);
  ctx.restore();
  return c;
}

/* ----------------------- Adjust picked photo ----------------------- */

const adj = { img: null, base: 1, zoom: 1, tx: 0, ty: 0, pointers: new Map(), pinchDist: 0, pinchZoom: 1 };
const AC = 512;               // adjust canvas size
const CIRCLE = AC * GUIDE;    // circle diameter on adjust canvas

$('file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    adj.img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    alert('Could not read that image.');
    return;
  }
  adj.base = CIRCLE / Math.min(adj.img.width, adj.img.height);
  adj.zoom = 1; adj.tx = 0; adj.ty = 0;
  $('zoom').value = 1;
  show('adjust');
  drawAdjust();
};

function adjScale() { return adj.base * adj.zoom; }

function drawAdjust() {
  const ctx = $('adjust-canvas').getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, AC, AC);
  const s = adjScale();
  ctx.setTransform(s, 0, 0, s, AC / 2 + adj.tx, AC / 2 + adj.ty);
  ctx.drawImage(adj.img, -adj.img.width / 2, -adj.img.height / 2);
}

$('zoom').oninput = (e) => { adj.zoom = Number(e.target.value); drawAdjust(); };

const acanvas = $('adjust-canvas');
acanvas.addEventListener('pointerdown', (e) => {
  acanvas.setPointerCapture(e.pointerId);
  adj.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (adj.pointers.size === 2) {
    const [a, b] = [...adj.pointers.values()];
    adj.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    adj.pinchZoom = adj.zoom;
  }
});
acanvas.addEventListener('pointermove', (e) => {
  const prev = adj.pointers.get(e.pointerId);
  if (!prev) return;
  const k = AC / acanvas.getBoundingClientRect().width;
  if (adj.pointers.size === 1) {
    adj.tx += (e.clientX - prev.x) * k;
    adj.ty += (e.clientY - prev.y) * k;
  }
  adj.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (adj.pointers.size === 2) {
    const [a, b] = [...adj.pointers.values()];
    const z = adj.pinchZoom * Math.hypot(a.x - b.x, a.y - b.y) / adj.pinchDist;
    adj.zoom = Math.min(6, Math.max(0.3, z));
    $('zoom').value = adj.zoom;
  }
  drawAdjust();
});
const endPointer = (e) => adj.pointers.delete(e.pointerId);
acanvas.addEventListener('pointerup', endPointer);
acanvas.addEventListener('pointercancel', endPointer);

$('adjust-cancel').onclick = () => show('scan');
$('adjust-ok').onclick = () => {
  const k = CAP_SIZE / CIRCLE, s = adjScale() * k;
  const off = (AC - CIRCLE) / 2;
  const out = makeCapCanvas((ctx) => {
    ctx.setTransform(s, 0, 0, s, (AC / 2 + adj.tx - off) * k, (AC / 2 + adj.ty - off) * k);
    ctx.drawImage(adj.img, -adj.img.width / 2, -adj.img.height / 2);
  });
  checkCap(out);
};

/* ------------------------- Check & result ------------------------- */

let lastAdded = null;

function toBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
}

async function checkCap(canvas) {
  busy(true);
  stopCamera();
  await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
  const feat = computeFeatures(canvas);
  const image = await toBlob(canvas);
  const matches = findMatches(feat);
  busy(false);

  const best = matches[0];
  const pending = { id: newId(), created: Date.now(), note: '', image, feat };
  const previewUrl = URL.createObjectURL(image);
  $('result-img').src = previewUrl;

  if (best && best.score >= settings.threshold) {
    renderResult('dup', pending, matches, best);
  } else {
    await addCap(pending);
    renderResult('new', pending, matches);
  }
  show('result');
}

async function addCap(cap) {
  await store.put(cap);
  caps.push(cap);
  lastAdded = cap;
  updateCount();
}

async function removeCap(cap) {
  await store.del(cap.id);
  caps = caps.filter((c) => c !== cap);
  if (urlCache.has(cap.id)) { URL.revokeObjectURL(urlCache.get(cap.id)); urlCache.delete(cap.id); }
  updateCount();
}

function renderResult(kind, pending, matches, best) {
  const card = $('result-card');
  const actions = $('result-actions');
  actions.innerHTML = '';
  $('note').value = '';
  card.className = 'result-card ' + kind;

  const button = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.onclick = fn;
    actions.appendChild(b);
    return b;
  };

  if (kind === 'dup') {
    $('result-title').textContent = 'You already have this one!';
    $('result-text').textContent =
      `${best.score}% match with cap #${capNumber(best.cap)}. Compare below – is it really the same?`;
    $('note-wrap').hidden = true;
    button('✅ Same cap – discard', 'ok', () => show('scan'));
    button('➕ It’s different – add it', 'secondary', async () => {
      await addCap(pending);
      renderResult('new', pending, matches);
    });
  } else {
    $('result-title').textContent = 'New cap! 🎉';
    $('result-text').textContent = `Added to your collection as #${capNumber(pending)}.`;
    $('note-wrap').hidden = false;
    button('📷 Scan next cap', '', () => show('scan'));
    button('↩️ Oops, I already had it – remove', 'secondary', async () => {
      await removeCap(pending);
      show('scan');
    });
  }

  $('cand-title').hidden = matches.length === 0;
  const list = $('candidates');
  list.innerHTML = '';
  for (const m of matches) {
    if (m.cap === pending) continue;
    const el = document.createElement('button');
    el.className = 'cand';
    el.innerHTML = `<img class="cap" alt=""><b class="${m.score >= settings.threshold ? 'hi' : ''}">${m.score}%</b><span></span>`;
    el.querySelector('img').src = capUrl(m.cap);
    el.querySelector('span').textContent = '#' + capNumber(m.cap) + (m.cap.note ? ' ' + m.cap.note : '');
    el.onclick = () => openDetail(m.cap);
    list.appendChild(el);
  }
}

$('note').oninput = debounce(async () => {
  if (!lastAdded) return;
  lastAdded.note = $('note').value.trim();
  await store.put(lastAdded);
}, 400);

/* --------------------------- Collection --------------------------- */

function renderGrid() {
  const q = $('search').value.trim().toLowerCase();
  const grid = $('grid');
  grid.innerHTML = '';
  const list = caps.filter((c) => !q || (c.note || '').toLowerCase().includes(q)).reverse();
  for (const cap of list) {
    const b = document.createElement('button');
    b.innerHTML = '<img class="cap" alt="" loading="lazy"><span></span>';
    b.querySelector('img').src = capUrl(cap);
    b.querySelector('span').textContent = '#' + capNumber(cap);
    b.title = cap.note || '';
    b.onclick = () => openDetail(cap);
    grid.appendChild(b);
  }
  $('empty').hidden = caps.length > 0;
}

$('search').oninput = debounce(renderGrid, 200);
$('to-collection').onclick = () => show('collection');
$('back-scan').onclick = () => show('scan');

let detailCap = null;
function openDetail(cap) {
  detailCap = cap;
  $('detail-img').src = capUrl(cap);
  $('detail-title').textContent = 'Cap #' + capNumber(cap);
  $('detail-date').textContent = 'Added ' + new Date(cap.created).toLocaleString();
  $('detail-note').value = cap.note || '';
  $('detail-delete').textContent = 'Delete';
  $('detail').showModal();
}
$('detail-close').onclick = () => $('detail').close();
$('detail').addEventListener('close', async () => {
  if (!detailCap) return;
  const note = $('detail-note').value.trim();
  if (note !== (detailCap.note || '')) {
    detailCap.note = note;
    await store.put(detailCap);
    if (!$('view-collection').hidden) renderGrid();
  }
  detailCap = null;
});
$('detail-delete').onclick = async () => {
  const btn = $('detail-delete');
  if (btn.textContent === 'Delete') { btn.textContent = 'Tap again to delete'; return; }
  const cap = detailCap;
  detailCap = null;
  $('detail').close();
  await removeCap(cap);
  if (!$('view-collection').hidden) renderGrid();
  if (!$('view-result').hidden) show('scan');
};

/* ---------------------------- Settings ---------------------------- */

$('threshold').value = settings.threshold;
$('thr-val').textContent = settings.threshold + '%';
$('threshold').oninput = (e) => {
  settings.threshold = e.target.value;
  $('thr-val').textContent = e.target.value + '%';
};

/* ------------------------- Backup / restore ------------------------- */

function blobToDataUrl(blob) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

$('export').onclick = async () => {
  busy(true);
  const out = [];
  for (const c of caps) out.push({ id: c.id, created: c.created, note: c.note || '', image: await blobToDataUrl(c.image) });
  const json = JSON.stringify({ app: 'cap-collector', version: 1, exported: new Date().toISOString(), caps: out });
  const file = new File([json], `caps-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  busy(false);
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Cap Collector backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

$('import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  busy(true);
  let added = 0;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'cap-collector') throw new Error('Not a Cap Collector backup');
    const known = new Set(caps.map((c) => c.id));
    for (const item of data.caps) {
      if (known.has(item.id)) continue;
      const image = await (await fetch(item.image)).blob();
      const feat = computeFeatures(await createImageBitmap(image));
      const cap = { id: item.id, created: item.created, note: item.note || '', image, feat };
      await store.put(cap);
      caps.push(cap);
      added++;
    }
    caps.sort((a, b) => a.created - b.created);
    alert(`Imported ${added} new caps.`);
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  busy(false);
  updateCount();
  renderGrid();
};

/* ------------------------------ Utils ------------------------------ */

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ------------------------------ Start ------------------------------ */

(async function init() {
  await store.open();
  caps = (await store.all()).sort((a, b) => a.created - b.created);
  // recompute fingerprints if the algorithm was updated
  for (const cap of caps) {
    if (cap.feat?.v !== FEAT_VERSION) {
      cap.feat = computeFeatures(await createImageBitmap(cap.image));
      await store.put(cap);
    }
  }
  updateCount();
  navigator.storage?.persist?.();
  show('scan');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();

// release the camera when the app goes to the background
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (!$('view-scan').hidden) startCamera();
});
