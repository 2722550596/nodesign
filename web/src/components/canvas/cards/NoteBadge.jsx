import { CANVAS } from '../../../lib/theme.js';
import { PAPER } from '../../../lib/paper.js';

/**
 * NoteBadge —— "这件东西上攒了 N 条还没发的标注"（2026-08-13）。
 *
 * 「攒着」这个出口存在的前提是**能看见自己攒了什么**。只有右下角一个总数的话，
 * 走查到第五张卡时你已经不记得前面标过哪几张了 —— 那正是攒批要解决的场景。
 *
 * 挂在**左上角**：右上角是 hover 工具条的位置，两个东西抢同一个角会互相盖。
 * 常驻显示（不跟 hover 走）：它是状态不是操作。
 *
 * 不做反缩放：镜头拉远时它跟着卡一起变小是对的 —— 那个视距下你要看的是
 * "哪一片有标记"，不是读数字。
 */
export default function NoteBadge({ count }) {
  if (!count) return null;
  return (
    <div
      aria-hidden
      title={`攒了 ${count} 条待发标注`}
      style={{
        position: 'absolute', left: -6, top: -6, zIndex: 4,
        minWidth: 18, height: 18, padding: '0 5px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 9,
        background: CANVAS.brass,
        color: PAPER.paper,
        fontSize: 11, fontWeight: 600, lineHeight: 1,
        boxShadow: '0 1px 3px rgba(43,33,23,0.35)',
        pointerEvents: 'none',
      }}
    >
      {count}
    </div>
  );
}
