import { useEffect, useMemo, useRef, useState } from 'react';
import { PAPER } from '../../lib/paper.js';
import { FONT_KAI } from '../../lib/theme.js';
import { CLAUDE_BRAND, CLAUDE_PATH } from '../ui/ClaudeMark.jsx';

/**
 * SpriteSketchLayer —— 铅笔定格精灵（2026-08-14，日记本批）
 *
 * 范式来自用户点名的里德尔日记：agent 在画布上的存在不是"浮着的徽章"，而是
 * **铅笔在纸上画出来的东西**。出场三拍：
 *   1. 描线 —— Claude 星芒按 path 走一遍铅笔稿（pathLength=1 归一化 +
 *      dashoffset，steps() 计时让它一格一格前进，定格动画的手感）
 *   2. 显影 —— 品牌橙从铅笔稿里浮出来（opacity steps，像墨水渗进纸）
 *   3. 手写 —— 内容用楷体逐字写出，每个字带一点确定性的歪斜（伪随机取自
 *      字符码，同一句话每次歪得一样 —— 抖动是笔迹不是噪声）
 *
 * 两种场合共用同一个视觉（SpriteSketch），谁来摆位各管各的：
 *   - 工作时：BoardCanvas 把它放在目标物件上（世界坐标，跟着卡片走）
 *   - 闲时：AmbientSpriteLayer 跟着**用户镜头**（屏幕坐标）——首选落位是
 *     视口中心到顶边连线的中点，被产物占了就换备选槽，全占就不出现
 *     （用户定的规矩：宁可不显示，不压在别人的作品上）
 *
 * 没有底、没有框、没有影 —— 它不是 UI 控件，是画在纸上的一笔。
 */

const KEYFRAMES = `
  @keyframes ndSketchDraw { to { stroke-dashoffset: 0; } }
  @keyframes ndSketchFill { to { opacity: 0.94; } }
  @keyframes ndInkIn      { to { opacity: 1; } }
`;

/** 描线用时（手写文字的起笔时刻拿它当 delay，字总在图标成形后才落） */
const MARK_DRAW_MS = 760;

function SketchMark({ size = 44 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      aria-hidden="true" style={{ display: 'block', flexShrink: 0, overflow: 'visible' }}
    >
      {/* 铅笔稿：描完不撤 —— 橙色显影后底下透出一点铅笔线，正是手绘的破绽感 */}
      <path
        d={CLAUDE_PATH} pathLength="1"
        fill="none" stroke={PAPER.ink2} strokeWidth={0.55}
        strokeLinecap="round"
        style={{
          strokeDasharray: 1, strokeDashoffset: 1,
          animation: `ndSketchDraw ${MARK_DRAW_MS}ms steps(14, end) forwards`,
        }}
      />
      <path
        d={CLAUDE_PATH} fill={CLAUDE_BRAND}
        style={{ opacity: 0, animation: 'ndSketchFill 420ms steps(6, end) 640ms forwards' }}
      />
    </svg>
  );
}

/** 楷体逐字显影。per-char 延迟随长度收缩：整句写完 ≤ ~1.8s，长句不拖堂。 */
function Handwriting({ text, delay = MARK_DRAW_MS, size = 13.5, maxWidth = 300 }) {
  const chars = useMemo(() => Array.from(String(text || '')), [text]);
  if (!chars.length) return null;
  const per = Math.min(60, Math.max(22, Math.round(1600 / chars.length)));
  return (
    <div style={{
      fontFamily: FONT_KAI, fontSize: size, lineHeight: 1.65,
      color: PAPER.ink2, maxWidth, wordBreak: 'break-word',
    }}>
      {chars.map((ch, i) => {
        const j = ((ch.codePointAt(0) || 1) * 31 + i * 7) % 7;
        return (
          <span
            key={`${i}:${ch}`}
            style={{
              display: 'inline-block',
              opacity: 0,
              transform: `rotate(${(j - 3) * 0.8}deg) translateY(${(j % 3) - 1}px)`,
              animation: `ndInkIn 90ms steps(2, end) ${delay + i * per}ms forwards`,
            }}
          >{ch === ' ' ? ' ' : ch}</span>
        );
      })}
    </div>
  );
}

/**
 * 精灵本体：图标 + 手写行。`drawKey` 变化 = 整体重画（换了地方/重新出场）；
 * 只有 `text` 变 = 图标原地不动、那行字重写 —— 像在同一页上划掉重写。
 */
