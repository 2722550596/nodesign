import { useMemo } from 'react';
import { PAPER } from '../../lib/paper.js';
import { FONT_SANS, FONT_SIZE } from '../../lib/theme.js';
import {
  BINDING_STYLES, BINDING_ACCENT, bindingStyle,
  edgePoints, bindingPath, bindingMidpoint,
} from '../../lib/board-bindings.js';

/**
 * BindingLayer —— 画布上的关系线（2026-08-07）
 *
 * 画在**世界坐标**里：这个 SVG 跟物件铺在同一个被相机变换的容器中，所以
 * 相机怎么平移缩放它都自动跟着，这一层不需要知道相机的存在。
 *
 * ## 层级：在物件之下
 *
 * 线从卡片边框出发、贴着边停（`edgePoints` 的 gap），本来就不会压到卡片上。
 * 放在物件下层是为了另一件事 —— **线不能吃掉指针事件**，否则卡片之间的空地
 * 变得点不动、拖不了。整个 SVG `pointerEvents:'none'`，只有线本身开
 * `stroke`（加一条透明粗线当命中区），这样悬停线能亮、空地照样能拖。
 *
 * ## 端点解析失败就不画
 *
 * `rectOf` 拿不到矩形的情况是常态而不是异常：物件可能被收进文件夹了、可能
 * 属于当前不可见的工作区、也可能是连向一个还没被摆过的产物。**这些都不该
 * 画一条通向虚空的线**，直接跳过。服务端那层只在端点被显式删除时清线，
 * 渲染这层负责"当下看不见就不画"，两层各管各的。
 */

/** 一条线的命中区宽度（透明，只为让细线也好悬停） */
const HIT_W = 12;

