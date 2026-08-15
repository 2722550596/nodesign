import { useEffect, useMemo, useRef, useState } from 'react';
import { PAPER } from '../../lib/paper.js';
import { STAGE_CARD_W } from '../../lib/board-geometry.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';
import { isImeEnter } from '../../lib/helpers.js';
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
  @keyframes ndRayPulse {
    0%   { transform: scale(1);    animation-timing-function: cubic-bezier(0.2, 0.65, 0.45, 1); }
    11%  { transform: scale(0.74); animation-timing-function: linear; }
    16%  { transform: scale(0.74); animation-timing-function: cubic-bezier(0.3, 2.2, 0.4, 1); }
    34%  { transform: scale(1); }
    100% { transform: scale(1); }
  }
  @keyframes ndCoreBreath {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.1); }
    100% { transform: scale(1); }
  }
`;

/** 描线用时（手写文字的起笔时刻拿它当 delay，字总在图标成形后才落） */
const MARK_DRAW_MS = 760;

/**
 * 手绘矢量版星芒（2026-08-14 五版，用户拍板"整个用我们自己的手绘版，操作
 * 空间大"）：12 个触点 + 中心毂是**独立形状**，从官方轮廓按谷点解剖出来
 * （scratchpad/claude-rays2.mjs：触点尖=半径极大、谷=相邻尖之间半径极小，
 * 谷到谷的轮廓段闭合成一根触点，谷点连成 12 边形毂）。480px 逐像素 diff=0
 * —— 拼回去就是官方图，拆开每根都能自由动。
 * ox/oy = 谷弦中点 = 这根触点的"根"：挤压绕根缩，根钉在毂缘上永不开缝，
 * 前一版的 clip 裁切和圆片补丁整套退役。
 */
const HUB = 'M9.57 11.63L9.4 8.81L12.08 9.16L13.82 8.46L16.49 10.53L15.83 12.8L15.74 13.91L15.7 16.19L13.24 16.02L11.92 15.29L10.53 14.44L9.51 13.08Z';
const RAYS = [
  { d: 'M12.08 9.16L12.24 9.16L12.24 9.01L12.36 7.3L12.6 5.21L12.83 2.51L12.91 1.75L13.29 0.84L14.03 0.35L14.62 0.63L15.1 1.32L15.03 1.76L14.74 3.61L14.19 6.51L13.82 8.46Z', ox: 12.95, oy: 8.81 },  // tip 280°
  { d: 'M13.82 8.46L14.03 8.46L14.28 8.21L15.26 6.91L16.91 4.84L17.64 4.03L18.49 3.12L19.04 2.69L20.07 2.69L20.83 3.82L20.49 4.98L19.43 6.33L18.54 7.47L17.28 9.17L16.49 10.53Z', ox: 15.16, oy: 9.5 },  // tip 311°
  { d: 'M16.49 10.53L16.57 10.64L16.75 10.62L19.61 10.02L21.15 9.74L22.99 9.42L23.82 9.81L23.91 10.21L23.58 11.01L21.62 11.5L19.31 11.96L15.87 12.77L15.83 12.8Z', ox: 16.16, oy: 11.67 },  // tip 351°
  { d: 'M15.83 12.8L15.88 12.87L17.43 13.01L18.09 13.05L19.71 13.05L22.73 13.27L23.52 13.79L23.99 14.43L23.91 14.92L22.7 15.54L21.06 15.15L17.23 14.24L15.92 13.91L15.74 13.91Z', ox: 15.79, oy: 13.36 },  // tip 14°
  { d: 'M15.74 13.91L15.74 14.02L16.83 15.09L18.84 16.9L21.34 19.23L21.47 19.8L21.15 20.26L20.81 20.21L18.61 18.55L17.76 17.81L15.83 16.19L15.7 16.19Z', ox: 15.72, oy: 15.05 },  // tip 42°
  { d: 'M15.7 16.19L15.7 16.36L16.15 17.01L18.49 20.53L18.61 21.61L18.44 21.96L17.83 22.17L17.17 22.05L15.79 20.13L14.38 17.96L13.24 16.02Z', ox: 14.47, oy: 16.1 },  // tip 57°
  { d: 'M13.24 16.02L13.1 16.1L12.42 23.35L12.11 23.72L11.38 24L10.77 23.54L10.45 22.79L10.77 21.32L11.16 19.39L11.48 17.86L11.76 15.96L11.93 15.33L11.92 15.29Z', ox: 12.58, oy: 15.65 },  // tip 93°
  { d: 'M11.92 15.29L11.78 15.31L10.35 17.27L8.17 20.22L6.44 22.06L6.03 22.23L5.32 21.86L5.38 21.2L5.78 20.61L8.17 17.57L9.61 15.69L10.54 14.6L10.53 14.44Z', ox: 11.23, oy: 14.87 },  // tip 124°
  { d: 'M10.53 14.44L10.48 14.44L4.14 18.56L3.01 18.71L2.52 18.25L2.58 17.5L2.81 17.26L4.72 15.95L4.71 15.96L9.43 13.31L9.51 13.08Z', ox: 10.02, oy: 13.76 },  // tip 147°
  { d: 'M9.51 13.08L9.43 12.95L9.2 12.95L8.41 12.9L5.72 12.83L3.38 12.73L1.11 12.61L0.54 12.49L0.01 11.78L0.06 11.43L0.54 11.11L1.23 11.17L2.75 11.27L5.02 11.43L6.68 11.53L9.12 11.78L9.51 11.78L9.57 11.63Z', ox: 9.54, oy: 12.35 },  // tip 181°
  { d: 'M9.57 11.63L9.43 11.53L9.33 11.43L6.97 9.84L4.42 8.15L3.09 7.18L2.36 6.68L2 6.22L1.84 5.22L2.5 4.49L3.38 4.55L3.6 4.61L4.5 5.3L6.4 6.78L8.89 8.61L9.26 8.91L9.4 8.81Z', ox: 9.48, oy: 10.22 },  // tip 214°
  { d: 'M9.4 8.81L9.42 8.74L9.26 8.46L7.9 6.02L6.46 3.53L5.81 2.5L5.64 1.88L5.62 1.78L5.6 1.69L5.58 1.6L5.57 1.51L5.56 1.43L5.55 1.34L5.54 1.24L5.54 1.15L6.29 0.13L6.7 0L7.7 0.13L8.11 0.5L8.73 1.91L9.74 4.14L11.29 7.17L11.74 8.07L11.99 8.9L12.08 9.16Z', ox: 10.74, oy: 8.98 },  // tip 244°
];
/**
 * 每个触点相对前一个的起拍间隔；一整圈 = 12 × 85ms ≈ 1.0s（转速旋钮就是
 * 这个数：70 被判"太快"、100 被判"太慢"，85 是二分出来的）。
 *
 * 脉冲三段 = 挤压 → 蓄压 → 释放（用户点名的感觉，三版定案）：
 *   收（0→11%）：减速压进去（ease-out 形）—— 越压阻力越大，不是砸下去；
 *   憋（11→16%）：在 0.74 停一拍 —— 压力握在手里的那一瞬；
 *   放（16→34%）：back-out 回弹缓动一口气释放，冲过 1 一点再落定 ——
 *     过冲由**曲线**自己完成，不是关键帧硬跳。
 * ⚠️ 这一段不能用 step-end：定格跳帧表达不了弹性（二版失败的根因 ——
 * 三四个瞬移帧看起来是抖动不是弹簧）。描线/显影那些照旧定格。
 */
const RAY_STEP_MS = 85;

/**
 * 活跃态：**星芒自己的触点**顺时针逐个挤压-释放，中心毂随行波呼吸。
 * 形状来自上面的手绘解剖（HUB + RAYS），动画曲线见 RAY_STEP_MS 注释。
 * 版本史：手搓等距射线（判丑：官方触点不等距才是手绘感）→ 外挂转轮
 * （没动到图标本身）→ 楔形 clip 裁官方 path（裂缝要圆片补丁，且只能绕
 * 图心缩）→ 手绘解剖版（本版：根钉毂缘零裂缝，逐根自由变换）。
 */
function SpinnerMark({ size }) {
  const period = RAYS.length * RAY_STEP_MS;
  // 同色描边 0.3：独立形状在共享边上各自抗锯齿，拼缝会透出底色成一圈细线
  // （480px 实测可见）—— 描边让相邻形状彼此搭 0.15，缝就没了；顺带把尖角
  // 磨圆一点，更像笔画的。透明度仍只放 svg 根（同色叠画不叠深）。
  const inkProps = {
    fill: CLAUDE_BRAND, stroke: CLAUDE_BRAND,
    strokeWidth: 0.3, strokeLinejoin: 'round', strokeLinecap: 'round',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      style={{ display: 'block', flexShrink: 0, overflow: 'visible', opacity: 0.95 }}>
      {/* 中心毂：随行波呼吸。只向外鼓（scale ≥ 1）—— 触点的根都钉在毂缘上，
          向内缩就把接缝拉开了 */}
      <path
        d={HUB} {...inkProps}
        style={{
          transformOrigin: '12px 12px', transformBox: 'view-box',
          animation: `ndCoreBreath ${period}ms ease-in-out infinite`,
        }}
      />
      {RAYS.map((r, i) => (
        <path
          key={i} d={r.d} {...inkProps}
          style={{
            // 每根绕自己的根挤压（不是绕图心）—— "往里挤"的方向就是各自的轴向
            transformOrigin: `${r.ox}px ${r.oy}px`, transformBox: 'view-box',
            animation: `ndRayPulse ${period}ms linear infinite`,
            animationDelay: `${i * RAY_STEP_MS - period}ms`,
          }}
        />
      ))}
    </svg>
  );
}

/**
 * 星芒本体。idle = 铅笔描线成形 + 橙显影；active = 放射条脉冲。
 * onClick 给了就可点（对话通道）：按下先来一记"收缩回弹"（Web Animations API
 * 直接在节点上放动画 —— CSS 类名重触发要靠 remount，会把描线动画一起重播）。
 * 动作放在 pointerdown：画布容器的手势会 setPointerCapture，click 根本不生成
 * （BindingLayer 2026-08-14 踩过的同一个坑）。
 */
function SketchMark({ size = 44, active = false, onClick }) {
  const wrapRef = useRef(null);
  const pressable = typeof onClick === 'function';
  const press = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    try {
      wrapRef.current?.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(0.72)', offset: 0.35 },
        { transform: 'scale(1.1)', offset: 0.7 },
        { transform: 'scale(1)' },
      ], { duration: 260, easing: 'ease' });
    } catch { /* 老浏览器没有 WAAPI：没动画也得能点 */ }
    onClick(e);
  };
  return (
    <span
      ref={wrapRef}
      onPointerDown={pressable ? press : undefined}
      title={pressable ? '写一句给 Claude' : undefined}
      style={{
        display: 'block', flexShrink: 0,
        // 命中垫：镜头拉远星芒只剩十几像素，裸命中区点不中很沮丧
        padding: 8, margin: -8,
        pointerEvents: pressable ? 'auto' : 'none',
        cursor: pressable ? 'pointer' : undefined,
      }}
    >
      {active ? <SpinnerMark size={size} /> : (
        <svg
          width={size} height={size} viewBox="0 0 24 24"
          aria-hidden="true" style={{ display: 'block', overflow: 'visible' }}
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
      )}
    </span>
  );
}

/**
 * 逐字显影。笔迹用**画布手写那套栈**（TEXT_FONT_CSS.pen：拉丁走 Caveat、
 * 中文落龙藏体）—— 精灵写的字和用户在白板上写的字必须是同一支笔
 * （2026-08-14 用户点名：之前用楷体，太工整像印出来的）。
 * per-char 延迟随长度收缩：整句写完 ≤ ~1.8s，长句不拖堂。
 */
function Handwriting({ text, delay = MARK_DRAW_MS, size = 26, maxWidth = 340 }) {
  const chars = useMemo(() => Array.from(String(text || '')), [text]);
  if (!chars.length) return null;
  const per = Math.min(60, Math.max(22, Math.round(1600 / chars.length)));
  return (
    <div style={{
      fontFamily: TEXT_FONT_CSS.pen, fontSize: size, lineHeight: 1.45,
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
export function SpriteSketch({ drawKey = 0, text, size = 44, maxWidth = 340, active = false, quiet = false, onMarkClick }) {
  return (
    // ⚠️ width 必须显式给：世界容器是零宽的变换锚点（大家都显式传宽，BindingLayer
    // 的 width/height、舞台卡的 STAGE_CARD_W 同理），绝对定位 + auto 宽在里面会
    // 按 min-content 收缩 —— 真机症状是手写行竖排成一字一列（2026-08-14 踩到）
    <div key={drawKey} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: size + 10 + maxWidth, pointerEvents: 'none' }}>
      <style>{KEYFRAMES}</style>
      <SketchMark size={size} active={active} onClick={onMarkClick} />
      {/* quiet = 用户正往输入行里写字：精灵的话让位（recap 一长会盖住输入行，
          而且"它闭嘴听你说"本来就是对的礼节） */}
      {!quiet && (
        <div style={{ paddingTop: Math.round(size * 0.04) }}>
          <Handwriting key={text} text={text} maxWidth={maxWidth} />
        </div>
      )}
    </div>
  );
}

/**
 * 对话通道的输入行（2026-08-14，用户拍板"icon 也是跟 agent 说话的口子"）：
 * 点星芒 → 精灵脚下浮出一道铅笔虚线，直接打字。没有框没有按钮 ——
 * 在纸上写字给它，Enter 递过去（里德尔日记的吸墨面）。
 * 世界坐标由 BoardCanvas 摆；Esc / 失焦收起。
 */
export function SpriteAskInput({ x, y, width = 350, onSubmit, onClose }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      style={{ position: 'absolute', left: x, top: y, width, zIndex: 320, pointerEvents: 'auto' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={ref}
        placeholder="写一句给 Claude…"
        style={{
          width: '100%', border: 0, outline: 'none', background: 'transparent',
          borderBottom: `1.5px dashed ${PAPER.pencil}`,
          fontFamily: TEXT_FONT_CSS.pen, fontSize: 24, color: PAPER.ink,
          padding: '2px 4px',
        }}
        onKeyDown={(e) => {
          // 拦住：画布上单键换工具、Esc 回上层 —— 不拦就变成打字换工具
          // （产物卡改名输入框同一套拦法）
          e.stopPropagation();
          if (e.key === 'Enter' && !isImeEnter(e)) {
            const t = e.currentTarget.value.trim();
            if (t) onSubmit?.(t);
            onClose?.();
          }
          if (e.key === 'Escape') onClose?.();
        }}
        onBlur={() => onClose?.()}
      />
    </div>
  );
}

// ── 闲时：跟镜头找空位 ──

/** 精灵的身位（找空位按它的外接矩形算；字号放大后 2026-08-14 二调） */
const SPRITE_W = 400;
const SPRITE_H = 100;

/**
 * 贴着工作目标时，精灵下沿离目标上边线留多少（世界单位，2026-08-15 用户报
 * "贴太紧、摘要压产物"后加）。跟纸上题字一样：字要在画的上方留一条呼吸缝。
 */
const WORK_GAP = 26;

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

// ── 输出框（代码直播 / 终端）的落位 ──

/** 输出框身位：宽沿用舞台卡口径，高按"头 + 代码体 maxHeight 280"估 */
const FRAME_W = STAGE_CARD_W;
const FRAME_H_EST = 340;

/**
 * 输出框绕着精灵找位（2026-08-14 用户拍板：代码直播框跟精灵同层同住，
 * 以精灵为圆心保持在一定范围内；可以压产物，但要有算法尽量别压）。
 * 候选四方位按偏好序（脚下 → 右 → 左 → 头顶），第一个不压任何产物的赢；
 * 全都压着东西就挑压得最少的 —— "宁可压也不消失"，这跟精灵本体的
 * "全占就不出现"规矩刻意相反：闲话可以不说，正在写的代码必须看得见。
 */
export function findFrameSpot(at, obstacles) {
  if (!at) return null;
  const candidates = [
    { x: at.x, y: at.y + SPRITE_H + 14 },
    { x: at.x + SPRITE_W + 24, y: at.y },
    { x: at.x - FRAME_W - 24, y: at.y },
    { x: at.x, y: at.y - FRAME_H_EST - 22 },
  ];
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    let cost = 0;
    for (const o of obstacles || []) {
      const ow = Math.min(c.x + FRAME_W, o.x + o.w) - Math.max(c.x, o.x);
      const oh = Math.min(c.y + FRAME_H_EST, o.y + o.h) - Math.max(c.y, o.y);
      if (ow > 0 && oh > 0) cost += ow * oh;
    }
    if (cost === 0) return c;
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return best;
}

/**
 * 精灵层（**世界层**，挂在被相机变换的容器里）。2026-08-14 五批起是**唯一**
 * 的精灵家：工作/闲时不再是两个挂载点 —— 那套的缝隙正是用户报的"活跃真空"
 * （run 早期 / 纯思考 / 无文件工具阶段既没有目标矩形也不算闲，精灵整段消失，
 * 放射条动画从来没机会出现）。
 *
 * 位置只有一条决策链：
 *   - workAnchor 给了（agent 正在动某件东西且解析得到矩形）→ 贴着它（位置
 *     过渡"走过去"），槽位状态冻结在原地
 *   - 没有 anchor → 槽位逻辑：首次出场按视口找槽；平移缩放钉在纸上不动；
 *     离开视野 3 秒才追过来重新落位重画；视口全被占就不出现。
 *     **活跃与否不影响这条链** —— 活跃只换图标（转轮）和台词。
 */
export function AmbientSpriteLayer({ agentActive = false, workAnchor = null, cam, viewport, obstacles, text, quiet = false, onAsk, frameCards = [], renderFrameCard }) {
  const [slot, setSlot] = useState(null);      // 世界坐标
  const [drawKey, setDrawKey] = useState(0);
  const stateRef = useRef({});
  stateRef.current = { cam, viewport, obstacles };
  const offTimer = useRef(null);

  useEffect(() => {
    if (workAnchor || !viewport?.w || !cam?.z) {
      // 贴着目标时槽位冻结：回到无目标态再说
      clearTimeout(offTimer.current); offTimer.current = null;
      return undefined;
    }
    if (!slot) {
      const first = findAmbientSlot(cam, viewport, obstacles);
      if (first) { setDrawKey(k => k + 1); setSlot(first); }
      return undefined;
    }
    // 工作中不跟镜头（2026-08-14 用户定的规则）：agent 干活的地方就是它站的
    // 地方，用户把镜头挪去看别处，它不追过来 —— 追随只是闲时的礼节。
    if (agentActive) {
      clearTimeout(offTimer.current); offTimer.current = null;
      return undefined;
    }
    if (slotVisible(slot, cam, viewport)) {
      clearTimeout(offTimer.current); offTimer.current = null;
    } else if (!offTimer.current) {
      // ⚠️ 计时器不进 effect cleanup —— cleanup 每次相机变化都跑，进去的话
      // 用户持续平移时 3 秒永远数不满。只在可见/换态时显式清。
      offTimer.current = setTimeout(() => {
        offTimer.current = null;
        const { cam: c, viewport: vp, obstacles: obs } = stateRef.current;
        const next = findAmbientSlot(c, vp, obs);
        if (next) { setDrawKey(k => k + 1); setSlot(next); }
      }, OFFSCREEN_RELOCATE_MS);
    }
    return undefined;
  }, [workAnchor, agentActive, cam, viewport, obstacles, slot]);

  // 卸载兜底：不走上面的显式清理路径时别让计时器对着空组件开枪
  useEffect(() => () => clearTimeout(offTimer.current), []);

  // 贴目标时：以**精灵的下沿**吊在目标上边线之上（transform: translateY(-100%)），
  // 而不是把它的上沿钉在目标上方固定 56px —— 手写行是一到三行不等的，按上沿钉
  // 就等于"句子越长压产物越多"（2026-08-15 用户报：摘要经常和产物重叠）。
  // 下沿吊法与句长无关，留白恒定。
  const anchored = !!workAnchor;
  const at = anchored
    ? { x: Math.round(workAnchor.x - 14), y: Math.round(workAnchor.y - WORK_GAP) }
    : slot;
  // 输出框和输入行要的是精灵**外接框的左上角**：吊着的时候它在 at 之上一个身位
  const box = at && anchored ? { x: at.x, y: at.y - SPRITE_H } : at;

  // 输出框落位：精灵在哪它就绕着哪找位。obstacles 变一次（产物增删/拖动落盘）
  // 才重算 —— 流式打字每拍都重排的话框会来回蹦。
  const hasFrames = frameCards.length > 0 && typeof renderFrameCard === 'function';
  const frameSpot = useMemo(
    () => (hasFrames ? findFrameSpot(box, obstacles) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFrames, box?.x, box?.y, obstacles],
  );

  if (!at || !text) return null;
  return (
    <>
      <div style={{
        position: 'absolute', left: at.x, top: at.y, zIndex: 305, pointerEvents: 'none',
        // 贴目标时整块往上吊一个自身高度：留白就跟手写行有几行无关了
        transform: anchored ? 'translateY(-100%)' : undefined,
        // 目标间移动是"走过去"；槽位重落走 drawKey 重画（定格换场），过渡不碍事
        transition: 'left 300ms cubic-bezier(0.32,0.72,0,1), top 300ms cubic-bezier(0.32,0.72,0,1)',
      }}>
        <SpriteSketch
          drawKey={drawKey} text={text} active={agentActive} quiet={quiet}
          // 对话通道：点星芒 → 在它脚下写一句（输入行位置 = 图标右下，
          // 从**当前落点**算 —— recap 长文遮挡输入行的病由 quiet 让位治）
          onMarkClick={onAsk ? () => onAsk({ x: box.x + 54, y: box.y + 50 }) : undefined}
        />
      </div>
      {/* 输出框（代码直播/终端）：跟着精灵走，绕它找不压产物的方位
          （findFrameSpot；全压就认最小遮挡）。并发多张只露最近两张 ——
          第三张起在聊天时间轴里永远有，画布不摆尸体墙。 */}
      {hasFrames && frameSpot && (
        <div style={{
          position: 'absolute', left: frameSpot.x, top: frameSpot.y, width: FRAME_W,
          zIndex: 304, pointerEvents: 'auto',
          display: 'flex', flexDirection: 'column', gap: 10,
          transition: 'left 300ms cubic-bezier(0.32,0.72,0,1), top 300ms cubic-bezier(0.32,0.72,0,1)',
        }}>
          {frameCards.slice(-2).map((c) => (
            <div key={c.blockId}>{renderFrameCard(c)}</div>
          ))}
        </div>
      )}
    </>
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
