// 賽博雷音：介面
// 版本號：每次發布都要改這裡、index.html、engine.js 的 ?v=，避免手機用到快取的舊檔
import { F_MIN, F_MAX, formants, envelope, partialAmp, partialCount, bowlParts, tuneFormants, padPos, VOWELS } from './voice.js?v=0.3.1';
import { parseIAST, KEYS, hasHan, zhMap } from './chant.js?v=0.3.1';
const VERSION = '0.3.1';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const SKEY = 'leiyin-settings', PKEY = 'leiyin-points';
const PARTS = ['整體', '頭頂', '前額', '眉心', '鼻腔', '上顎', '喉嚨', '後腦', '左側', '右側', '胸口'];

/* ---------- 設定（集中在單一物件：存檔、套用紀錄、未來紀錄共用） ---------- */
const a0 = VOWELS.find(v => v.v === 'a');
const DEF = {
  mode: 'tone', f0: 200, delta: 4, x: a0.x, y: a0.y, nasal: 0, round: 0, tune: 0,
  chantText: '', rate: 3, loop: true, ox: 0, oy: 0,
  bright: 40, wobble: 40, strike: 0, knock: 50, mallet: 'soft',
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

// 口型 → 實際共振峰（含共振優先）。共振優先 0% 時就是原本的 formants()
function voiceTract() {
  const F = formants(S.x, S.y, S.round / 100);
  return tuneFormants(F, S.f0, S.tune / 100);
}
/* ---------- 念誦 ---------- */
let chant = parseIAST(S.chantText || ''), chantPos = 0, seekTo = 0, seekN = 0;
// 漢字讀音表：只有輸入漢字時才載入（約 66 KB），載過一次就留在記憶體
let zh = null, zhLoading = null, zhFailed = false;
function loadZh() {
  return zhLoading ||= fetch('./zh.json?v=' + VERSION).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => { zh = zhMap(j); zhFailed = false; return zh; })
    .catch(e => { zhLoading = null; zhFailed = true; throw e; });
}
// 念誦此刻的口型目標（加上觸控板的偏移）
function chantTarget() {
  const sg = chant.segs[chantPos] || [0.5, 0.5, 0, 0];
  return { x: clamp(sg[0] + S.ox, 0, 1), y: clamp(sg[1] + S.oy, 0, 1), nasal: Math.max(S.nasal / 100, sg[2]) };
}
// 此刻實際的共振峰：口型模式看手指位置，念誦模式看念到的音
function tractNow() {
  if (S.mode !== 'chant') return Object.assign(voiceTract(), { nasal: S.nasal / 100 });
  const c = chantTarget();
  return Object.assign(tuneFormants(formants(c.x, c.y, S.round / 100), S.f0, S.tune / 100), { nasal: c.nasal });
}
function engineParams() {
  const b = S.bal / 100;
  return {
    round: S.round / 100, tune: S.tune / 100, ox: S.ox, oy: S.oy, rate: S.rate, loop: S.loop,
    chantId: chant.id, seek: seekTo, seekN,
    mode: S.mode, f0: S.f0, delta: S.delta, F: voiceTract().F, nasal: S.nasal / 100, sharp: S.tune / 100,
    bright: S.bright / 100, wobble: S.wobble / 100, strike: S.strike,
    knock: S.knock / 100, mallet: S.mallet,
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
    numberOfInputs: 0, outputChannelCount: [2], processorOptions: Object.assign(engineParams(), { chantSegs: chant.segs }),
  });
  node.port.onmessage = e => {
    if ('pos' in e.data) setChantPos(e.data.pos);
    if (e.data.done && playing) stop(1.5, '念完了');
  };
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
  bindRange('tune', 'tune', v => v + '%'),
  bindRange('rate', 'rate', v => `每秒約 ${v.toFixed(1)} 音節`),
  bindRange('delta', 'delta', v => v.toFixed(1) + ' Hz' + (v >= 4 && v < 8 ? '（θ）' : v === 0 ? '（無節拍）' : '')),
  bindRange('bal', 'bal', v => v === 0 ? '置中' : v < 0 ? `偏左 ${-v}%` : `偏右 ${v}%`),
  bindRange('mix', 'mix', v => v + '%'),
  bindRange('bright', 'bright', v => v + '%'),
  bindRange('wobble', 'wobble', v => v + '%'),
  bindRange('knock', 'knock', v => v + '%'),
];
const syncVol = bindRange('vol', 'vol', v => v + '%');
$('#vol').addEventListener('input', () => { if (playing) push({ gain: volGain(), fade: 0.05 }); });

