// 賽博雷音：口型與聲道響應。主執行緒（畫圖）與音訊執行緒（合成）共用。

export const F_MIN = 40, F_MAX = 1000;          // 共振頻率（單音音高／口型基頻）
export const F1_MIN = 250, F1_MAX = 900;        // 第一共振峰：閉口 → 開口
export const F2_FRONT = 2500, F2_BACK = 700;    // 第二共振峰：舌前 → 舌後

// 觸控板座標 (x: 0 舌前 → 1 舌後, y: 0 閉口 → 1 開口) 與圓唇 (0–1) → [F1, F2, F3]
export function formants(x, y, round) {
  let F1 = F1_MIN * Math.pow(F1_MAX / F1_MIN, y);
  let F2 = F2_FRONT * Math.pow(F2_BACK / F2_FRONT, x);
  let F3 = 2400 + 600 * (1 - x);
  F1 *= 1 - 0.08 * round;
  F2 *= 1 - 0.30 * round;
  F3 *= 1 - 0.12 * round;
  if (F2 < F1 + 150) F2 = F1 + 150;   // 三角形外的角落：不擋，但保持共振峰順序
  if (F3 < F2 + 200) F3 = F2 + 200;
  return [F1, F2, F3];
}

export function padPos(F1, F2) {
  return {
    x: Math.log(F2 / F2_FRONT) / Math.log(F2_BACK / F2_FRONT),
    y: Math.log(F1 / F1_MIN) / Math.log(F1_MAX / F1_MIN),
  };
}

// 五母音地標（成年男性典型值，未圓唇）
export const VOWELS = [['i', 270, 2300], ['e', 450, 1900], ['a', 730, 1100], ['o', 500, 850], ['u', 300, 870]]
  .map(([v, F1, F2]) => ({ v, F1, F2, ...padPos(F1, F2) }));

// 二階共振器的幅度響應，f = 0 時為 1
function res(f, F, B) {
  const b = B / 2;
  return (F * F + b * b) / Math.sqrt(((f - F) ** 2 + b * b) * ((f + F) ** 2 + b * b));
}

// 頻率 f 處的聲道響應（相對值）。F = [F1, F2, F3]，nasal 0–1，sharp 0–1（共振優先時共振峰變窄）
export function envelope(f, F, nasal, sharp = 0) {
  const w = 1 - 0.5 * sharp;
  let h = res(f, F[0], 80 * (1 + 1.5 * nasal) * w) * res(f, F[1], 90 * w) * res(f, F[2], 150 * w);
  if (nasal > 0) {
    const zero = 1 - 0.85 * Math.exp(-(((f - 1000) / 250) ** 2));   // 鼻腔反共振
    h *= (1 - nasal) + nasal * res(f, 270, 120) * zero;              // 鼻腔共振
  }
  return h;
}

// 第 k 個泛音（k 從 1 起）的相對振幅：聲源 1/k × 聲道響應
export function partialAmp(k, f0, F, nasal, sharp = 0) {
  return envelope(k * f0, F, nasal, sharp) / k;
}

/* ---------- 共振優先 ----------
   把 F1、F2 往最近的泛音（k × f0）拉，p = 0 不動（咬字最清楚），p = 1 正好壓在泛音上（該泛音被放大最多，母音變形）。
   回傳調整後的 [F1, F2, F3]，以及兩個共振峰各自最近的泛音編號與是否「對準」（落在共振峰半頻寬內）。 */
export const ALIGN_HALF_BW = [40, 45];   // 對準的判定：距離小於共振峰半頻寬（Hz）
export function tuneFormants(F, f0, p) {
  const near = f => Math.max(1, Math.round(f / f0));
  let k1 = near(F[0]), k2 = near(F[1]);
  if (k2 <= k1) k2 = k1 + 1;                          // 兩個共振峰不搶同一根泛音
  const pull = (f, k) => f * Math.pow(k * f0 / f, p);  // 對數空間內插
  const T = [pull(F[0], k1), pull(F[1], k2), F[2]];
  if (T[2] < T[1] + 200) T[2] = T[1] + 200;
  const hit = [Math.abs(T[0] - k1 * f0) < ALIGN_HALF_BW[0], Math.abs(T[1] - k2 * f0) < ALIGN_HALF_BW[1]];
  return { F: T, k: [k1, k2], hit };
}

/* ---------- 頌缽 ----------
   缽的泛音不是整數倍（典型手工頌缽的模態比例約 1 : 2.76 : 5.18 : 8.16 …），這是它和音叉、人聲最大的差別。
   每個模態其實是兩個靠得很近的頻率（缽不完全對稱），兩者互相拍出「嗡—嗡—」的慢顫動。
   回傳固定長度的成分表（每模態兩個：主峰、雙峰），讓引擎的振盪器編號不會跳動。 */
export const BOWL_RATIOS = [1, 2.76, 5.18, 8.16, 11.6, 15.5];
export const BOWL_TAU = 18;   // 敲擊後基音的衰減時間常數（秒），越高的泛音衰減越快
export function bowlParts(f0, bright, wobble) {
  const p = 1.8 - 1.2 * bright;   // 亮度：高泛音隨頻率比衰減的斜率
  const out = [];
  BOWL_RATIOS.forEach((r, i) => {
    const a = Math.pow(r, -p);
    const split = wobble * (0.5 + 0.3 * i);   // 雙峰間距（Hz）＝顫動速度，基音最慢
    const tau = BOWL_TAU / Math.pow(r, 0.8);
    out.push({ f: r * f0 - split / 2, a, tau });
    out.push({ f: r * f0 + split / 2, a: a * 0.7 * wobble, tau });
  });
  return out;
}

export const MAX_PARTIALS = 128;   // 基頻 40 Hz 時仍能涵蓋到 5000 Hz
export function partialCount(f0, sampleRate) {
  return Math.max(1, Math.min(MAX_PARTIALS, Math.floor(Math.min(5000, sampleRate * 0.45) / f0)));
}
