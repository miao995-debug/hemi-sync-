// 賽博雷音：介面
// 版本號：每次發布都要改這裡、index.html、engine.js 的 ?v=，避免手機用到快取的舊檔
import { F_MIN, F_MAX, formants, envelope, partialAmp, partialCount, VOWELS } from './voice.js?v=0.1.2';
const VERSION = '0.1.2';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const SKEY = 'leiyin-settings', PKEY = 'leiyin-points';
const PARTS = ['整體', '頭頂', '前額', '眉心', '鼻腔', '上顎', '喉嚨', '後腦', '左側', '右側', '胸口'];

/* ---------- 設定（集中在單一物件：存檔、套用紀錄、未來紀錄共用） ---------- */
const a0 = VOWELS.find(v => v.v === 'a');
const DEF = {
  mode: 'tone', f0: 200, delta: 4, x: a0.x, y: a0.y, nasal: 0, round: 0,
  bal: 0, mix: 0, vol: 35, limit: 30, headset: 'OpenSwim Pro', fine: false,
};
function load(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; } catch (e) { return def; }
}
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
const S = Object.assign({}, DEF, load(SKEY, {}));
let points = load(PKEY, []);
if (!Array.isArray(points)) points = [];
let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store(SKEY, S), 300); }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- 音訊 ---------- */
let ctx = null, node = null, playing = false, endAt = 0;

function engineParams() {
  const b = S.bal / 100;
  return {
    mode: S.mode, f0: S.f0, delta: S.delta, F: formants(S.x, S.y, S.round / 100), nasal: S.nasal / 100,
    gL: b > 0 ? 1 - b : 1, gR: b < 0 ? 1 + b : 1, mix: S.mix / 100,
  };
}
const volGain = () => (S.vol / 100) ** 2;
function push(extra) { if (node) node.port.postMessage(Object.assign(engineParams(), extra || {})); }

async function ensureEngine() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('./engine.js?v=' + VERSION, import.meta.url));
  node = new AudioWorkletNode(ctx, 'leiyin-engine', {
    numberOfInputs: 0, outputChannelCount: [2], processorOptions: engineParams(),
  });
  node.connect(ctx.destination);
  ctx.onstatechange = updateStatus;
}

async function start() {
  // iPhone：預設的網頁音訊會被側邊靜音鍵靜音；宣告成「播放媒體」就不受靜音鍵影響（Safari 16.4+）
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  try {
    await ensureEngine();
    await ctx.resume();
  } catch (e) {
    $('#status').textContent = '無法啟動音訊：' + e.message;
    return;
  }
  playing = true;
  push({ gain: volGain(), fade: 0.3 });
  endAt = Date.now() + S.limit * 60000;
  updateStatus();
}

function stop(fadeSec = 0.4, reason = '') {
  if (!playing) return;
  playing = false;
  stopSweep();
  push({ gain: 0, fade: fadeSec / 3 });
  setTimeout(() => { if (!playing && ctx) ctx.suspend().catch(() => {}); }, fadeSec * 1000 + 200);
  updateStatus(reason);
}

function togglePlay() { playing ? stop() : start(); }

function updateStatus(reason) {
  const running = ctx && ctx.state === 'running';
  const label = playing ? '停止' : '播放';
  $('#playBig').textContent = label;
  $('#playBar').textContent = label;
  $('#interrupted').hidden = !(playing && ctx && !running);
  if (typeof reason === 'string' && reason) $('#status').textContent = reason;
  else $('#status').textContent = playing ? (running ? '播放中' : '已中斷') : '已停止';
  if (!playing) $('#remain').textContent = '';
}

// 每秒：剩餘時間、到時淡出
setInterval(() => {
  if (!playing) return;
  const left = endAt - Date.now();
  if (left <= 0) { stop(5, '時間到，已自動停止'); return; }
  const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
  $('#remain').textContent = `剩 ${m}:${String(s).padStart(2, '0')}`;
}, 1000);

// 通話等中斷後：回到畫面時自動試著恢復；不行就顯示「繼續」
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && playing && ctx && ctx.state !== 'running') ctx.resume().catch(() => {}).finally(updateStatus);
});
$('#resume').onclick = () => { if (ctx) ctx.resume().finally(updateStatus); };
$('#playBig').onclick = togglePlay;
$('#playBar').onclick = togglePlay;

