import { PAPER } from '../../lib/paper.js';
import { FONT_SANS, FONT_SIZE, GAP, RADIUS } from '../../lib/theme.js';
import { activePresences } from '../../lib/board-presence.js';

/**
 * PresenceLayer —— 在场的 agent 与子代理（2026-08-07）
 *
 * 每个在场者在它正在动的那个物件上挂一枚标记：一个小圆点 + 名字，
 * 正在做什么就跟一句话。多个子代理并行时你直接看见几个人在几个地方动，
 * 而不是去聊天侧栏翻 tab。
 *
 * ## 为什么不是"光标"
 *
 * 多人协作里 presence 画成鼠标光标，因为人有鼠标。agent 没有 ——
 * 它的"位置"是**它正在写的那个文件**，粒度是物件不是像素。所以画成
 * 贴在物件上的标签，而不是一个飘在空中的箭头（那会暗示一个并不存在的
 * 精确位置）。
 *
 * ## 层级
 *
 * 世界坐标（跟着相机走），`pointerEvents:'none'` —— 它是状态显示，
 * 不接受操作，也绝不能挡住底下卡片的拖拽。
 */
export default function PresenceLayer({ table, rectOf }) {
  const people = activePresences(table).filter(p => p.targetId);
  if (!people.length) return null;

  return (
    <div style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 310 }}>
      {people.map((p) => {
        const r = rectOf(p.targetId);
        if (!r) return null;   // 目标当下不可见（收进文件夹 / 不在当前工作区）
        return (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              // 贴在物件左上角外侧：那里通常是空的，压不住卡片自己的标题
              left: r.x, top: r.y - 22,
              display: 'flex', alignItems: 'center', gap: GAP.xs,
              maxWidth: Math.max(160, r.w),
              transition: 'left 260ms cubic-bezier(0.32,0.72,0,1), top 260ms cubic-bezier(0.32,0.72,0,1)',
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: 999,
              background: p.color, flexShrink: 0,
              boxShadow: `0 0 0 3px ${p.color}22`,
              animation: 'ndPresencePulse 1800ms ease-in-out infinite',
            }} />
            <span style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs,
              color: PAPER.paper, background: p.color,
              padding: '1px 6px', borderRadius: RADIUS.sm,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {p.name}{p.message ? ` · ${p.message}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
