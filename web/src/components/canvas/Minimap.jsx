import { useRef } from 'react';
import { PAPER, PAPER_SHADOW } from '../../lib/paper.js';
import { viewportWorldBox } from '../../lib/board-camera.js';
import { GAP } from '../../lib/theme.js';

/**
 * Minimap —— 无限画布的导航小地图（2026-08-13）
 *
 * ## 它替掉的是什么
 *
 * 画布本来有一对"整理 / 工作"双视图：整理看全景、工作锁定一块区。用户拍板
 * 之后**总览不再是一种视图，而是一个导航控件** —— 全貌用它看，干活始终在
 * 当前这一层。这条决定顺带拆掉了两样东西：`viewMode` 的双模式，以及文件夹
 * 的"摊开 / 收起"两态（那是为了在总览里塞下所有内容才需要的）。
 *
 * ## 数学是现成的
 *
 * `board-camera.js` 已经定好 `screen = (world + cam) * z`，还给了
 * `viewportWorldBox`（当前视口对应的世界矩形）和 `bounds`（可漫游范围 =
 * 内容外沿再放宽一整屏）。小地图只是**同一套数学的第二个消费者**：把
 * `bounds` 等比缩进一个角上的框，再把视口那块画成一个亮框。
 *
 * 所以这里不该出现任何新的坐标约定 —— 出现了就说明有人在这儿又推了一遍。
 *
 * ## 交互
 *
 * 点或拖 = 把那一点挪到视口中心（`flyToPoint`，保持当前缩放）。**不做缩放**：
 * 小地图是"我现在在哪、别的东西在哪边"，不是第二套镜头控制。
 */

export const MAP_W = 168;
export const MAP_H = 116;
const PAD = 6;

/** 世界矩形 → 小地图内像素。等比缩 + 居中，不拉伸（拉伸的地图会骗人） */
export function projector(bounds) {
  const bw = Math.max(1, bounds.w);
  const bh = Math.max(1, bounds.h);
  const k = Math.min((MAP_W - PAD * 2) / bw, (MAP_H - PAD * 2) / bh);
  const ox = (MAP_W - bw * k) / 2;
  const oy = (MAP_H - bh * k) / 2;
  return {
    k,
    toMap: (x, y) => ({ x: ox + (x - bounds.x) * k, y: oy + (y - bounds.y) * k }),
    toWorld: (mx, my) => ({ x: (mx - ox) / k + bounds.x, y: (my - oy) / k + bounds.y }),
  };
}

export default function Minimap({ bounds, cam, viewport, items = [], onJump }) {
  const hostRef = useRef(null);
  const draggingRef = useRef(false);

  if (!bounds || !viewport?.w) return null;
  const p = projector(bounds);
  const view = viewportWorldBox(cam, viewport);
  const vTL = p.toMap(view.x, view.y);

  const jumpTo = (e) => {
    const el = hostRef.current;
    if (!el || !onJump) return;
    const r = el.getBoundingClientRect();
    onJump(p.toWorld(e.clientX - r.left, e.clientY - r.top));
  };

  return (
    <div
      ref={hostRef}
      // 小地图自己吃掉手势：不这么做的话按下去会穿透到画布上变成平移
      onPointerDown={(e) => {
        e.stopPropagation();
        draggingRef.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        jumpTo(e);
      }}
      onPointerMove={(e) => { if (draggingRef.current) jumpTo(e); }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => { draggingRef.current = false; }}
      title="点一下跳过去 · 拖着走"
      style={{
        position: 'absolute', left: GAP.md, bottom: GAP.md, zIndex: 40,
        width: MAP_W, height: MAP_H,
        background: PAPER.paper,
        boxShadow: PAPER_SHADOW.far,
        cursor: 'pointer', touchAction: 'none', userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* 内容：一件东西一个小方块。**不画标题也不画图标** —— 这个尺寸下
          任何字都是噪点，能看出"东西聚在哪一片"就够了。 */}
      {items.map((it) => {
        const a = p.toMap(it.x, it.y);
        return (
          <div key={it.id} style={{
            position: 'absolute',
            left: a.x, top: a.y,
            width: Math.max(2, it.w * p.k), height: Math.max(2, it.h * p.k),
            background: it.folder ? 'rgba(43,33,23,0.10)' : PAPER.pencil,
            opacity: it.folder ? 1 : 0.75,
            ...(it.folder ? { outline: `1px solid ${PAPER.hair}` } : null),
          }} />
        );
      })}

      {/* 当前视口。画成"亮框"而不是"暗遮罩" —— 遮罩会把小地图变成一块深色，
          而它就贴在画布左下角，深色块比一个细框抢眼得多。 */}
      <div style={{
        position: 'absolute',
        left: vTL.x, top: vTL.y,
        width: Math.max(6, view.w * p.k), height: Math.max(6, view.h * p.k),
        border: '1.5px solid rgba(176,140,79,0.95)',
        background: 'rgba(176,140,79,0.10)',
        pointerEvents: 'none',
      }} />
    </div>
  );
}
