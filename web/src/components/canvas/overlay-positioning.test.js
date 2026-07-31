import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 结构不变量：画布浮层里任何 position:absolute 的节点都必须写偏移。
 *
 * 为什么要拿测试锁这个而不是靠 review —— 2026-07-31 的「评论标记 x 错 730px」
 * 就是这么来的：
 *
 *   <div style={{ position: 'absolute', pointerEvents: 'none' }}>   ← 没写 left/top
 *     <div style={{ position:'absolute', top, left, ... }} />        ← 包含块变成上面那层
 *   </div>
 *
 * absolute 不写偏移时用的是「静态位置」。而这些浮层的父容器是
 * `display:flex; justify-content:center`（SiteWindow / DeckWindow 的取景容器），
 * 按规范绝对定位子元素的静态位置由对齐方式决定 → wrapper 落在容器**水平中心**。
 * 里面的子元素再按 wrapper 定位，整组就右移半个容器宽。
 *
 * 阴险在于：垂直方向静态位置是内容盒顶部、偏移为 0，所以 y 完全正确，只有 x 错。
 * 看上去像"坐标换算差了一项"，于是前两轮都往 zoom / scrollLeft / 锚点方向查，
 * 全查错了地方。
 *
 * 这条规则也顺带挡住"以为父级是定位容器、其实不是"这类的下一次翻车。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 只查真正贴着 iframe 内元素画东西的浮层（它们共享同一套坐标换算） */
const OVERLAY_FILES = [
  'CommentMarkers.jsx',
  'PendingMoveMarkers.jsx',
  'EditOverlay.jsx',
  'DragOverlay.jsx',
  'GrabHandle.jsx',
  'InspectFloatingCard.jsx',
  'PostDragNotePanel.jsx',
];

/** 键名可能是 `top: x` 也可能是简写 `top,` / `top }` */
const OFFSET_KEY = /\b(top|left|bottom|right)\s*(?::|,|\})/;

function absoluteBlocksWithoutOffset(source) {
  const hits = [];
  const re = /style=\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const block = m[1];
    if (!/position:\s*'absolute'/.test(block)) continue;
    if (OFFSET_KEY.test(block)) continue;
    hits.push({ line: source.slice(0, m.index).split('\n').length, block: block.trim().slice(0, 80) });
  }
  return hits;
}

describe('画布浮层的绝对定位不变量', () => {
  for (const file of OVERLAY_FILES) {
    it(`${file} 里的 absolute 节点都写了偏移`, () => {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const hits = absoluteBlocksWithoutOffset(src);
      expect(
        hits,
        hits.length
          ? `${file} 第 ${hits.map(h => h.line).join(', ')} 行：position:absolute 没写 top/left/bottom/right，`
            + '会落到 flex 容器的居中静态位置上，整组浮层横向偏半个容器宽。'
          : '',
      ).toEqual([]);
    });
  }

  it('检测器本身有效：认得出出问题的写法', () => {
    const bad = `<div style={{ position: 'absolute', pointerEvents: 'none' }}>`;
    expect(absoluteBlocksWithoutOffset(bad)).toHaveLength(1);
  });

  it('检测器不误伤：写了偏移的（含简写和 bottom/right）都放行', () => {
    const ok = [
      `<div style={{ position: 'absolute', top: 0, left: 0 }}>`,
      `<div style={{ position: 'absolute', top, left, width: 10 }}>`,
      `<div style={{ position: 'absolute', bottom: -20, right: 0 }}>`,
    ].join('\n');
    expect(absoluteBlocksWithoutOffset(ok)).toEqual([]);
  });
});
