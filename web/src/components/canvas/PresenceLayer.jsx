import { useEffect, useRef } from 'react';
import { PAPER, PAPER_SHADOW } from '../../lib/paper.js';
import { FONT_SANS, FONT_SIZE, GAP, RADIUS } from '../../lib/theme.js';
import { MAIN_AGENT_ID } from '../../lib/board-presence.js';
import ClaudeMark, { CLAUDE_BRAND } from '../ui/ClaudeMark.jsx';

/**
 * PresenceLayer —— 在场的 agent 与子代理（2026-08-07；E4 精灵化 2026-08-13；
 * Claude 化 + 常驻 2026-08-14）
 *
 * 每个在场者在它正在动的那个物件上挂一枚**精灵**：Claude 的星芒标（我们的
 * agent 就是 Claude，图标就用它公开的矢量标，不再发明"AI 小火花"）+ 名字，
 * 正在做什么就跟一句话。多个子代理并行时你直接看见几个精灵在几个地方动。
 *
 * 2026-08-14 两条新规矩（用户点名）：
 *   1. **主精灵常驻**：run 结束不消失，暗一档停在上次工作的物件上 ——
 *      "它就住在这块板上"，下一轮指令从那儿起飞。位置由 BoardCanvas 存
 *      localStorage，刷新页面也在。
 *   2. **落点兜底**：目标物件解析不到矩形（收在文件夹里 / 还没上墙）时，
 *      精灵落到它归属的**文件夹卡**上，而不是干脆不见 —— 追踪器指不出
 *      对象，比指得粗一点糟得多。
 *
 * ## 为什么不是"光标"
 *
 * agent 的"位置"是**它正在写的那个文件**，粒度是物件不是像素。所以画成
 * 贴在物件上的徽记，而不是一个箭头（那会暗示一个并不存在的精确位置）。
 *
 * ## 层级
 *
 * 世界坐标（跟着相机走），`pointerEvents:'none'` —— 它是状态显示，
 * 不接受操作，也绝不能挡住底下卡片的拖拽。
 */

/** 主精灵徽记直径（用户点名要显眼；子代理小一号，主次要分明） */
const MAIN_BADGE = 38;
const SUB_BADGE = 26;

/** 目标矩形解析链：物件本身 → 它住的文件夹 → 文件夹的顶层段（桌面只画根层）。
 *  导出：语音泡（BoardCanvas）要贴到跟精灵同一个落点，解析链必须同一条。 */
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
  // 常驻主精灵也算人：主 agent 只要有位置就画（active 与否只是明暗两档）；
  // 子代理仍是"在场才画"——它们是过客，不常驻。
  const people = Object.values(table || {}).filter(p =>
    p.targetId && (p.active || p.id === MAIN_AGENT_ID));
  useEffect(() => {
    seen.current = new Set(people.filter(p => p.active).map(p => p.id));
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
        const main = p.id === MAIN_AGENT_ID;
        const badge = main ? MAIN_BADGE : SUB_BADGE;
        const fresh = p.active && !seen.current.has(p.id);
        return (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              // 骑在物件左上角上：徽记一小半探出卡外，像别在纸角的徽章
              left: r.x - Math.round(badge * 0.4),
              top: r.y - Math.round(badge * 0.55),
              display: 'flex', alignItems: 'center', gap: GAP.xs,
              maxWidth: Math.max(200, r.w),
              // 常驻暗档：结束了还在，但退到"住在这儿"而不是"正在干活"
              opacity: p.active ? 1 : 0.55,
              transition: 'left 260ms cubic-bezier(0.32,0.72,0,1), top 260ms cubic-bezier(0.32,0.72,0,1), opacity 400ms ease',
              // 飞入只在上场那一次；之后换目标走上面的 left/top transition
              animation: fresh ? 'ndSpriteIn 460ms cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
            }}
          >
            {/* 精灵本体：纸白圆徽 + Claude 星芒。主精灵品牌橙，子代理各按在场色。
                干活时轻轻浮动，歇着就站定。 */}
            <span style={{
              width: badge, height: badge, borderRadius: 999, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: PAPER.paper,
              boxShadow: `0 0 0 2px ${main ? CLAUDE_BRAND : p.color}${p.active ? '55' : '33'}, ${PAPER_SHADOW.mid}`,
              animation: p.active ? 'ndSpriteFloat 2600ms ease-in-out infinite' : 'none',
            }}>
              <ClaudeMark
                size={Math.round(badge * 0.62)}
                color={main ? CLAUDE_BRAND : p.color}
              />
            </span>
            {/* 名牌只在干活时挂 —— 常驻暗档就一枚安静的徽记，不占版面 */}
            {p.active && (
              <span style={{
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs,
                color: PAPER.paper, background: main ? CLAUDE_BRAND : p.color,
                padding: '2px 7px', borderRadius: RADIUS.sm,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {p.name}{p.message ? ` · ${p.message}` : ''}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
