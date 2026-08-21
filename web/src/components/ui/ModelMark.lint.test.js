/**
 * 品牌标覆盖对账（2026-08-21）。
 *
 * 服务端声明"这个模型出自谁家"（model-context.js 的 BRANDS + 每行的 brand），前端按 brand
 * 画标。两边各改各的就会出现：服务端新加一家 → 前端没有那枚标 → 图标**静默消失**
 * （ModelMark 认不出 brand 时返回 null，是刻意的 fail-soft，因为画错一家的标比不画更糟）。
 * 静默的东西必须有 lint 钉着 —— 同仓的规矩：注释里写"调用方必须处理 X"拦不住任何人。
 *
 * 判据直接读服务端源文件的 BRANDS（不是抄一份常量在这里，那就是第二个真相源）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKS } from './ModelMark.jsx';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SRC = fs.readFileSync(path.join(REPO, 'server/engine/agent/model-context.js'), 'utf8');

function serverBrands() {
  const m = SRC.match(/export const BRANDS = Object\.freeze\(\[([^\]]+)\]\)/);
  if (!m) throw new Error('model-context.js 里找不到 BRANDS —— 它改名了？这条 lint 要跟着改');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

describe('ModelMark 品牌覆盖', () => {
  it('服务端 BRANDS 里的每一家，前端都有一枚标', () => {
    const missing = serverBrands().filter((b) => !MARKS[b]);
    expect(missing, `这些 brand 没有对应的标，图标会静默不画：${missing.join(', ')}`).toEqual([]);
  });

  it('前端没有多余的标（删了一家要两边一起删）', () => {
    const extra = Object.keys(MARKS).filter((b) => !serverBrands().includes(b));
    expect(extra, `MARKS 里这些 brand 服务端已经没有了：${extra.join(', ')}`).toEqual([]);
  });

  it('每枚标都有 path、色、紧外框（外框写错会让这枚标在一行文字里大小不对）', () => {
    for (const [brand, m] of Object.entries(MARKS)) {
      expect(m.paths.length, brand).toBeGreaterThan(0);
      expect(m.paths.every((p) => typeof p.d === 'string' && p.d.length > 20), brand).toBe(true);
      expect(m.color, brand).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(m.vb, brand).toHaveLength(4);
      expect(m.vb[2] > 0 && m.vb[3] > 0, brand).toBe(true);
    }
  });

  it('模型表里每一行都声明了 brand（漏写在服务端加载时就会炸，这里再钉一道防注释掉断言）', () => {
    const rows = SRC.match(/^\s*\{?\s*id: '[^']+',/gm) || [];
    const withBrand = SRC.match(/brand: '/g) || [];
    expect(withBrand.length).toBe(rows.length);
  });
});
