// 賽博雷音：合成引擎（AudioWorklet）
// 加法合成。右耳每個成分都比左耳剛好高 delta Hz（整組平移），所以不論音色如何，每個成分都貢獻同一個差頻。
import { partialAmp, partialCount, MAX_PARTIALS } from './voice.js?v=0.1.1';

const TAU = Math.PI * 2;

function softClip(x) {
  const a = Math.abs(x);
  if (a <= 0.8) return x;
  return Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
}

class Engine extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // 目標參數（由主執行緒更新）
    this.p = { mode: 'tone', f0: 200, delta: 4, F: [730, 1100, 2700], nasal: 0, gL: 1, gR: 1, mix: 0, gain: 0, fade: 0.05 };
    Object.assign(this.p, (options && options.processorOptions) || {});
    // 平滑中的實際值
    this.f0 = this.p.f0; this.delta = this.p.delta;
    this.gain = 0; this.gL = this.p.gL; this.gR = this.p.gR; this.mix = this.p.mix;
    this.amp = new Float64Array(MAX_PARTIALS);
    this.tgt = new Float64Array(MAX_PARTIALS);
    // 每個泛音的旋轉振盪器狀態（cos, sin），左右初始相位相同
    this.reL = new Float64Array(MAX_PARTIALS); this.imL = new Float64Array(MAX_PARTIALS);
    this.reR = new Float64Array(MAX_PARTIALS); this.imR = new Float64Array(MAX_PARTIALS);
    for (let k = 0; k < MAX_PARTIALS; k++) {
      const ph = Math.random() * TAU;   // 隨機相位：降低多泛音疊加時的峰值
      this.reL[k] = this.reR[k] = Math.cos(ph);
      this.imL[k] = this.imR[k] = Math.sin(ph);
    }
    this.port.onmessage = e => Object.assign(this.p, e.data);
  }

  osc(buf, re, im, k, w, a, da, n) {
    const c = Math.cos(w), s = Math.sin(w);
    let x = re[k], y = im[k];
    for (let i = 0; i < n; i++) {
      a += da;
      buf[i] += a * y;
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
    }
    const m = 1 / Math.hypot(x, y);
    re[k] = x * m; im[k] = y * m;
  }

  process(_inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1];
    if (!L || !R) return true;
    const n = L.length, sr = sampleRate, p = this.p;
    const k40 = 1 - Math.exp(-n / (0.04 * sr));                       // 40 ms 平滑
    const kg = 1 - Math.exp(-n / (Math.max(0.005, p.fade) * sr));     // 音量淡入淡出

    this.f0 += (p.f0 - this.f0) * k40;
    this.delta += (p.delta - this.delta) * k40;
    const g0 = this.gain, g1 = g0 + (p.gain - g0) * kg; this.gain = g1;
    const l0 = this.gL, l1 = l0 + (p.gL - l0) * k40; this.gL = l1;
    const r0 = this.gR, r1 = r0 + (p.gR - r0) * k40; this.gR = r1;
    const m0 = this.mix, m1 = m0 + (p.mix - m0) * k40; this.mix = m1;

    // 各泛音目標振幅，正規化成每耳 RMS 0.25（換口型時響度大致不變）
    const tgt = this.tgt;
    tgt.fill(0);
    let K;
    if (p.mode === 'tone') { tgt[0] = 1; K = 1; }
    else {
      K = partialCount(this.f0, sr);
      for (let k = 1; k <= K; k++) tgt[k - 1] = partialAmp(k, this.f0, p.F, p.nasal);
    }
    let ss = 0;
    for (let k = 0; k < K; k++) ss += tgt[k] * tgt[k];
    const norm = ss > 0 ? 0.25 / Math.sqrt(ss / 2) : 0;

    L.fill(0); R.fill(0);
    for (let k = 0; k < MAX_PARTIALS; k++) {
      const a0 = this.amp[k];
      let a1 = a0 + (tgt[k] * norm - a0) * k40;
      const fl = (k + 1) * this.f0, fr = fl + this.delta;
      if (fr >= sr * 0.49) a1 = 0;
      this.amp[k] = a1;
      if (a0 < 1e-7 && a1 < 1e-7) continue;
      const da = (a1 - a0) / n;
      this.osc(L, this.reL, this.imL, k, TAU * fl / sr, a0, da, n);
      this.osc(R, this.reR, this.imR, k, TAU * fr / sr, a0, da, n);
    }

    // 混合度（進階）、左右強度、音量
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;
      const g = g0 + (g1 - g0) * t, m = m0 + (m1 - m0) * t;
      const gl = l0 + (l1 - l0) * t, gr = r0 + (r1 - r0) * t;
      const l = L[i], r = R[i], d = 1 + m;
      L[i] = softClip(g * gl * (l + m * r) / d);
      R[i] = softClip(g * gr * (r + m * l) / d);
    }
    return true;
  }
}

registerProcessor('leiyin-engine', Engine);
