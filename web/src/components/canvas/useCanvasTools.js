import { useState, useRef, useCallback, useEffect } from 'react';
import { onChrome } from '../../lib/board-hit.js';

/**
 * useCanvasTools —— 画布工具模式的输入处理（2026-08-07）
 *
 * 工具栏负责**选哪个工具**，这里负责**拿着这个工具在画布上按下去会发生什么**。
 * 拆开是因为工具栏是通用容器（deck 窗口、站点窗口都要用它），而这些行为只属于
 * 空间画布。
 *
 * ## 三种工具的落点语义
 *
 * - `text`    **双击**空地 → 在那儿开一个输入框，写完落成一段画布文字。
 *   单击什么都不做 —— 这一下交回给物件本身（选中、拖动、双击改字）。
 *   2026-08-13 用户定：「单击不触发，当作操作文字本身」。原来是单击即开框，
 *   于是拿着这支笔就没法碰画布上任何东西，挪一个字都会在旁边叠一段新的。
 * - `draw`    按住拖 → 一条涂鸦。只活在 board.json（agent 读不到，这是取舍：
 *   涂鸦是给自己做的记号）。
 *
 * ⚠️ 这里曾有第三种：`comment`（点一个物件给它挂批注）。2026-08-13 撤掉 ——
 * 标注的对象永远是一个具体物件，那属于物件自己的菜单，不属于"要先在空地上
 * 起手势"的工具栏。两条标注路收进了 AnnotatePopover 的两个按钮。
 *
 * ## 为什么工具态下要挡住平移
 *
 * 相机的「拖空白背景 = 平移」跟「拖着画一笔」抢同一个手势。规则定死：
 * **非 select 工具时，左键拖归工具，平移只剩中键和空格**。否则画一笔就跑镜头。
 */

/** 采样点之间至少隔这么远才记一个，防止一条线存下几千个点把 board.json 撑爆 */
const MIN_SAMPLE_DIST = 3;
/** 单条涂鸦最多这么多点（服务端还有 8000 字符的硬闸门兜底） */
const MAX_POINTS = 600;

export function useCanvasTools({ tool, toWorld, onCreateText, onCreateScribble }) {
  const [draft, setDraft] = useState(null);      // 正在画的那条：{ points: [{x,y}] }
  const [textAt, setTextAt] = useState(null);    // 正在写的那段：{ x, y }
  const drawRef = useRef(null);

  // 换工具时把半成品清掉（拿着笔画了一半去点文字工具，那条半截线不该留下）
  useEffect(() => {
    drawRef.current = null;
    setDraft(null);
    if (tool !== 'text') setTextAt(null);
  }, [tool]);

  /** 工具是否接管左键（接管了相机就不许平移） */
  const capturesDrag = tool === 'draw';

  const onPointerDown = useCallback((e) => {
    if (tool !== 'draw') return false;
    if (e.button !== 0) return false;
    // 只躲**界面控件**（工具栏、按钮），不躲画布物件 —— 笔本来就该能在
    // 卡片上落笔（在图上画个圈，那正是它的用途）。
    if (onChrome(e)) return false;

    const w = toWorld(e.clientX, e.clientY);
    drawRef.current = { points: [w] };
    setDraft({ points: [w] });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    return true;
  }, [tool, toWorld]);

  /**
   * 双击落框（只有文字工具用）。
   *
   * 双击到**物件**上不归这里 —— 物件自己的双击有语义（文字=改这段字、
   * 产物=开那扇窗），抢过来就等于拿着笔时那些语义全没了。
   */
  const onDoubleClick = useCallback((e) => {
    if (tool !== 'text') return false;
    if (onChrome(e)) return false;
    if (e.target.closest?.('[data-board-object]')) return false;
    setTextAt(toWorld(e.clientX, e.clientY));
    return true;
  }, [tool, toWorld]);

  const onPointerMove = useCallback((e) => {
    const d = drawRef.current;
    if (!d) return false;
    const w = toWorld(e.clientX, e.clientY);
    const last = d.points[d.points.length - 1];
    if (Math.hypot(w.x - last.x, w.y - last.y) < MIN_SAMPLE_DIST) return true;
    if (d.points.length >= MAX_POINTS) return true;
    d.points.push(w);
    setDraft({ points: [...d.points] });
    return true;
  }, [toWorld]);

  const onPointerUp = useCallback(() => {
    const d = drawRef.current;
    drawRef.current = null;
    setDraft(null);
    // 两个点以下不算一笔（点一下不该留个墨点），直接丢
    if (!d || d.points.length < 3) return false;
    onCreateScribble?.(d.points);
    return true;
  }, [onCreateScribble]);

  const commitText = useCallback((text) => {
    const at = textAt;
    setTextAt(null);
    const t = (text || '').trim();
    if (!t || !at) return;
    onCreateText?.(t, at);
  }, [textAt, onCreateText]);

  return {
    draft, textAt,
    capturesDrag,
    onPointerDown, onPointerMove, onPointerUp, onDoubleClick,
    commitText, cancelText: () => setTextAt(null),
  };
}