export function SpriteSketch({ drawKey = 0, text, size = 44, maxWidth = 300 }) {
  return (
    <div key={drawKey} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, pointerEvents: 'none' }}>
      <style>{KEYFRAMES}</style>
      <SketchMark size={size} />
      <div style={{ paddingTop: Math.round(size * 0.16) }}>
        <Handwriting key={text} text={text} maxWidth={maxWidth} />
      </div>
    </div>
  );
}

// ── 闲时：跟镜头找空位 ──

/** 精灵的屏幕身位（找空位按它的外接矩形算） */
const SPRITE_W = 340;
const SPRITE_H = 70;

/**
 * 备选槽（视口比例坐标）。第一个就是用户点名的落点：视口中点到顶边这条线
 * 的中点。其余从它往两侧、再往下半屏退让。
 */
const SLOT_CANDIDATES = [
  [0.5, 0.25], [0.32, 0.25], [0.68, 0.25],
  [0.5, 0.72], [0.32, 0.72], [0.68, 0.72],
];

const hitRect = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/** 屏幕候选点 → 世界矩形 → 与产物求交。第一个不压任何东西的槽赢；没有 = null。 */
export function findAmbientSlot(cam, viewport, obstacles, candidates = SLOT_CANDIDATES) {
  if (!viewport?.w || !viewport?.h || !cam?.z) return null;
  for (const [fx, fy] of candidates) {
    const sx = Math.round(viewport.w * fx - SPRITE_W / 2);
    const sy = Math.round(viewport.h * fy - SPRITE_H / 2);
    const world = {
      x: sx / cam.z - cam.x, y: sy / cam.z - cam.y,
      w: SPRITE_W / cam.z, h: SPRITE_H / cam.z,
    };
    if (!(obstacles || []).some(o => hitRect(world, o))) return { x: sx, y: sy };
  }
  return null;
}

/**
 * 闲时精灵（屏幕坐标层）。相机/视口一动，250ms 落定后重新找位：
 * 原槽还空着就原地不动（跟着镜头走），被占了就挪去备选槽并**重画**
 * （定格动画的换场就是重画，不滑移），全占就消失。
 */
export function AmbientSpriteLayer({ active, cam, viewport, obstacles, text }) {
  const [slot, setSlot] = useState(null);
  const [drawKey, setDrawKey] = useState(0);
  const timer = useRef(null);

  useEffect(() => {
    if (!active) { setSlot(null); return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = findAmbientSlot(cam, viewport, obstacles);
      setSlot(prev => {
        if (!next) return null;
        if (prev && Math.abs(prev.x - next.x) < 8 && Math.abs(prev.y - next.y) < 8) return prev;
        setDrawKey(k => k + 1);   // 换了地方：重新起一张铅笔稿
        return next;
      });
    }, 250);
    return () => clearTimeout(timer.current);
  }, [active, cam.x, cam.y, cam.z, viewport.w, viewport.h, obstacles]);

  if (!active || !slot || !text) return null;
  return (
    <div style={{ position: 'absolute', left: slot.x, top: slot.y, zIndex: 305, pointerEvents: 'none' }}>
      <SpriteSketch drawKey={drawKey} text={text} />
    </div>
  );
}

// ── 文案池 ──

/** 工具在跑：轮播的旁白（用户点名要 cooking 这个味道） */
export const TOOL_PHRASES = ['cooking…', '正在制作', '落笔中', '搭着架子', '打磨细节', 'brewing…'];

/** 没工具没文本（在想）：安静一点的几句 */
export const THINK_PHRASES = ['琢磨着…', 'thinking…', '在打腹稿'];

/** 闲时问候（没有 recap 可写的时候）。按钟点挑一池，进场时定一句不轮换。 */
export function pickGreeting(now = new Date()) {
  const h = now.getHours();
  const pool = h < 6 ? ['夜深了，我陪你画完这张', 'late night, soft pencils']
    : h < 11 ? ['早上好，今天画点什么？', 'fresh paper, fresh ideas']
      : h < 18 ? ["it's coffee and claude time", '纸摊好了，随时开工']
        : ['晚上好，灵感夜班', 'good evening — night owl mode'];
  return pool[(now.getDate() + h) % pool.length];
}