$('#limit').onchange = e => {
  S.limit = +e.target.value; saveSoon();
  if (playing) endAt = Date.now() + S.limit * 60000;
};
$('#strike').onchange = e => { S.strike = +e.target.value; changed(); };
$('#mallet').onchange = e => { S.mallet = e.target.value; changed(); };
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
function setOffset(x, y) { S.ox = clamp(x, -0.5, 0.5); S.oy = clamp(y, -0.5, 0.5); changed(); }
pad.addEventListener('pointerdown', e => {
  pad.setPointerCapture(e.pointerId);
  const r = padRect();
  // 念誦：拖動＝整條口型路徑的偏移（相對移動，不跳到手指位置）
  if (S.mode === 'chant') drag = { off: true, px: e.clientX, py: e.clientY, x: S.ox, y: S.oy, w: r.width, h: r.height };
  else if (S.fine) drag = { px: e.clientX, py: e.clientY, x: S.x, y: S.y, w: r.width, h: r.height };
  else { drag = { abs: true }; setXY((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }
});
pad.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.off) { const m = S.fine ? 0.15 : 0.6; setOffset(drag.x + (e.clientX - drag.px) / drag.w * m, drag.y + (e.clientY - drag.py) / drag.h * m); }
  else if (drag.abs) { const r = padRect(); setXY((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }
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
  if (S.mode === 'chant') setOffset(S.ox + d[0], S.oy + d[1]);
  else setXY(S.x + d[0], S.y + d[1]);
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
  // 共振優先：實際口型（被拉向泛音後）畫空心圈，和手指位置連一條線
  if (S.tune > 0 && S.mode === 'voice') {
    const t = voiceTract(), r = 1 - 0.08 * S.round / 100, r2 = 1 - 0.30 * S.round / 100;
    const q = padPos(t.F[0] / r, t.F[1] / r2), qx = clamp(q.x, 0, 1) * w, qy = clamp(q.y, 0, 1) * h;
    g.strokeStyle = acc; g.lineWidth = 1.5; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(S.x * w, S.y * h); g.lineTo(qx, qy); g.stroke(); g.setLineDash([]);
    g.lineWidth = 2; g.beginPath(); g.arc(qx, qy, 8, 0, Math.PI * 2); g.stroke();
  }
  if (S.mode === 'chant') { drawChantPath(g, w, h, acc); return; }
  // 目前位置
  const cx = S.x * w, cy = S.y * h;
  g.strokeStyle = acc; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, 14, 0, Math.PI * 2); g.stroke();
  g.fillStyle = acc; g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.fill();
}

// 念誦：這一句的母音路徑（淡線）＋此刻念到的口型（圓點）
function drawChantPath(g, w, h, acc) {
  const sg = chant.segs[chantPos];
  if (sg) {
    const pts = chant.segs.filter(z => z[5] === sg[5] && z[3] >= 0.9).map(z => [clamp(z[0] + S.ox, 0, 1) * w, clamp(z[1] + S.oy, 0, 1) * h]);
    g.strokeStyle = acc; g.globalAlpha = 0.35; g.lineWidth = 2; g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, x, y)); g.stroke(); g.globalAlpha = 1;
  }
  const c = chantTarget(), cx = c.x * w, cy = c.y * h;
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
  if (S.mode === 'voice' || S.mode === 'chant') {
    const tn = tractNow(); p.F = tn.F; p.nasal = tn.nasal;
    let mx = 0; const env = [];
    for (let i = 0; i <= 400; i++) { const f = 20 + i / 400 * (FMAXV - 20); const e = envelope(f, p.F, p.nasal, p.sharp); env.push([f, e]); mx = Math.max(mx, e); }
    g.strokeStyle = mute; g.lineWidth = 1.5; g.beginPath();
    env.forEach(([f, e], i) => { const db = Math.max(floorDb, 20 * Math.log10(e / mx)); (i ? g.lineTo : g.moveTo).call(g, X(f), Y(db)); });
    g.stroke();
    const K = partialCount(S.f0, 48000); let am = 0; const amps = [];
    for (let k = 1; k <= K; k++) { const a = partialAmp(k, S.f0, p.F, p.nasal, p.sharp); amps.push(a); am = Math.max(am, a); }
    const t = tn, lit = new Set(t.k.filter((k, i) => t.hit[i]));
    amps.forEach((a, i) => {
      const f = (i + 1) * S.f0; if (f > FMAXV) return;
      const db = Math.max(floorDb, 20 * Math.log10(a / am)), on = lit.has(i + 1);
      g.strokeStyle = on ? css('--dot') : acc; g.lineWidth = on ? 4 : 2;
      g.beginPath(); g.moveTo(X(f), Y(floorDb)); g.lineTo(X(f), Y(db)); g.stroke();
      if (on) { g.fillStyle = css('--dot'); g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('H' + (i + 1), X(f) + 4, 16); }
    });
    g.fillStyle = mute; g.textAlign = 'left'; g.textBaseline = 'top';
    p.F.forEach((F, i) => g.fillText('F' + (i + 1), X(F) + 3, 2));
  } else if (S.mode === 'bowl') {
    const parts = bowlParts(S.f0, p.bright, p.wobble);
    const am = Math.max(...parts.map(c => c.a));
    g.strokeStyle = acc; g.lineWidth = 2;
    for (const c of parts) {
      if (c.a <= 0 || c.f > FMAXV) continue;
      const db = Math.max(floorDb, 20 * Math.log10(c.a / am));
      g.beginPath(); g.moveTo(X(c.f), Y(floorDb)); g.lineTo(X(c.f), Y(db)); g.stroke();
    }
    g.fillStyle = mute; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText('缽的泛音：不是整數倍', X(S.f0) + 4, 2);
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
  const voice = S.mode === 'voice', bowl = S.mode === 'bowl', chanting = S.mode === 'chant';
  pad.classList.toggle('dim', !(voice || chanting));
  $('#chantCard').hidden = !chanting;
  $('#bowlCard').hidden = !bowl;
  $('#strikeOpts').hidden = !(S.strike > 0);
  const title = bowl ? '缽音747' : '賽博雷音';   // 頌缽模式換名字，切走換回來
  document.title = title; $('.top h1').textContent = title;
  $('#voiceCard').hidden = bowl;
  $('#toneNote').hidden = S.mode !== 'tone';
  updatePadOut();
  redraw();
}
function updatePadOut() {
  const t = tractNow(), [F1, F2] = t.F, tag = i => t.hit[i] ? `（對準 H${t.k[i]}）` : '';
  const fs = `F1 ${Math.round(F1)}${tag(0)}・F2 ${Math.round(F2)}${tag(1)} Hz`;
  if (S.mode === 'chant') {
    const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
    $('#padOut').textContent = `${fs}・偏移 開口 ${sgn(S.oy)}、舌後 ${sgn(S.ox)}`;
  } else {
    const nv = nearestVowel();
    $('#padOut').textContent = `${fs}・${nv.d < 0.06 ? '' : '最接近 '}${nv.v}`;
  }
}
function syncAll() {
  setF0(S.f0, true);
  syncers.forEach(f => f());
  syncVol();
  $('#limit').value = String(S.limit);
  $('#headset').value = S.headset;
  $('#strike').value = String(S.strike);
  $('#mallet').value = S.mallet;
  $('#fine').checked = !!S.fine;
  $('#loop').checked = !!S.loop;
  $('#chantText').value = S.chantText || '';
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
  if (S.mode === 'chant') {
    const { mode, f0, delta, nasal, round, tune, ox, oy, rate, bal, mix } = S, sg = chant.segs[chantPos];
    return { mode, f0, delta, nasal, round, tune, ox, oy, rate, bal, mix, chant: { id: chant.id, line: sg ? sg[5] : 0 } };   // 不存經文
  }
  const { mode, f0, delta, x, y, nasal, round, tune, bright, wobble, strike, knock, mallet, bal, mix } = S;
  return { mode, f0, delta, x, y, nasal, round, tune, bright, wobble, strike, knock, mallet, bal, mix };
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
    const tone = p.s.mode === 'chant' ? `念誦 第 ${p.s.chant.line + 1} 句${p.s.chant.id === chant.id ? '' : '（別段文字）'}` : p.s.mode === 'voice' ? `口型 ${vowelLabel(p.s)}${p.s.tune ? `・共振優先 ${p.s.tune}%` : ''}` : p.s.mode === 'bowl' ? '頌缽' : '單音';
    return `<li data-id="${p.id}"><div class="info"><div>${esc(p.parts.join('、') || '（未選部位）')}${p.note ? '・' + esc(p.note) : ''}</div>
      <div class="meta">${when}・${tone}・${p.s.f0.toFixed(1)} Hz・差頻 ${p.s.delta} Hz・${esc(p.headset)}</div></div>
      <button data-act="apply">套用</button><button data-act="del" aria-label="刪除">刪除</button></li>`;
  }).join('');
}
$('#points').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = +b.closest('li').dataset.id, p = points.find(x => x.id === id); if (!p) return;
  if (b.dataset.act === 'apply' && p.s.chant) {
    const { chant: c, ...rest } = p.s;
    Object.assign(S, { ox: 0, oy: 0, rate: DEF.rate }, rest); syncAll();
    const ln = chant.lines[c.line];
    if (c.id === chant.id && ln) seekChant(ln.seg);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (b.dataset.act === 'apply') { Object.assign(S, { tune: DEF.tune, bright: DEF.bright, wobble: DEF.wobble, strike: DEF.strike, knock: DEF.knock, mallet: DEF.mallet }, p.s); syncAll(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  if (b.dataset.act === 'del' && confirm('刪除這筆共振點？')) {
    points = points.filter(x => x.id !== id); store(PKEY, points); renderPoints(); redraw();
  }
};
$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: '賽博雷音', exported: new Date().toISOString(), settings: Object.assign({}, S, { chantText: undefined }), points }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date(), ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = URL.createObjectURL(blob); a.download = `leiyin-${ymd}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

syncAll();
renderPoints();

/* ---------- 念誦介面 ---------- */
const view = $('#chantView');
let spanOfSeg = [], lastSpan = -1, lastLine = -1;
function renderChant() {
  const text = (S.chantText || '').normalize('NFC');
  spanOfSeg = new Array(chant.segs.length).fill(-1);
  let html = '', n = 0;
  chant.lines.forEach((ln, L) => {
    const end = L + 1 < chant.lines.length ? chant.lines[L + 1].seg : chant.segs.length;
    let cur = ln.s, part = '';
    for (let j = ln.seg; j < end; j++) {
      const m = chant.meta[j];
      if (m.s >= ln.e || m.s < cur) { spanOfSeg[j] = n - 1; continue; }
      part += esc(text.slice(cur, m.s)) + `<span id="cs${n}">${esc(text.slice(m.s, Math.min(m.e, ln.e)))}</span>`;
      spanOfSeg[j] = n++; cur = Math.min(m.e, ln.e);
    }
    part += esc(text.slice(cur, ln.e));
    html += `<div class="cl" data-line="${L}"><span class="no">${L + 1}</span>${part}</div>`;
  });
  const blank = !(S.chantText || '').trim(), waiting = chant.han && !zh;
  const note = waiting ? (zhFailed ? '中文讀音載入失敗，請連上網路後再改一下文字。' : '正在載入中文讀音…')
    : chant.unknown ? `有 ${chant.unknown} 個字查不到讀音，已略過；可以在方括號裡寫拼音指定，例如 [na mo]。` : '';
  view.innerHTML = (html || (blank ? '<p class="muted small">還沒有文字。</p>'
    : waiting ? '' : '<p class="muted small">這些字認不得。目前認得：漢字（國語）、梵文轉寫（IAST）、方括號裡的拼音。</p>'))
    + (note ? `<p class="muted small">${note}</p>` : '');
  lastSpan = -1; lastLine = -1;
  setChantPos(Math.min(chantPos, Math.max(0, chant.segs.length - 1)));
}
function setChantPos(i) {
  chantPos = i;
  const sg = chant.segs[i];
  const sp = spanOfSeg[i] ?? -1;
  if (sp !== lastSpan) {
    if (lastSpan >= 0) { const o = $('#cs' + lastSpan); if (o) o.classList.remove('on'); }
    if (sp >= 0) { const o = $('#cs' + sp); if (o) o.classList.add('on'); }
    lastSpan = sp;
  }
  const L = sg ? sg[5] : -1;
  if (L !== lastLine) {
    $$('#chantView .cl.cur').forEach(x => x.classList.remove('cur'));
    const el = view.querySelector(`.cl[data-line="${L}"]`);
    if (el) { el.classList.add('cur'); view.scrollTop = el.offsetTop - view.clientHeight / 3; }
    lastLine = L;
  }
  if (S.mode === 'chant') { updatePadOut(); redraw(); }
}
function seekChant(seg) { seekTo = seg; seekN++; push(); setChantPos(seg); }
view.onclick = e => { const el = e.target.closest('.cl'); if (el) { const ln = chant.lines[+el.dataset.line]; if (ln) seekChant(ln.seg); } };
$('#chantRestart').onclick = () => seekChant(0);
$('#offsetZero').onclick = () => setOffset(0, 0);
$('#loop').onchange = e => { S.loop = e.target.checked; changed(); };
let chantTimer = 0;
function chantInput() {
  clearTimeout(chantTimer);
  chantTimer = setTimeout(() => { S.chantText = $('#chantText').value; applyChantText(); }, 500);
}
// 重新解析文字；有漢字而讀音表還沒載入時，先載入再解析一次
function applyChantText() {
  chant = parseIAST(S.chantText || '', zh); chantPos = 0; seekTo = 0; seekN++;
  if (node) node.port.postMessage({ chantSegs: chant.segs, chantId: chant.id, seek: 0, seekN });
  renderChant(); changed();
  if (!zh && hasHan(S.chantText)) loadZh().then(applyChantText, () => renderChant());
}
$('#chantText').oninput = chantInput;
$('#keys').innerHTML = KEYS.map(k => `<button type="button">${k}</button>`).join('');
$('#keys').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const ta = $('#chantText');
  ta.setRangeText(b.textContent, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus(); chantInput();
};
renderChant();
if (hasHan(S.chantText)) loadZh().then(applyChantText, () => renderChant());
