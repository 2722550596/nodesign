/**
 * units.js — OOXML 单位换算 + 中文字号表。
 * twip = 1/20 pt；w:sz 单位是半磅；mm→twip 按 1440/25.4。
 */

export const ptToTwip = (pt) => Math.round(pt * 20);
export const ptToHalf = (pt) => Math.round(pt * 2);
export const mmToTwip = (mm) => Math.round(mm * 1440 / 25.4);
export const twipToPt = (t) => t / 20;

/** 中文字号 → 磅 */
export const ZIHAO = {
  初号: 42, 小初: 36, 一号: 26, 小一: 24, 二号: 22, 小二: 18,
  三号: 16, 小三: 15, 四号: 14, 小四: 12, 五号: 10.5, 小五: 9,
  六号: 7.5, 小六: 6.5, 七号: 5.5, 八号: 5,
};

export function sizePt(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && ZIHAO[v] != null) return ZIHAO[v];
  throw new Error(`unknown font size: ${v}`);
}

export const PAGE_SIZES = {
  A4: { wTwip: 11906, hTwip: 16838 },
  A3: { wTwip: 16838, hTwip: 23811 },
  Letter: { wTwip: 12240, hTwip: 15840 },
  B5: { wTwip: 9978, hTwip: 14170 },
};
