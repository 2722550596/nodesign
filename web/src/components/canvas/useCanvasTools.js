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
 * - `text`    点一下 → 在那儿开一个输入框，写完落成 `.md`（走便签那条路）。
 *   **落盘不是可选项**：canvas-native 的东西 agent 读不到，而用户写字十有八九
 *   是想说给 agent 听。
 * - `draw`    按住拖 → 一条涂鸦。只活在 board.json（agent 读不到，这是取舍：
 *   涂鸦是给自己做的记号）。
 * - `comment` 点一个物件 → 给它挂一条批注。批注是**关系**不是自由文字，
 *   所以它落成一条 `annotates` 线 + 一段文字，两头都有。
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

export function useCanvasTools({ tool, toWorld, zoneAt, onCreateText, onCreateScribble, onComment, onEditText }) {
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
  const capturesClick = tool === 'text' || tool === 'comment';

  const onPointerDown = useCallback((e) => {
    if (tool === 'select') return false;
    if (e.button !== 0) return false;
    // 只躲**界面控件**（工具栏、按钮），不躲画布物件 —— 工具本来就该能在
    // 卡片上落笔：在图上画个圈、给某张卡写批注，那正是它的用途。
    // 躲过头的后果实测过：评论工具点不了卡片，而点卡片是它的全部意义。
    if (onChrome(e)) return false;

    if (tool === 'draw') {
      const w = toWorld(e.clientX, e.clientY);
      drawRef.current = { points: [w] };
      setDraft({ points: [w] });
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return true;
    }

    if (tool === 'text') {
      // 已经开着一个输入框时，这一下是"点别处收工"，交给输入框自己处理
      if (textAt) return false;
      // 点在已有的字上 = 改那段字，不是叠一段新的。"想挪个字它却弹新输入框"
      // 是用户明确不要的行为（2026-08-13）—— 编辑入口交回 BoardCanvas。
      const hit = e.target.closest?.('[data-board-object]');
      if (hit?.dataset.boardType === 'text') {
        onEditText?.(hit.getAttribute('data-board-object'));
        return true;
      }
      const w = toWorld(e.clientX, e.clientY);
      setTextAt(w);
      return true;
    }

    if (tool === 'comment') {
      const w = toWorld(e.clientX, e.clientY);
      // 物件走 DOM 命中；**工作区只能走几何命中** —— 展开态的工作区框是
      // `pointerEvents:'none'`（它是画在物件下层的背景框，不该吃事件），
      // 所以 closest() 永远找不到它。这不是可以顺手改的：把它改成吃事件，
      // 工作区里的空地就再也拖不动画布了。
      const el = e.target.closest?.('[data-board-object]');
      const targetId = el?.getAttribute('data-board-object') || zoneAt?.(w) || null;
      // 点在空地上 = 没有批注对象。批注是关系，必须有另一头。
      if (!targetId) return true;
      onComment?.(targetId, w);
      return true;
    }
    return false;
  }, [tool, textAt, toWorld, zoneAt, onComment, onEditText]);

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
    capturesDrag, capturesClick,
    onPointerDown, onPointerMove, onPointerUp,
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
