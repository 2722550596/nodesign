import { useEffect, useRef } from 'react';
import { PAPER, PAPER_SHADOW } from '../../lib/paper.js';
import { FONT_SANS, FONT_SIZE, GAP, RADIUS } from '../../lib/theme.js';
import { MAIN_AGENT_ID } from '../../lib/board-presence.js';
import ClaudeMark from '../ui/ClaudeMark.jsx';

/**
 * PresenceLayer —— 在场的**子代理**（2026-08-07；E4 精灵化 2026-08-13；
 * 2026-08-14 日记本批起只管子代理）
 *
 * 主 agent 的存在感当日移交给铅笔定格精灵（SpriteSketchLayer.jsx）：工作时
 * 画在目标物件上、闲时跟着用户镜头写问候和 recap。这里剩下的职责是**并行的
 * 子代理**：每个在它正在动的物件上挂一枚小徽记 + 名字，多个子代理并行时
 * 你直接看见几个小精灵在几个地方动，而不是去聊天里翻 tab。
 *
 * 徽记仍是 Claude 星芒（它们也是 Claude），按在场色着色、比主精灵小一号 ——
 * 主次要分得出来。
 *
 * ## 层级
 *
 * 世界坐标（跟着相机走），`pointerEvents:'none'` —— 它是状态显示，
 * 不接受操作，也绝不能挡住底下卡片的拖拽。
 */

const SUB_BADGE = 26;

/** 目标矩形解析链：物件本身 → 它住的文件夹 → 文件夹的顶层段（桌面只画根层）。
 *  导出：主精灵（BoardCanvas 的工作态落点）用同一条链，落点永远一致。 */
export function rectFor(p, rectOf) {
  const direct = rectOf(p.targetId);
  if (direct) return direct;
  if (!p.zoneId) return null;
  const byZone = rectOf(p.zoneId);
  if (byZone) return byZone;
  const top = p.zoneId.includes('/') ? p.zoneId.split('/')[0] : null;
  return top ? rectOf(top) : null;
}

export default function PresenceLayer({ table, rectOf }) {
  // 谁已经在场上（判"第一次上场"用）。每次提交后重建：下场的人被剔除，
  // 下一轮再上场还算"第一次"，飞入动画每轮都有。
  const seen = useRef(new Set());
  const people = Object.values(table || {}).filter(p =>
    p.targetId && p.active && p.id !== MAIN_AGENT_ID);
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
        const r = rectFor(p, rectOf);
        if (!r) return null;   // 连文件夹都定位不到（不在当前工作区）才不画
        const fresh = !seen.current.has(p.id);
        return (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              // 骑在物件左上角上：徽记一小半探出卡外，像别在纸角的徽章
              left: r.x - Math.round(SUB_BADGE * 0.4),
              top: r.y - Math.round(SUB_BADGE * 0.55),
              display: 'flex', alignItems: 'center', gap: GAP.xs,
              maxWidth: Math.max(200, r.w),
              transition: 'left 260ms cubic-bezier(0.32,0.72,0,1), top 260ms cubic-bezier(0.32,0.72,0,1)',
              animation: fresh ? 'ndSpriteIn 460ms cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
            }}
          >
            <span style={{
              width: SUB_BADGE, height: SUB_BADGE, borderRadius: 999, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: PAPER.paper,
              boxShadow: `0 0 0 2px ${p.color}55, ${PAPER_SHADOW.mid}`,
              animation: 'ndSpriteFloat 2600ms ease-in-out infinite',
            }}>
              <ClaudeMark size={Math.round(SUB_BADGE * 0.62)} color={p.color} />
            </span>
            <span style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs,
              color: PAPER.paper, background: p.color,
              padding: '2px 7px', borderRadius: RADIUS.sm,
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
