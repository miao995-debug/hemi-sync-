// 賽博雷音：念誦的文字解析（主執行緒）
// 梵文轉寫（IAST）或漢字（國語讀音）→ 一串「段」：每段是口型目標＋長短＋音量，引擎照時間推進。
// 這裡只有發音規則（語言學知識），不含任何經文；經文由使用者自己輸入，只存在本機。
// 漢字讀音表（zh.json，取自 Unicode Unihan）由介面在需要時才載入，再傳進來。
import { padPos } from './voice.js?v=0.3.1';

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

/* ---------- 國語 ----------
   漢字 → 無調拼音（查表）→ 聲母＋韻母 → 口型段。聲調不管（基頻固定）。
   一個字大約 1 單位，和「每秒約幾個音節」的念速一致。 */
const HAN = /[㐀-鿿豈-﫿]/;
export const hasHan = s => HAN.test(s || '');
// 讀音表 { 拼音: '字字字…' } → Map(字 → 拼音)
export function zhMap(json) {
  const m = new Map();
  for (const [py, cs] of Object.entries(json)) if (py !== '_') for (const c of cs) m.set(c, py);
  return m;
}
// 韻母裡的音：[F1, F2]
const ZV = {
  a: [700, 1250], A: [680, 1550], B: [700, 1050],      // a；an 的前 a；ang 的後 a
  o: [480, 850], E: [480, 1150], e: [450, 1900],      // o；單獨的 e [ɤ]；ei 的 e
  ɛ: [550, 1900], ə: [500, 1400], Q: [500, 1150],     // ie／üe 的 e；en 的 e；eng 的 e
  ʊ: [400, 850], r: [550, 1400],                      // ong；er
  i: [270, 2300], u: [300, 870], v: [270, 1900],      // i；u；ü（前高圓唇，F2 降一點）
  I: [350, 2100], U: [380, 900],                      // 複韻母的收尾（滑向 i／u）
  Z: [350, 1400], R: [380, 1550],                     // 舌尖元音：zi ci si／zhi chi shi ri
  n: PLACE.dental, ŋ: PLACE.velar,                    // 鼻音韻尾
};
// 韻母 → 音的順序。x- 是介音（短），I U 是收尾，n ŋ 是鼻音韻尾，其餘是主要母音
const FIN = {
  a: 'a', o: 'o', e: 'E', 'ê': 'ɛ', ai: 'a I', ei: 'e I', ao: 'a U', ou: 'o U',
  an: 'A n', en: 'ə n', ang: 'B ŋ', eng: 'Q ŋ', ong: 'ʊ ŋ', er: 'r',
  i: 'i', ia: 'i- a', io: 'i- o', ie: 'i- ɛ', iao: 'i- a U', iou: 'i- o U', ian: 'i- ɛ n', in: 'i n',
  iang: 'i- B ŋ', ing: 'i ŋ', iong: 'v- ʊ ŋ',
  u: 'u', ua: 'u- a', uo: 'u- o', uai: 'u- a I', uei: 'u- e I', uan: 'u- A n', uen: 'u- ə n',
  uang: 'u- B ŋ', ueng: 'u- Q ŋ',
  v: 'v', ve: 'v- ɛ', van: 'v- ɛ n', vn: 'v n',
  Z: 'Z', R: 'R',
};
// 聲母：送氣（p t k q ch c）多一小段氣聲；擦音幾乎無聲（這個合成器沒有噪音，只有泛音）
const zs = (pl, g, d, extra) => Object.assign({ F: PLACE[pl], g, d }, extra);
const ZI = {
  b: zs('labial', 0.1, 0.15), p: zs('labial', 0.03, 0.15, { asp: 1 }), m: zs('labial', 0.65, 0.22, { n: 1 }), f: { F: [300, 1000], g: 0.08, d: 0.22 },
  d: zs('dental', 0.1, 0.15), t: zs('dental', 0.03, 0.15, { asp: 1 }), n: zs('dental', 0.65, 0.22, { n: 1 }), l: { F: [380, 1200], g: 0.75, d: 0.2 },
  g: zs('velar', 0.1, 0.15), k: zs('velar', 0.03, 0.15, { asp: 1 }), h: zs('velar', 0.1, 0.22),
  j: zs('palatal', 0.1, 0.15), q: zs('palatal', 0.03, 0.15, { asp: 1 }), x: zs('palatal', 0.08, 0.22),
  zh: zs('retroflex', 0.1, 0.15), ch: zs('retroflex', 0.03, 0.15, { asp: 1 }), sh: zs('retroflex', 0.08, 0.22), r: { F: [350, 1500], g: 0.6, d: 0.2 },
  z: zs('dental', 0.1, 0.15), c: zs('dental', 0.03, 0.15, { asp: 1 }), s: zs('dental', 0.08, 0.22),
};
const SYL = 1.0, ZD = { med: 0.15, glide: 0.22, coda: 0.28, asp: 0.12 };

