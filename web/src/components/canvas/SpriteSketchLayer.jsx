import { useEffect, useMemo, useRef, useState } from 'react';
import { PAPER } from '../../lib/paper.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
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

/**
 * 逐字显影。笔迹用**画布手写那套栈**（TEXT_FONT_CSS.pen：拉丁走 Caveat、
 * 中文落龙藏体）—— 精灵写的字和用户在白板上写的字必须是同一支笔
 * （2026-08-14 用户点名：之前用楷体，太工整像印出来的）。
 * per-char 延迟随长度收缩：整句写完 ≤ ~1.8s，长句不拖堂。
 */
function Handwriting({ text, delay = MARK_DRAW_MS, size = 16, maxWidth = 300 }) {
  const chars = useMemo(() => Array.from(String(text || '')), [text]);
  if (!chars.length) return null;
  const per = Math.min(60, Math.max(22, Math.round(1600 / chars.length)));
  return (
    <div style={{
      fontFamily: TEXT_FONT_CSS.pen, fontSize: size, lineHeight: 1.55,
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
    // ⚠️ width 必须显式给：世界容器是零宽的变换锚点（大家都显式传宽，BindingLayer
    // 的 width/height、舞台卡的 STAGE_CARD_W 同理），绝对定位 + auto 宽在里面会
    // 按 min-content 收缩 —— 真机症状是手写行竖排成一字一列（2026-08-14 踩到）
    <div key={drawKey} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: size + 10 + maxWidth, pointerEvents: 'none' }}>
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

/**
 * 屏幕候选点 → **世界坐标**槽位。精灵住在画布层（2026-08-14 用户定的：
 * 和产物同一平面，不是覆在上面的现实层），所以槽位算出来就落成世界坐标，
 * 之后跟着纸走。身位也按世界单位算（镜头拉远它就跟着变小，纸上的东西
 * 本该如此）。第一个不压任何产物的槽赢；全占 = null。
 */
export function findAmbientSlot(cam, viewport, obstacles, candidates = SLOT_CANDIDATES) {
  if (!viewport?.w || !viewport?.h || !cam?.z) return null;
  for (const [fx, fy] of candidates) {
    const world = {
      x: (viewport.w * fx - SPRITE_W / 2) / cam.z - cam.x,
      y: (viewport.h * fy - SPRITE_H / 2) / cam.z - cam.y,
      w: SPRITE_W / cam.z, h: SPRITE_H / cam.z,
    };
    if (!(obstacles || []).some(o => hitRect(world, o))) {
      return { x: Math.round(world.x), y: Math.round(world.y) };
    }
  }
  return null;
}

/** 这个世界矩形当前在不在视口里（world_visible = screen/z - cam） */
function slotVisible(slot, cam, viewport) {
  if (!slot || !viewport?.w || !cam?.z) return false;
  const view = { x: -cam.x, y: -cam.y, w: viewport.w / cam.z, h: viewport.h / cam.z };
  // 身位按放置时刻的尺寸近似（缩放变了也就差一圈，判"在不在视野"够用）
  return hitRect({ x: slot.x, y: slot.y, w: SPRITE_W, h: SPRITE_H }, view);
}

/** 精灵离开视野多久才追过来。太快 = 用户一动画布它就跳，像牛皮糖。 */
const OFFSCREEN_RELOCATE_MS = 3000;

/**
 * 闲时精灵（**世界层**，挂在被相机变换的容器里）。
 *
 * 行为（2026-08-14 二版，用户对一版"动一下画布就刷新"的纠偏）：
 *   - 首次出场：按当前视口找槽落位，画一张铅笔稿。
 *   - 用户平移/缩放：精灵**钉在纸上不动**（世界坐标白送这件事），零刷新。
 *   - 它离开视野持续 3 秒：追到当前视口重新找槽、重新起稿；
 *     3 秒内视野又扫回来就当无事发生。
 *   - 追过来时视口全被产物占着：留在原地（原地=视野外=等于不显示，
 *     正好落在"实在没空位就不显示"的规矩上），下次视野变化再试。
 */
export function AmbientSpriteLayer({ active, cam, viewport, obstacles, text }) {
  const [slot, setSlot] = useState(null);      // 世界坐标
  const [drawKey, setDrawKey] = useState(0);
  const stateRef = useRef({});
  stateRef.current = { cam, viewport, obstacles };
  const offTimer = useRef(null);

  useEffect(() => {
    if (!active || !viewport?.w || !cam?.z) {
      clearTimeout(offTimer.current); offTimer.current = null;
      return undefined;
    }
    if (!slot) {
      const first = findAmbientSlot(cam, viewport, obstacles);
      if (first) { setDrawKey(k => k + 1); setSlot(first); }
      return undefined;
    }
    if (slotVisible(slot, cam, viewport)) {
      clearTimeout(offTimer.current); offTimer.current = null;
    } else if (!offTimer.current) {
      // ⚠️ 计时器不进 effect cleanup —— cleanup 每次相机变化都跑，进去的话
      // 用户持续平移时 3 秒永远数不满。只在可见/下场时显式清。
      offTimer.current = setTimeout(() => {
        offTimer.current = null;
        const { cam: c, viewport: vp, obstacles: obs } = stateRef.current;
        const next = findAmbientSlot(c, vp, obs);
        if (next) { setDrawKey(k => k + 1); setSlot(next); }
      }, OFFSCREEN_RELOCATE_MS);
    }
    return undefined;
  }, [active, cam, viewport, obstacles, slot]);

  // 卸载兜底：不走上面的显式清理路径时别让计时器对着空组件开枪
  useEffect(() => () => clearTimeout(offTimer.current), []);

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
