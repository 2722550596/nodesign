import { useEffect } from 'react';

/**
 * 拖到视口边缘 → 画布自动跟着走（2026-08-17，issue #1 第 6 条）。
 *
 * 在这之前只能"一边按住一边滚滚轮"才能把东西拖到更远的地方 —— 拖拽本身
 * 不挪镜头，屏幕外的落点根本够不着。
 *
 * ## 卡怎么跟手
 *
 * **这里只推相机，一个字都不碰物件坐标。** 相机一变，BoardCanvas 里那条
 * `[cam]` effect 就用最后一次已知的光标位置把卡重算一遍 —— 它本来是给
 * "拖着卡滚滚轮"兜底的（2026-08-13 那次修的就是"相机动了卡却按屏幕位移
 * 原地不动"），自动平移跟它是同一件事。所以自动平移期间光标不动、卡也钉在
 * 光标底下，是世界在它下面滑过去。
 *
 * 这也是为什么这个 hook 只管 `kind === 'object'` 的拖拽：那条补帧 effect
 * 也只认这一种，别的拖拽（文件夹卡、精灵）推了镜头会当场漂走。
 */

/**
 * 离视口边这么近就开始推镜头。60px —— 比一张卡的边距宽，够手在里面稳住；
 * 再宽会让"就想把东西放在靠边的位置"变成一件难事。
 */
const EDGE_PAN_BAND = 60;
/** 贴死屏缘时的满速（屏幕像素/秒）。带子里按入侵深度线性给到这个值。 */
const EDGE_PAN_SPEED = 900;
/** 掉帧封顶：一帧最多按 50ms 算，卡一下不该让画布窜出去 */
const MAX_FRAME_S = 0.05;

/** 一个轴上的推力：带外 0，带内按入侵深度线性到 ±1（越靠边越快） */
function edgeForce(pos, lo, hi) {
  if (pos < lo + EDGE_PAN_BAND) return -(1 - Math.max(0, pos - lo) / EDGE_PAN_BAND);
  if (pos > hi - EDGE_PAN_BAND) return 1 - Math.max(0, hi - pos) / EDGE_PAN_BAND;
  return 0;
}

/**
 * @param {object}   p
 * @param {boolean}  p.active     物件拖拽进行中（BoardCanvas 的 dragActive）
 * @param {object}   p.dragRef    拖拽账本 ref，要有 kind / moved / lastClientX / lastClientY
 * @param {object}   p.paneRef    视口元素 ref（相机的 paneRef，同一个）
 * @param {object}   p.camApiRef  相机 API ref，用它的 panByScreen
 */
export function useDragEdgePan({ active, dragRef, paneRef, camApiRef }) {
  useEffect(() => {
    if (!active) return undefined;
    let raf = 0;
    let prevTs = 0;
    const tick = (ts) => {
      raf = requestAnimationFrame(tick);
      const d = dragRef.current;
      const el = paneRef.current;
      const dt = prevTs ? Math.min((ts - prevTs) / 1000, MAX_FRAME_S) : 0;
      prevTs = ts;
      // 只有真拖起来了才推镜头：按住不动停在边上不该开始漂
      if (!d || d.kind !== 'object' || !d.moved || !el || !dt) return;
      const r = el.getBoundingClientRect();
      const fx = edgeForce(d.lastClientX, r.left, r.right);
      const fy = edgeForce(d.lastClientY, r.top, r.bottom);
      if (!fx && !fy) return;
      camApiRef.current?.panByScreen?.(fx * EDGE_PAN_SPEED * dt, fy * EDGE_PAN_SPEED * dt);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, dragRef, paneRef, camApiRef]);
}
