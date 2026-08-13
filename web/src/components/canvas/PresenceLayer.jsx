import { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { PAPER } from '../../lib/paper.js';
import { FONT_SANS, FONT_SIZE, GAP, RADIUS } from '../../lib/theme.js';
import { activePresences } from '../../lib/board-presence.js';

/**
 * PresenceLayer —— 在场的 agent 与子代理（2026-08-07；E4 精灵化 2026-08-13）
 *
 * 每个在场者在它正在动的那个物件上挂一枚**精灵**：一个会轻轻浮动的小徽记 +
 * 名字，正在做什么就跟一句话。多个子代理并行时你直接看见几个精灵在几个
 * 地方动，而不是去聊天里翻 tab。
 *
 * 用户的话是「像是漂浮的魔法精灵收到你的指令之后立刻飘到你下达命令的地方
 * 开始任务」。三件事拼出这个手感，全部零新事件：
 *   1. **上场飞入**：一个在场者第一次有了位置，从右上方（悬浮卡住的那边）
 *      飘进来落到目标上，不是原地冒出来。用 seen 集合判"第一次"，
 *      下场即从集合剔除 —— 每一轮指令都有一次飞入。
 *   2. **移动**：换目标时 260ms 滑过去（transition 白送，2026-08-07 就有）。
 *   3. **即时起飞**：就地标注发出的瞬间 BoardCanvas.presenceHint 本地合成
 *      在场条目，不等服务端事件绕一圈。
 *
 * ## 为什么不是"光标"
 *
 * 多人协作里 presence 画成鼠标光标，因为人有鼠标。agent 没有 ——
 * 它的"位置"是**它正在写的那个文件**，粒度是物件不是像素。所以画成
 * 贴在物件上的徽记，而不是一个箭头（那会暗示一个并不存在的精确位置）。
 *
 * ## 层级
 *
 * 世界坐标（跟着相机走），`pointerEvents:'none'` —— 它是状态显示，
 * 不接受操作，也绝不能挡住底下卡片的拖拽。
 */
export default function PresenceLayer({ table, rectOf }) {
  // 谁已经在场上（判"第一次上场"用）。每次提交后重建：下场的人被剔除，
  // 下一轮再上场还算"第一次"，飞入动画每轮都有。
  const seen = useRef(new Set());
  const people = activePresences(table).filter(p => p.targetId);
  useEffect(() => {
    seen.current = new Set(people.map(p => p.id));
  });

  if (!people.length) return null;

  return (
    <div style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 310 }}>
      <style>{`
        @keyframes ndSpriteIn {
          from { transform: translate(200px, -150px) scale(0.4); opacity: 0; }
          55%  { opacity: 1; }
          to   { transform: none; opacity: 1; }
        }
        @keyframes ndSpriteFloat {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-3px); }
        }
      `}</style>
      {people.map((p) => {
        const r = rectOf(p.targetId);
        if (!r) return null;   // 目标当下不可见（收进文件夹 / 不在当前工作区）
        const fresh = !seen.current.has(p.id);
        return (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              // 贴在物件左上角外侧：那里通常是空的，压不住卡片自己的标题
              left: r.x, top: r.y - 26,
              display: 'flex', alignItems: 'center', gap: GAP.xs,
              maxWidth: Math.max(160, r.w),
              transition: 'left 260ms cubic-bezier(0.32,0.72,0,1), top 260ms cubic-bezier(0.32,0.72,0,1)',
              // 飞入只在上场那一次；之后换目标走上面的 left/top transition
              animation: fresh ? 'ndSpriteIn 460ms cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
            }}
          >
            {/* 精灵本体：着色小圆徽 + 火花，站定后轻轻浮动 */}
            <span style={{
              width: 18, height: 18, borderRadius: 999, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: p.color,
              boxShadow: `0 0 0 3px ${p.color}22, 0 2px 6px rgba(43,33,23,0.25)`,
              animation: 'ndSpriteFloat 2600ms ease-in-out infinite',
            }}>
              <Sparkles size={11} color={PAPER.paper} strokeWidth={2} />
            </span>
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