export default function BindingLayer({
  bindings,           // { [id]: { type, from, to, label?, by? } }
  rectOf,             // (id) => {x,y,w,h} | null
  /**
   * 几何纪元 —— **必须传**，随物件位置一起变的任何值都行（传 positioned 即可）。
   *
   * 没有它就会踩这个坑：`rectOf` 通常写成 `useCallback(..., [])`（它从 ref 读
   * 数据，本来就不需要重建），于是它**永远是同一个引用**，下面那个 memo 的
   * 依赖数组就永远不变 —— 物件挪了、新物件来了，线全都不重算。
   * 症状很迷惑：刷新页面线就对了（那时 bindings 是新引用），在页面里怎么拖都不动。
   */
  epoch,
  width, height,      // 世界尺寸（SVG 画幅）
  hoveredId = null,
  /** 悬停中的**物件** id（路线5）：连着它的线全部点亮 —— 关系一瞥 */
  hotEndpointId = null,
  onHover,
  onSelect,
}) {
  const drawn = useMemo(() => {
    const out = [];
    for (const [id, b] of Object.entries(bindings || {})) {
      const style = bindingStyle(b.type);
      if (!style) continue;                       // 未知语义不画（跟服务端同口径）
      // 自动对账的取材边不画（2026-08-14）：一个站引三十张图，画出来是蜘蛛网
      // 不是版面。它们的消费方是 agent 上下文和主角判断，不是眼睛。
      if (b.by === 'auto' && b.type === 'ref') continue;
      const a = rectOf(b.from);
      const z = rectOf(b.to);
      if (!a || !z) continue;                     // 端点当下不可见 → 跳过
      const pts = edgePoints(a, z, 6);
      if (!pts) continue;
      out.push({
        id, b, style,
        d: bindingPath(pts.from, pts.to),
        mid: bindingMidpoint(pts.from, pts.to),
      });
    }
    return out;
  }, [bindings, rectOf, epoch]);

  if (!drawn.length) return null;

  return (
    <svg
      width={width} height={height}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}
      aria-hidden="true"
    >
      <defs>
        {Object.entries(BINDING_STYLES).flatMap(([type, s]) => [
          s.head && markerDef(`${type}-head`, s.head, s.stroke),
          s.tail && markerDef(`${type}-tail`, s.tail, s.stroke, true),
          // 悬停态单独一套（换色不能靠 CSS，marker 的 fill 不继承 currentColor）
          s.head && markerDef(`${type}-head-hot`, s.head, BINDING_ACCENT),
          s.tail && markerDef(`${type}-tail-hot`, s.tail, BINDING_ACCENT, true),
        ].filter(Boolean))}
      </defs>

      {drawn.map(({ id, b, style, d, mid }) => {
        const hot = hoveredId === id
          || (!!hotEndpointId && (b.from === hotEndpointId || b.to === hotEndpointId));
        const stroke = hot ? BINDING_ACCENT : style.stroke;
        const suffix = hot ? '-hot' : '';
        // 悬停标签补一笔出处：agent 画的线标出来（用户自己画的是默认，不啰嗦）
        const label = (b.label || style.label)
          + (b.by === 'agent' ? ' · agent 画的' : b.by === 'auto' ? ' · 自动' : '');
        // 常显标签（2026-08-14，用户点名线"太不显眼"）：手画的线平时就把词
        // 挂在线上 —— 线型语义只有作者自己记得，词才是给别人看的。两个例外：
        //   - 批注线不常显（那段文字本身就是标签，再标"批注"是废话）
        //   - 自动线不常显（一站引三十张图，全挂词就是弹幕）
        // 除非作者写了自定义 label —— 写了就是想让人看见。
        const restLabel = b.label
          || (b.by !== 'auto' && b.type !== 'annotates' ? style.label : null);
        const shownLabel = hot ? label : restLabel;
        return (
          <g key={id}>
            {/* 命中区：透明粗线，细线也好悬停 */}
            <path
              d={d} fill="none" stroke="transparent" strokeWidth={HIT_W}
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onPointerEnter={() => onHover?.(id)}
              onPointerLeave={() => onHover?.(null)}
              // 在 pointerdown 上选中，不等 click：容器的 pointerdown 会起相机/
              // 框选并 setPointerCapture，pointerup 被重定向后 path 的 click
              // 根本不生成（2026-08-14 真机踩到：hover 亮、click 永远不来）。
              // stopPropagation 同时挡住容器手势 —— 点线就是点线，不平移。
              onPointerDown={(e) => {
                e.stopPropagation(); e.preventDefault();
                onSelect?.(id, e.clientX, e.clientY);
              }}
            />
            <path
              d={d} fill="none"
              stroke={stroke}
              strokeWidth={hot ? style.width + 0.6 : style.width}
              strokeDasharray={style.dash || undefined}
              strokeLinecap="round"
              markerEnd={style.head ? `url(#nd-b-${b.type}-head${suffix})` : undefined}
              markerStart={style.tail ? `url(#nd-b-${b.type}-tail${suffix})` : undefined}
              style={{ transition: 'stroke 0.14s, stroke-width 0.14s' }}
            />
            {/* 线上的字：手画的线常显（restLabel），悬停放大并补出处。
                自动线仍是悬停才出 —— 弹幕化的教训写在上面。 */}
            {shownLabel && (
              <g transform={`translate(${mid.x} ${mid.y})`}>
                <text
                  textAnchor="middle" dominantBaseline="middle"
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: hot ? FONT_SIZE.xs : FONT_SIZE.xxs,
                    fill: hot ? PAPER.ink : PAPER.ink2,
                    paintOrder: 'stroke',
                    stroke: PAPER.paper, strokeWidth: 4, strokeLinejoin: 'round',
                    transition: 'font-size 0.14s, fill 0.14s',
                  }}
                >
                  {shownLabel}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * 端头。三种形状：
 *  - arrow       实心三角（改自：最重）
 *  - arrow-open  开口折线（接着 / 取材）
 *  - dot         小圆点（批注：轻）
 *  - bar         短横（对照：两端对称 = 无向）
 *
 * `flipped` 给尾端用 —— marker 的方向跟路径切线走，尾端要转 180°。
 */
function markerDef(key, shape, color, flipped = false) {
  const id = `nd-b-${key}`;
  const rot = flipped ? 'auto-start-reverse' : 'auto';
  const common = { id, orient: rot, markerUnits: 'userSpaceOnUse' };

  // 2026-08-14 随线宽整体放大一号（细线端头配粗线像铅笔头装在钢笔上）
  if (shape === 'dot') {
    return (
      <marker key={id} {...common} markerWidth={9} markerHeight={9} refX={4.5} refY={4.5}>
        <circle cx={4.5} cy={4.5} r={3.4} fill={color} />
      </marker>
    );
  }
  if (shape === 'bar') {
    return (
      <marker key={id} {...common} markerWidth={9} markerHeight={12} refX={2.5} refY={6}>
        <rect x={1} y={0.8} width={2.4} height={10.4} rx={1.2} fill={color} />
      </marker>
    );
  }
  if (shape === 'arrow-open') {
    return (
      <marker key={id} {...common} markerWidth={13} markerHeight={13} refX={10.5} refY={6.5}>
        <path d="M 2.5 2 L 10.5 6.5 L 2.5 11" fill="none" stroke={color} strokeWidth={1.9}
          strokeLinecap="round" strokeLinejoin="round" />
      </marker>
    );
  }
  // arrow（实心）
  return (
    <marker key={id} {...common} markerWidth={12} markerHeight={12} refX={10} refY={6}>
      <path d="M 1.2 1.4 L 10.8 6 L 1.2 10.6 z" fill={color} />
    </marker>
  );
}