/**
 * 一串世界坐标点 → SVG path。
 *
 * 用**二次贝塞尔穿过相邻点的中点**做平滑（Catmull-Rom 的廉价版）：折线画出来
 * 有明显的棱角，尤其是快速划过时采样稀疏。中点法只多算一次加法，效果够用，
 * 而且天然不会过冲（穿过中点，控制点是原始点）。
 *
 * 坐标输出为**相对第一个点**的偏移 —— 物件的 x/y 是它自己的位置，路径存相对量，
 * 这样拖动涂鸦只改 x/y，路径一个字节不用重写。
 */
export function pointsToPath(points, originX = 0, originY = 0) {
  if (!points?.length) return '';
  const p = points.map(q => ({ x: Math.round(q.x - originX), y: Math.round(q.y - originY) }));
  if (p.length === 1) return `M ${p[0].x} ${p[0].y}`;
  if (p.length === 2) return `M ${p[0].x} ${p[0].y} L ${p[1].x} ${p[1].y}`;
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = Math.round((p[i].x + p[i + 1].x) / 2);
    const my = Math.round((p[i].y + p[i + 1].y) / 2);
    d += ` Q ${p[i].x} ${p[i].y} ${mx} ${my}`;
  }
  const last = p[p.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** 一串点的包围盒（给涂鸦物件定 x/y/w/h） */
export function pointsBounds(points, pad = 6) {
  const xs = points.map(p => p.x); const ys = points.map(p => p.y);
  const x = Math.min(...xs) - pad; const y = Math.min(...ys) - pad;
  return {
    x, y,
    w: Math.max(4, Math.max(...xs) + pad - x),
    h: Math.max(4, Math.max(...ys) + pad - y),
  };
}

// ── 墨迹归组（2026-08-13）──
//
// "空间上相近、有结合点的笔画视作一个整体"（用户定）。做法是**物理合并**：
// 新笔画提交时并进邻近的旧墨迹物件，多段子路径共存于同一个 `d`（服务端的
// 字符白名单天然允许多个 M 命令）。合并后整组一起选中/拖动/缩放 —— 不引入
// 组 id、不动 schema。代价是成组后拆不开，这正是"视作一个整体"的意思。
//
// 下面两个助手都只处理我们自己生成的路径词汇（M/L/Q/C + 数字），字符白名单
// 之外的串根本进不了 board.json。

const NUM_RE = /-?\d*\.?\d+(?:e-?\d+)?/gi;

/** path 字符串里的坐标点列（M/L/Q/C 的参数全是坐标对，Z 无参数） */
export function pathPoints(d) {
  const ns = (String(d || '').match(NUM_RE) || []).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < ns.length; i += 2) pts.push({ x: ns[i], y: ns[i + 1] });
  return pts;
}

/** 整条 path 平移（换合并后的新原点用）：奇数个数字加 dx，偶数个加 dy */
export function translatePath(d, dx, dy) {
  let i = 0;
  return String(d || '').replace(NUM_RE, (m) => String(Math.round(Number(m) + (i++ % 2 === 0 ? dx : dy))));
}