if (!window.isSecureContext || !window.AudioWorkletNode) {
  $('#unsupported').hidden = false;
  $('#playBig').disabled = $('#playBar').disabled = true;
}

/* ---------- 共振頻率（對數刻度） ---------- */
const LOGR = Math.log(F_MAX / F_MIN);
const f0ToSlider = f => Math.round(Math.log(f / F_MIN) / LOGR * 1000);
const sliderToF0 = t => Math.round(F_MIN * Math.exp(t / 1000 * LOGR) * 10) / 10;

function setF0(f, fromSweep) {
  S.f0 = clamp(Math.round(f * 10) / 10, F_MIN, F_MAX);
  if (!fromSweep) stopSweep();
  $('#f0').value = f0ToSlider(S.f0);
  $('#f0Out').textContent = S.f0.toFixed(1) + ' Hz';
  changed();
}
$('#f0').oninput = e => setF0(sliderToF0(+e.target.value));
$$('[data-nudge]').forEach(b => b.onclick = () => setF0(S.f0 + parseFloat(b.dataset.nudge)));

/* ---------- 自動掃頻 ---------- */
const SWEEP_OCT_PER_MIN = 1.2;
let sweepTimer = 0, sweepLast = 0;
function stopSweep() {
  if (!sweepTimer) return;
  clearInterval(sweepTimer); sweepTimer = 0;
  $('#sweep').setAttribute('aria-pressed', 'false'); $('#sweep').textContent = '自動掃頻';
  $('#sweepHint').hidden = true;
}
$('#sweep').onclick = () => {
  if (sweepTimer) { stopSweep(); return; }
  if (!playing) start();
  sweepLast = performance.now();
  $('#sweep').setAttribute('aria-pressed', 'true'); $('#sweep').textContent = '停止掃頻';
  $('#sweepHint').hidden = false;
  sweepTimer = setInterval(() => {
    const now = performance.now(), dt = (now - sweepLast) / 60000; sweepLast = now;
    const f = S.f0 * Math.pow(2, SWEEP_OCT_PER_MIN * dt);
    if (f >= F_MAX) { setF0(F_MAX, true); stopSweep(); return; }
    setF0(f, true);
  }, 50);
};

/* ---------- 一般橫條 ---------- */
function bindRange(id, key, fmt) {
  const el = $('#' + id), out = $('#' + id + 'Out');
  const show = () => { if (out) out.textContent = fmt(S[key]); };
  el.oninput = () => { S[key] = parseFloat(el.value); show(); changed(); };
  return () => { el.value = S[key]; show(); };
}
const syncers = [
  bindRange('nasal', 'nasal', v => v + '%'),
  bindRange('round', 'round', v => v + '%'),
  bindRange('delta', 'delta', v => v.toFixed(1) + ' Hz' + (v >= 4 && v < 8 ? '（θ）' : v === 0 ? '（無節拍）' : '')),
  bindRange('bal', 'bal', v => v === 0 ? '置中' : v < 0 ? `偏左 ${-v}%` : `偏右 ${v}%`),
  bindRange('mix', 'mix', v => v + '%'),
];
const syncVol = bindRange('vol', 'vol', v => v + '%');
$('#vol').addEventListener('input', () => { if (playing) push({ gain: volGain(), fade: 0.05 }); });

$('#limit').onchange = e => {
  S.limit = +e.target.value; saveSoon();
  if (playing) endAt = Date.now() + S.limit * 60000;
};
$('#headset').onchange = e => { S.headset = e.target.value; saveSoon(); };
$('#fine').onchange = e => { S.fine = e.target.checked; saveSoon(); };

