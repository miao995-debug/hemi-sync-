// 賽博雷音：念誦的文字解析（主執行緒）
// 梵文轉寫（IAST）→ 一串「段」：每段是口型目標＋長短＋音量，引擎照時間推進。
// 這裡只有發音規則（語言學知識），不含任何經文；經文由使用者自己輸入，只存在本機。
import { padPos } from './voice.js?v=0.3.0';

// 時間單位：1 單位 = 1 / 念速 秒（念速＝每秒約幾個音節）
const D = { short: 0.7, long: 1.5, stop: 0.3, asp: 0.15, nasal: 0.35, semi: 0.3, sib: 0.35, h: 0.3, anus: 0.8, visarga: 0.4 };

// 母音：[F1, F2] → 觸控板座標
const V = {
  a: [680, 1250], 'ā': [730, 1100], i: [270, 2300], 'ī': [270, 2300], u: [300, 870], 'ū': [300, 870],
  e: [420, 2000], o: [450, 850], 'ṛ': [450, 1350], 'ṝ': [450, 1350], 'ḷ': [430, 1250], 'ḹ': [430, 1250],
};
const LONG = new Set(['ā', 'ī', 'ū', 'e', 'o', 'ṝ', 'ḹ', 'ai', 'au']);

// 子音：[F1, F2]（口型滑入的方向）、音量、長短、鼻音
const PLACE = {
  velar: [300, 1500], palatal: [280, 2200], retroflex: [350, 1600], dental: [320, 1800], labial: [280, 800],
};
const C = {};
const stops = { velar: 'k g ṅ', palatal: 'c j ñ', retroflex: 'ṭ ḍ ṇ', dental: 't d n', labial: 'p b m' };
for (const [pl, s] of Object.entries(stops)) {
  const [unv, voi, nas] = s.split(' ');
  C[unv] = { F: PLACE[pl], g: 0.03, d: D.stop };
  C[voi] = { F: PLACE[pl], g: 0.25, d: D.stop };
  C[nas] = { F: PLACE[pl], g: 0.65, d: D.nasal, n: 1 };
  C[unv + 'h'] = { F: PLACE[pl], g: 0.03, d: D.stop, asp: 1 };
  C[voi + 'h'] = { F: PLACE[pl], g: 0.25, d: D.stop, asp: 1 };
}
Object.assign(C, {
  y: { F: [280, 2200], g: 0.8, d: D.semi }, r: { F: [400, 1300], g: 0.7, d: D.semi },
  l: { F: [380, 1200], g: 0.75, d: D.semi }, v: { F: [300, 850], g: 0.75, d: D.semi },
  'ś': { F: [300, 2100], g: 0.08, d: D.sib }, 'ṣ': { F: [330, 1600], g: 0.08, d: D.sib },
  s: { F: [320, 1800], g: 0.08, d: D.sib }, h: { F: [500, 1500], g: 0.35, d: D.h },
});
C.w = C.v;

const pos = ([F1, F2]) => { const p = padPos(F1, F2); return [Math.min(1, Math.max(0, p.x)), Math.min(1, Math.max(0, p.y))]; };

// 簡單雜湊：紀錄只存「這段文字的識別碼＋第幾句」，不存文字本身
export function textId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/* 解析。回傳
   segs: [[x, y, nasal, gain, dur, line]]（給引擎）
   meta: [{ s, e, line }]（每段對應原文的位置，給畫面標亮）
   lines: [{ s, e, seg }]（每句在原文的範圍與第一段的編號） */
export function parseIAST(src) {
  const text = src.normalize('NFC');
  const t = text.toLowerCase().replace(/ṁ/g, 'ṃ').replace(/m̐/g, 'ṃ ');   // 保持字數不變，原文位置才對得上
  const segs = [], meta = [], lines = [];
  let line = 0, lineStart = 0, lineSeg = 0, last = pos(V.a);
  const push = (xy, n, g, d, s, e) => { segs.push([xy[0], xy[1], n, g, d, line]); meta.push({ s, e, line }); if (g > 0.5) last = xy; };
  // 一句結束。只有停頓、沒有字的「句」（例如 | 後面緊接換行）併進上一句，不另成一行
  const endLine = (e) => {
    if (segs.length > lineSeg) {
      if (t.slice(lineStart, e).replace(/[\s|।॥/,;.~]/g, '') || !lines.length) lines.push({ s: lineStart, e, seg: lineSeg });
      else for (let j = lineSeg; j < segs.length; j++) { segs[j][5] = lines.length - 1; meta[j].line = lines.length - 1; }
    }
    line = lines.length; lineSeg = segs.length;
  };
  let i = 0;
  while (i < t.length) {
    const ch = t[i], two = t.slice(i, i + 2);
    if (ch === '\n') { push(last, 0, 0, 1, i, i + 1); endLine(i); i++; lineStart = i; continue; }
    if (two === '||' || ch === '॥') { push(last, 0, 0, 3, i, i + (ch === '॥' ? 1 : 2)); i += ch === '॥' ? 1 : 2; endLine(i); lineStart = i; continue; }
    if (ch === '|' || ch === '।' || ch === '/') { push(last, 0, 0, 1.5, i, i + 1); i++; endLine(i); lineStart = i; continue; }
    if (ch === ',' || ch === ';' || ch === '.') { push(last, 0, 0, 0.6, i, i + 1); i++; continue; }
    if (ch === '~') { if (segs.length) segs[segs.length - 1][4] += 1; i++; continue; }   // 拉長前一個音
    // 雙母音
    if (two === 'ai' || two === 'au') {
      const a = pos(V.a), b = pos(two === 'ai' ? V.i : V.u);
      push(a, 0, 1, D.long * 0.55, i, i + 2); push(b, 0, 1, D.long * 0.45, i, i + 2); i += 2; continue;
    }
    if (V[ch]) { push(pos(V[ch]), 0, 1, LONG.has(ch) ? D.long : D.short, i, i + 1); i++; continue; }
    if (ch === 'ṃ') { push(pos(PLACE.labial), 1, 0.7, D.anus, i, i + 1); i++; continue; }   // 鼻音尾：閉唇＋鼻腔共鳴
    if (ch === 'ḥ') { push(last, 0, 0.3, D.visarga, i, i + 1); i++; continue; }            // 帶氣的尾音：前一個口型、變弱
    // 送氣子音（kh、gh …）先比對兩個字
    const c2 = C[two] && two[1] === 'h' ? two : null;
    const c = c2 ? C[c2] : C[ch];
    if (c) {
      const len = c2 ? 2 : 1, xy = pos(c.F);
      push(xy, c.n || 0, c.g, c.d, i, i + len);
      if (c.asp) push(xy, 0, 0.3, D.asp, i, i + len);
      i += len; continue;
    }
    i++;   // 空白、數字、不認得的字：略過（念誦本來就連綿，字間不停）
  }
  endLine(t.length);
  return { segs, meta, lines, id: textId(text.trim()) };
}

// 介面上的特殊字母按鈕
export const KEYS = ['ā', 'ī', 'ū', 'ṛ', 'ṃ', 'ḥ', 'ṅ', 'ñ', 'ṭ', 'ḍ', 'ṇ', 'ś', 'ṣ', '~', '|'];