// 一個無調拼音 → [[F, 鼻音, 音量, 長短]]；認不得回傳 null
export function zhSyllable(py) {
  let s = py.toLowerCase().normalize('NFC').replace(/u:|ü/g, 'v').replace(/[1-5]$/, '');
  // y／w 只是拼寫，還原成介音
  if (s[0] === 'y') s = s[1] === 'i' ? s.slice(1) : s[1] === 'u' ? 'v' + s.slice(2) : 'i' + s.slice(1);
  else if (s[0] === 'w') s = s[1] === 'u' ? s.slice(1) : 'u' + s.slice(1);
  const ini = (/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcs])/.exec(s) || [''])[0];
  let f = s.slice(ini.length);
  if (ini && 'jqx'.includes(ini) && f[0] === 'u') f = 'v' + f.slice(1);   // ju qu xu 的 u 是 ü
  f = { iu: 'iou', ui: 'uei', un: 'uen', ue: 've' }[f] || f;
  if (f === 'i' && /^(z|c|s)$/.test(ini)) f = 'Z';
  if (f === 'i' && /^(zh|ch|sh|r)$/.test(ini)) f = 'R';
  const out = [];
  // 成音節的鼻音：m（呣）、n、ng（嗯）
  if ((ini === 'm' || ini === 'n') && (f === '' || f === 'g')) return [[f === 'g' ? ZV.ŋ : ZI[ini].F, 1, 0.7, SYL]];
  if (!FIN[f]) return null;
  let used = 0;
  if (ini) {
    const c = ZI[ini];
    out.push([c.F, c.n || 0, c.g, c.d]); used += c.d;
    if (c.asp) { out.push([c.F, 0, 0.3, ZD.asp]); used += ZD.asp; }
  }
  const parts = FIN[f].split(' ').map(k => {
    if (k.endsWith('-')) return { k: k[0], d: ZD.med };
    if (k === 'I' || k === 'U') return { k, d: ZD.glide };
    if (k === 'n' || k === 'ŋ') return { k, d: ZD.coda, n: 1, g: 0.65 };
    return { k, main: 1 };
  });
  for (const p of parts) if (!p.main) used += p.d;
  const mains = parts.filter(p => p.main).length || 1;
  for (const p of parts) out.push([ZV[p.k], p.n || 0, p.g || 1, p.main ? Math.max(0.3, (SYL - used) / mains) : p.d]);
  return out;
}

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
/* zh：漢字讀音表（zhMap 的結果）；還沒載入就傳 null，漢字先略過、記在 han 裡
   方括號裡寫拼音可以指定讀法，例如「[na mo]」（南無）；數字聲調可寫可不寫 */
export function parseIAST(src, zh = null) {
  const text = src.normalize('NFC');
  const t = text.toLowerCase().replace(/ṁ/g, 'ṃ').replace(/m̐/g, 'ṃ ');   // 保持字數不變，原文位置才對得上
  const segs = [], meta = [], lines = [];
  let line = 0, lineStart = 0, lineSeg = 0, last = pos(V.a), han = 0, unknown = 0;
  const push = (xy, n, g, d, s, e) => { segs.push([xy[0], xy[1], n, g, d, line]); meta.push({ s, e, line }); if (g > 0.5) last = xy; };
  const syl = (py, s, e) => { const z = zhSyllable(py); if (z) for (const [F, n, g, d] of z) push(pos(F), n, g, d, s, e); return !!z; };
  // 一句結束。只有停頓、沒有字的「句」（例如 | 後面緊接換行）併進上一句，不另成一行
  const endLine = (e) => {
    if (segs.length > lineSeg) {
      if (t.slice(lineStart, e).replace(/[\s|।॥/,;.~，、；：。！？!?]/g, '') || !lines.length) lines.push({ s: lineStart, e, seg: lineSeg });
      else for (let j = lineSeg; j < segs.length; j++) { segs[j][5] = lines.length - 1; meta[j].line = lines.length - 1; }
    }
    line = lines.length; lineSeg = segs.length;
  };
  let i = 0;
  while (i < t.length) {
    const ch = t[i], two = t.slice(i, i + 2);
    if (ch === '\n') { push(last, 0, 0, 1, i, i + 1); endLine(i); i++; lineStart = i; continue; }
    if (two === '||' || ch === '॥') { push(last, 0, 0, 3, i, i + (ch === '॥' ? 1 : 2)); i += ch === '॥' ? 1 : 2; endLine(i); lineStart = i; continue; }
    if (ch === '|' || ch === '।' || ch === '/' || '。！？!?'.includes(ch)) { push(last, 0, 0, 1.5, i, i + 1); i++; endLine(i); lineStart = i; continue; }
    if (ch === ',' || ch === ';' || ch === '.' || '，、；：'.includes(ch)) { push(last, 0, 0, 0.6, i, i + 1); i++; continue; }
    // 漢字：查國語讀音
    if (HAN.test(ch)) {
      han++;
      if (zh) { const py = zh.get(ch); if (!py || !syl(py, i, i + 1)) unknown++; }
      i++; continue;
    }
    // [拼音 拼音]：指定讀法
    if (ch === '[') {
      const j = t.indexOf(']', i);
      if (j > i) {
        const re = /[a-zü:]+[1-5]?/g; let m;
        const inner = t.slice(i + 1, j);
        while ((m = re.exec(inner))) syl(m[0], i + 1 + m.index, i + 1 + m.index + m[0].length);
        i = j + 1; continue;
      }
    }
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
  return { segs, meta, lines, id: textId(text.trim()), han, unknown };
}

// 介面上的特殊字母按鈕
export const KEYS = ['ā', 'ī', 'ū', 'ṛ', 'ṃ', 'ḥ', 'ṅ', 'ñ', 'ṭ', 'ḍ', 'ṇ', 'ś', 'ṣ', '~', '|'];