/* ---------- 音色模式 ---------- */
function setMode(m) { S.mode = m; changed(); }
$$('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));

/* ---------- 口型觸控板 ---------- */
const pad = $('#pad');
let drag = null;
function padRect() { return pad.getBoundingClientRect(); }
function setXY(x, y) { S.x = clamp(x, 0, 1); S.y = clamp(y, 0, 1); changed(); }
pad.addEventListener('pointerdown', e => {
  pad.setPointerCapture(e.pointerId);
  const r = padRect();
  if (S.fine) drag = { px: e.clientX, py: e.clientY, x: S.x, y: S.y, w: r.width, h: r.height };
  else { drag = { abs: true }; setXY((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }
});
pad.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.abs) { const r = padRect(); setXY((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }
  else setXY(drag.x + (e.clientX - drag.px) / drag.w * 0.15, drag.y + (e.clientY - drag.py) / drag.h * 0.15);
});
const endDrag = () => { drag = null; };
pad.addEventListener('pointerup', endDrag);
pad.addEventListener('pointercancel', endDrag);
pad.addEventListener('keydown', e => {
  const st = S.fine ? 0.002 : 0.01;
  const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
  if (!d) return;
  e.preventDefault();
  setXY(S.x + d[0], S.y + d[1]);
});

function nearestVowel() {
  let best = null, bd = 1e9;
  for (const v of VOWELS) { const d = Math.hypot(v.x - S.x, v.y - S.y); if (d < bd) { bd = d; best = v; } }
  return { v: best.v, d: bd };
}
function vowelLabel(s) {
  let best = null, bd = 1e9;
  for (const v of VOWELS) { const d = Math.hypot(v.x - s.x, v.y - s.y); if (d < bd) { bd = d; best = v; } }
  return (bd < 0.06 ? '' : '近 ') + best.v;
}

/* ---------- 畫圖 ---------- */
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}

function drawPad() {
  const { g, w, h } = fitCanvas(pad);
  const ink = css('--ink'), mute = css('--mute'), line = css('--line'), acc = css('--acc'), dot = css('--dot');
  g.clearRect(0, 0, w, h);
  g.strokeStyle = line; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo(w * i / 4, 0); g.lineTo(w * i / 4, h); g.stroke();
    g.beginPath(); g.moveTo(0, h * i / 4); g.lineTo(w, h * i / 4); g.stroke();
  }
  // 母音三角形
  const order = ['i', 'e', 'a', 'o', 'u'].map(v => VOWELS.find(x => x.v === v));
  g.strokeStyle = mute; g.setLineDash([4, 4]); g.beginPath();
  order.forEach((v, i) => (i ? g.lineTo : g.moveTo).call(g, v.x * w, v.y * h));
  g.closePath(); g.stroke(); g.setLineDash([]);
  g.font = '600 15px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const v of VOWELS) {
    g.fillStyle = mute; g.beginPath(); g.arc(v.x * w, v.y * h, 3, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink; g.fillText(v.v, v.x * w + (v.x > 0.5 ? -12 : 12), v.y * h + (v.y * h < 24 ? 12 : -12));
  }
  // 共振點
  g.fillStyle = dot;
  for (const p of points) {
    if (p.s.mode !== 'voice') continue;
    g.globalAlpha = 0.75; g.beginPath(); g.arc(p.s.x * w, p.s.y * h, 4.5, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  // 目前位置
  const cx = S.x * w, cy = S.y * h;
  g.strokeStyle = acc; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, 14, 0, Math.PI * 2); g.stroke();
  g.fillStyle = acc; g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.fill();
}

function drawSpec() {
  const c = $('#spec'), { g, w, h } = fitCanvas(c);
  const mute = css('--mute'), acc = css('--acc'), line = css('--line');
  const FMAXV = 4000, floorDb = -40, padB = 14;
  const X = f => f / FMAXV * w, Y = db => (1 - (db - floorDb) / -floorDb) * (h - padB);
  g.clearRect(0, 0, w, h);
  g.fillStyle = mute; g.font = '11px system-ui, sans-serif'; g.textBaseline = 'bottom';
  for (let f = 1000; f < FMAXV; f += 1000) {
    g.strokeStyle = line; g.beginPath(); g.moveTo(X(f), 0); g.lineTo(X(f), h - padB); g.stroke();
    g.textAlign = 'center'; g.fillText(f / 1000 + 'k', X(f), h);
  }
  const p = engineParams();
  if (S.mode === 'voice') {
    let mx = 0; const env = [];
    for (let i = 0; i <= 200; i++) { const f = 20 + i / 200 * (FMAXV - 20); const e = envelope(f, p.F, p.nasal); env.push([f, e]); mx = Math.max(mx, e); }
    g.strokeStyle = mute; g.lineWidth = 1.5; g.beginPath();
    env.forEach(([f, e], i) => { const db = Math.max(floorDb, 20 * Math.log10(e / mx)); (i ? g.lineTo : g.moveTo).call(g, X(f), Y(db)); });
    g.stroke();
    const K = partialCount(S.f0, 48000); let am = 0; const amps = [];
    for (let k = 1; k <= K; k++) { const a = partialAmp(k, S.f0, p.F, p.nasal); amps.push(a); am = Math.max(am, a); }
    g.strokeStyle = acc; g.lineWidth = 2;
    amps.forEach((a, i) => {
      const f = (i + 1) * S.f0; if (f > FMAXV) return;
      const db = Math.max(floorDb, 20 * Math.log10(a / am));
      g.beginPath(); g.moveTo(X(f), Y(floorDb)); g.lineTo(X(f), Y(db)); g.stroke();
    });
    g.fillStyle = mute; g.textAlign = 'left'; g.textBaseline = 'top';
    p.F.forEach((F, i) => g.fillText('F' + (i + 1), X(F) + 3, 2));
  } else {
    g.strokeStyle = acc; g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(S.f0), Y(floorDb)); g.lineTo(X(S.f0), Y(0)); g.stroke();
    g.fillStyle = mute; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText('單一頻率', X(S.f0) + 4, 2);
  }
}

