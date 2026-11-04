// 賽博雷音：合成引擎（AudioWorklet）
// 加法合成。右耳每個成分都比左耳剛好高 delta Hz（整組平移），所以不論音色如何，每個成分都貢獻同一個差頻。
import { partialAmp, partialCount, bowlParts, MAX_PARTIALS } from './voice.js?v=0.2.0';

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
    this.p = {
      mode: 'tone', f0: 200, delta: 4, F: [730, 1100, 2700], nasal: 0,
      bright: 0.4, wobble: 0.4, strike: 0,
      gL: 1, gR: 1, mix: 0, gain: 0, fade: 0.05,
    };
    Object.assign(this.p, (options && options.processorOptions) || {});
    this.cur = this.p.mode;   // 實際在發聲的模式；切換時先淡出再換，避免各成分頻率瞬間跳動
    // 平滑中的實際值
    this.f0 = this.p.f0; this.delta = this.p.delta;
    this.gain = 0; this.gL = this.p.gL; this.gR = this.p.gR; this.mix = this.p.mix;
    this.amp = new Float64Array(MAX_PARTIALS);
    this.tgt = new Float64Array(MAX_PARTIALS);
    this.fq = new Float64Array(MAX_PARTIALS);
    // 頌缽敲擊：每個成分的衰減包絡、距上次敲擊的秒數
    this.env = new Float64Array(MAX_PARTIALS).fill(1);
    this.sinceStrike = 0; this.lastStrike = this.p.strike;
    // 每個成分的旋轉振盪器狀態（cos, sin），左右初始相位相同
    this.reL = new Float64Array(MAX_PARTIALS); this.imL = new Float64Array(MAX_PARTIALS);
    this.reR = new Float64Array(MAX_PARTIALS); this.imR = new Float64Array(MAX_PARTIALS);
    for (let k = 0; k < MAX_PARTIALS; k++) {
      const ph = Math.random() * TAU;   // 隨機相位：降低多成分疊加時的峰值
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
    const n = L.length, sr = sampleRate, p = this.p, dt = n / sr;
    const k40 = 1 - Math.exp(-n / (0.04 * sr));                       // 40 ms 平滑
    const kg = 1 - Math.exp(-n / (Math.max(0.005, p.fade) * sr));     // 音量淡入淡出

    this.f0 += (p.f0 - this.f0) * k40;
    this.delta += (p.delta - this.delta) * k40;
    const g0 = this.gain, g1 = g0 + (p.gain - g0) * kg; this.gain = g1;
    const l0 = this.gL, l1 = l0 + (p.gL - l0) * k40; this.gL = l1;
    const r0 = this.gR, r1 = r0 + (p.gR - r0) * k40; this.gR = r1;
    const m0 = this.mix, m1 = m0 + (p.mix - m0) * k40; this.mix = m1;

    // 各成分的頻率與目標振幅（依「實際在發聲」的模式）
    const tgt = this.tgt, fq = this.fq, env = this.env, mode = this.cur;
    tgt.fill(0); fq.fill(0);
    let bowl = null;
    if (mode === 'tone') { tgt[0] = 1; fq[0] = this.f0; }
    else if (mode === 'bowl') {
      bowl = bowlParts(this.f0, p.bright, p.wobble);
      for (let j = 0; j < bowl.length; j++) { tgt[j] = bowl[j].a; fq[j] = bowl[j].f; }
    } else {
      const K = partialCount(this.f0, sr);
      for (let k = 1; k <= K; k++) { tgt[k - 1] = partialAmp(k, this.f0, p.F, p.nasal); fq[k - 1] = k * this.f0; }
    }
    // 正規化成每耳 RMS 0.25（換音色、口型時響度大致不變）；用未衰減的振幅算，敲擊後的衰減才聽得出來
    let ss = 0;
    for (let k = 0; k < MAX_PARTIALS; k++) ss += tgt[k] * tgt[k];
    const norm = ss > 0 ? 0.25 / Math.sqrt(ss / 2) : 0;

    // 頌缽敲擊：strike 秒敲一次（0＝磨缽，持續發聲）
    if (bowl) {
      if (p.strike !== this.lastStrike) { this.lastStrike = p.strike; this.sinceStrike = 0; env.fill(1); }
      if (p.strike > 0) {
        this.sinceStrike += dt;
        if (this.sinceStrike >= p.strike) { this.sinceStrike = 0; env.fill(1); }
        else for (let j = 0; j < bowl.length; j++) env[j] *= Math.exp(-dt / bowl[j].tau);
      } else env.fill(1);
      for (let j = 0; j < bowl.length; j++) tgt[j] *= env[j];
    }

    const switching = p.mode !== this.cur, gate = switching ? 0 : norm;
    let peak = 0;
    L.fill(0); R.fill(0);
    for (let k = 0; k < MAX_PARTIALS; k++) {
      const a0 = this.amp[k];
      let a1 = a0 + (tgt[k] * gate - a0) * k40;
      const fl = fq[k], fr = fl + this.delta;
      if (fl <= 0 || fr >= sr * 0.49) a1 = 0;
      this.amp[k] = a1;
      if (a1 > peak) peak = a1;
      if (a0 < 1e-7 && a1 < 1e-7) continue;
      const da = (a1 - a0) / n;
      this.osc(L, this.reL, this.imL, k, TAU * fl / sr, a0, da, n);
      this.osc(R, this.reR, this.imR, k, TAU * fr / sr, a0, da, n);
    }
    if (switching && peak < 1e-4) {   // 舊音色淡完了，換新音色
      this.cur = p.mode; this.amp.fill(0); env.fill(1); this.sinceStrike = 0;
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