/* ---------- 同步畫面 ---------- */
let drawQueued = false;
function redraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawPad(); drawSpec(); });
}
function changed() {
  push();
  saveSoon();
  $$('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));
  const voice = S.mode === 'voice';
  pad.classList.toggle('dim', !voice);
  $('#toneNote').hidden = voice;
  const [F1, F2] = formants(S.x, S.y, S.round / 100);
  const nv = nearestVowel();
  $('#padOut').textContent = `F1 ${Math.round(F1)}・F2 ${Math.round(F2)} Hz・${nv.d < 0.06 ? '' : '最接近 '}${nv.v}`;
  redraw();
}
function syncAll() {
  setF0(S.f0, true);
  syncers.forEach(f => f());
  syncVol();
  $('#limit').value = String(S.limit);
  $('#headset').value = S.headset;
  $('#fine').checked = !!S.fine;
  changed();
}
window.addEventListener('resize', redraw);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);

/* ---------- 共振點紀錄 ---------- */
const form = $('#recForm');
let picked = new Set();
$('#parts').innerHTML = PARTS.map(p => `<button type="button" aria-pressed="false">${p}</button>`).join('');
$$('#parts button').forEach(b => b.onclick = () => {
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  on ? picked.add(b.textContent) : picked.delete(b.textContent);
});
function openRec() {
  picked = new Set();
  $$('#parts button').forEach(b => b.setAttribute('aria-pressed', 'false'));
  $('#note').value = '';
  form.dataset.snapshot = JSON.stringify(snapshot());
  form.hidden = false;
  $('#logCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function snapshot() {
  const { mode, f0, delta, x, y, nasal, round, bal, mix } = S;
  return { mode, f0, delta, x, y, nasal, round, bal, mix };
}
$('#recBtn').onclick = openRec;
$('#recCancel').onclick = () => { form.hidden = true; };
form.onsubmit = e => {
  e.preventDefault();
  points.push({
    id: Date.now(), t: new Date().toISOString(), parts: [...picked], note: $('#note').value.trim(),
    headset: S.headset, s: JSON.parse(form.dataset.snapshot),
  });
  store(PKEY, points);
  form.hidden = true;
  renderPoints(); redraw();
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderPoints() {
  const list = points.slice().reverse();
  $('#noPoints').hidden = list.length > 0;
  $('#points').innerHTML = list.map(p => {
    const d = new Date(p.t);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
    const tone = p.s.mode === 'voice' ? `口型 ${vowelLabel(p.s)}` : '單音';
    return `<li data-id="${p.id}"><div class="info"><div>${esc(p.parts.join('、') || '（未選部位）')}${p.note ? '・' + esc(p.note) : ''}</div>
      <div class="meta">${when}・${tone}・${p.s.f0.toFixed(1)} Hz・差頻 ${p.s.delta} Hz・${esc(p.headset)}</div></div>
      <button data-act="apply">套用</button><button data-act="del" aria-label="刪除">刪除</button></li>`;
  }).join('');
}
$('#points').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = +b.closest('li').dataset.id, p = points.find(x => x.id === id); if (!p) return;
  if (b.dataset.act === 'apply') { Object.assign(S, p.s); syncAll(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  if (b.dataset.act === 'del' && confirm('刪除這筆共振點？')) {
    points = points.filter(x => x.id !== id); store(PKEY, points); renderPoints(); redraw();
  }
};
$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: '賽博雷音', exported: new Date().toISOString(), settings: S, points }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date(), ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = URL.createObjectURL(blob); a.download = `leiyin-${ymd}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

syncAll();
renderPoints();
