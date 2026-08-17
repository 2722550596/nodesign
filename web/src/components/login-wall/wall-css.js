/**
 * 登录墙的**材质词汇** —— 全场景共用的那一半 CSS（2026-08-17 从 AuthGate 拆出）。
 *
 * 切口是用户当初定的那句话：**能共用的是材质，不是坐标**。所以这里只有
 * 「一张纸长什么样」——板面、纸基座与三档景深、纸材（便签/方格纸/终端墨版/
 * 牛皮卷宗/小票/黄笺/索引卡/描图纸）、固定件（图钉/回形针/订书钉）、瑕疵
 * （折痕/褶皱/折角/装订孔）、编号红圈、线索线、板上的字、登记卡。
 *
 * **每张纸摆在哪、上面写什么，不在这儿** —— 那是一套构图的事，住在
 * `scenes/<id>.jsx` 里，跟着场景一起换。想加一面新墙就加一个场景文件，
 * 不用动这里。
 *
 * 为什么不把纸也抽成「纸材类 + 位置数据」那种统一描述：试过就知道，每张纸
 * 的内部构造（线框图的方块、终端的行、卷宗的签和装订孔）都是为那一处专门
 * 画的，硬塞进统一 schema 只会让每个场景都在跟 schema 打架。墙是**设计**
 * 不是数据。
 */
import { PAPER_VARS } from '../../lib/paper.js';
import { DESIGN_W, DESIGN_H } from './geometry.js';

/**
 * 定格切换的节拍（毫秒）。**CSS 和 JS 必须用同一份**：轮播那边要知道
 * 「摘完了没有」才能换场景，写两处就会出现纸还没摘完新场景已经钉上来。
 * `step*` 是每张纸之间错开的一格 —— 手不可能同时钉八张。
 */
export const MOTION = { enter: 340, leave: 260, stepIn: 52, stepOut: 34, inkDelay: 120 };

/**
 * 一次切换总共要多久 —— 轮播的定时器按它算。
 *
 * ⚠️ 进场的尾巴不是最后一张纸，是**红线那一拨**：它要等所有纸钉完才开始画
 * （见下面的注释）。按纸算完就摘 class 的话，线会在半路被掐掉直接跳到全黑。
 */
export const leaveMs = (n) => MOTION.leave + Math.max(0, n - 1) * MOTION.stepOut;
export const enterMs = (n) => MOTION.inkDelay + n * MOTION.stepIn + 300 + 240;

export const WALL_CSS = `
.ndw {
  ${PAPER_VARS}
  position: fixed; inset: 0; overflow: hidden;
  font-family: var(--kai); color: var(--ink);
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(ellipse 120% 90% at 50% 118%, rgba(80,62,40,0.08), transparent 55%),
    linear-gradient(105deg, transparent 50%, rgba(255,244,210,0.30) 51% 58%, transparent 59%, transparent 64%, rgba(255,244,210,0.22) 66% 70%, transparent 71%),
    radial-gradient(ellipse 90% 70% at 80% 4%, rgba(255,210,130,0.22), transparent 62%),
    /* 大块斑驳：板子不是一块匀色板 */
    radial-gradient(ellipse 46% 40% at 16% 26%, rgba(122,96,56,0.055), transparent 72%),
    radial-gradient(ellipse 38% 46% at 72% 74%, rgba(122,96,56,0.05), transparent 74%),
    radial-gradient(ellipse 30% 28% at 94% 20%, rgba(255,246,218,0.45), transparent 72%),
    radial-gradient(ellipse 26% 30% at 4% 84%, rgba(122,96,56,0.045), transparent 72%),
    radial-gradient(ellipse 40% 30% at 10% 66%, rgba(93,74,44,0.045), transparent 70%),
    radial-gradient(ellipse 34% 26% at 90% 40%, rgba(93,74,44,0.04), transparent 70%),
    var(--grain),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.03) 0 1px, transparent 1px 28px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.03) 0 1px, transparent 1px 28px),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.022) 0 1px, transparent 1px 140px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.022) 0 1px, transparent 1px 140px),
    var(--wall);
}
/* 织纹 + 旧钉眼：三层不同周期错开，看不出重复 */
.ndw::before {
  content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background:
    radial-gradient(circle at 37px 51px, rgba(72,55,32,0.17) 0 1.1px, transparent 1.7px),
    radial-gradient(circle at 119px 23px, rgba(72,55,32,0.14) 0 1px, transparent 1.6px),
    radial-gradient(circle at 61px 137px, rgba(72,55,32,0.12) 0 1.2px, transparent 1.8px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.019) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.015) 0 1px, transparent 1px 3px);
  background-size: 163px 211px, 271px 149px, 197px 313px, auto, auto;
}
/* 旧痕：这儿以前挂过东西，取下来了 */
.ndw-ghost { position: absolute; z-index: 0; pointer-events: none;
  background: rgba(255,252,240,0.22); border-radius: 1px;
  box-shadow: 0 0 0 1px rgba(43,33,23,0.02), 0 0 12px 7px rgba(255,252,240,0.1); }
.ndw-ghost::after { content: ''; position: absolute; left: 50%; top: 5px; width: 3px; height: 3px;
  margin-left: -1.5px; border-radius: 50%; background: rgba(72,55,32,0.26); }
.ndw * { margin: 0; padding: 0; box-sizing: border-box; }

/* 整面墙 = 一张 1500x800 的设计稿，顶边对齐缩放 */
.ndw-stage {
  position: absolute; z-index: 1; left: 50%; top: 0;
  margin-left: -${DESIGN_W / 2}px;
  width: ${DESIGN_W}px; height: ${DESIGN_H}px;
  transform: scale(var(--s, 1));
  transform-origin: top center;
}
/* 随手涂鸦：直接画在板子上，压在所有纸底下。是墙的一部分，不是挂件。
   素材是真 alpha 不是白底 —— 涂鸦在 .ndw-stage 里，stage 的 transform 开了新的
   层叠上下文，mix-blend-mode 够不着画在根节点上的板面，白底会原样糊一块上去。
   每个涂鸦都自带一句手写，字和画是同一次生成的（见 DOODLES 注释） */
.ndw .doodle { position: absolute; z-index: 1; pointer-events: none;
  opacity: 0.55; display: block; }

/* ===== 纸 =====
   层次靠三样：①阴影分三档且带光向（右上打光→影子一律偏左下，全站同一个方向）
   ②纸叠纸（背后垫一张露边的空纸）③底边起拱（单钉吊着的纸会往外弯） */
.ndw .paper { position: absolute; background-color: var(--paper); background-image: var(--grain);
  box-shadow: -1px 2px 3px rgba(93,74,44,0.15), -3px 6px 12px rgba(93,74,44,0.15);
  transform: rotate(var(--rot, 0deg)); transform-origin: 50% 7px; z-index: 2; }
/* 最远：贴得最平，影子小而紧，再退半档空气感 */
.ndw .paper.z0 { box-shadow: -1px 1px 2px rgba(93,74,44,0.14), -1px 3px 5px rgba(93,74,44,0.09);
  filter: brightness(0.976) saturate(0.93); }
/* 最近：影子大而散 */
.ndw .paper.z2 { box-shadow: -2px 3px 4px rgba(93,74,44,0.18), -6px 13px 26px rgba(93,74,44,0.22); }
/* 垫在后面那张空纸：只露一道边 */
.ndw .pstack { z-index: 1; background-color: #F8F3E7;
  box-shadow: -1px 2px 4px rgba(93,74,44,0.13), -2px 5px 9px rgba(93,74,44,0.11); }
/* 底边起拱：单钉吊着的纸，下缘往外弯，中间背光 */
.ndw .bow { position: absolute; left: 0; right: 0; bottom: 0; height: 32%; z-index: 3;
  pointer-events: none;
  background: radial-gradient(130% 100% at 50% 112%, rgba(43,33,23,0.07), transparent 62%); }
@keyframes ndw-sway {
  0%, 100% { transform: rotate(calc(var(--rot, 0deg) - 0.32deg)); }
  50%      { transform: rotate(calc(var(--rot, 0deg) + 0.32deg)); }
}
.ndw .sway { animation: ndw-sway var(--dur, 6s) ease-in-out var(--delay, 0s) infinite; }
@media (prefers-reduced-motion: reduce) { .ndw .sway { animation: none; } }

/* 固定件：一张纸一种，别都用钉 */
.ndw .pin { position: absolute; top: 6px; left: 50%; width: 9px; height: 9px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #8a7a62, #453a2c 65%);
  box-shadow: -1px 2px 3px rgba(43,33,23,0.45); transform: translateX(-50%); z-index: 6; }
.ndw .pin.r { background: radial-gradient(circle at 35% 30%, #b4544a, #7d241c 65%); }
.ndw .clip { position: absolute; top: -13px; left: var(--cx, 22%); width: 17px; z-index: 6;
  filter: drop-shadow(-1px 2px 2px rgba(43,33,23,0.32)); }
.ndw .staple { position: absolute; top: 9px; left: var(--cx, 12px); width: 15px; height: 4px; z-index: 6;
  transform: rotate(-28deg); background: linear-gradient(180deg, #b9b2a4, #6f6759);
  box-shadow: -1px 1.5px 1.5px rgba(43,33,23,0.45); }

/* 瑕疵 */
.ndw .crease::before { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background: linear-gradient(112deg, transparent 47.6%, rgba(43,33,23,0.045) 49.1%, rgba(255,255,255,0.22) 49.9%, transparent 51.2%); }
.ndw .crease-h::before { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background: linear-gradient(178deg, transparent 48%, rgba(43,33,23,0.05) 49.6%, rgba(255,255,255,0.2) 50.4%, transparent 52%); }
.ndw .wrinkle::after { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background:
    linear-gradient(99deg, transparent 20%, rgba(43,33,23,0.035) 30%, transparent 40%),
    linear-gradient(84deg, transparent 62%, rgba(255,255,255,0.4) 70%, transparent 79%); }
.ndw .dog::after { content: ''; position: absolute; right: 0; bottom: 0; width: 24px; height: 24px;
  pointer-events: none; z-index: 4;
  background: linear-gradient(315deg, var(--wall) 48%, rgba(43,33,23,0.14) 50%, rgba(255,255,254,0.85) 58%, rgba(240,234,219,0.2) 72%, transparent 78%);
  box-shadow: -1px -1px 2px rgba(43,33,23,0.05); }
.ndw .holes { position: absolute; left: 8px; top: 17%; height: 66%; width: 8px; z-index: 4;
  background-image: radial-gradient(circle at 50% 50%, rgba(43,33,23,0.3) 0 3px, transparent 3.6px);
  background-size: 8px 33.33%; background-repeat: repeat-y; }

/* 编号：手写红圈，读顺序全靠它 */
.ndw .no { position: absolute; left: -15px; top: -14px; width: 30px; height: 30px; z-index: 7;
  display: grid; place-items: center; font: 700 13px var(--kai); color: var(--red); }
.ndw .no svg { position: absolute; inset: 0; width: 100%; height: 100%; }

/* 线索线 */
.ndw-thread { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 5; pointer-events: none; }
.ndw-thread path { fill: none; stroke: var(--red); stroke-width: 2; stroke-linecap: round; opacity: 0.72; }
.ndw-thread .soft { opacity: 0.5; stroke-width: 1.7; }
.ndw .hand { position: absolute; font: 13px var(--kai); color: var(--red); z-index: 7; opacity: 0.9;
  white-space: nowrap; }
.ndw .hand.p { color: var(--pencil); }

/* 直接写在板上的字：不带纸，压在所有纸之下 */
.ndw .wall { position: absolute; z-index: 1; pointer-events: none; color: rgba(122,111,92,0.92); }
.ndw .wall.lbl { font: 12px var(--kai); letter-spacing: 0.1em; color: rgba(130,119,99,0.88); }
.ndw .wall.blk { font: 12px var(--kai); line-height: 2.05; }
.ndw .wall.blk .t { display: block; font-weight: 700; font-size: 22px; letter-spacing: 0.1em;
  line-height: 1.3; color: rgba(104,93,76,0.95); }
.ndw .wall.blk .rule { display: block; width: 118px; height: 7px; margin: 5px 0 5px; }
.ndw .wall.blk .n { font-size: 15px; color: rgba(140,127,104,0.95); }
.ndw .when { display: block; margin-top: 7px; font: 9.5px var(--kai); letter-spacing: 0.08em;
  color: var(--pencil); }

/* 标题 */
.ndw-head { position: absolute; left: 3.5%; top: 5.5%; z-index: 3; max-width: 34%; }
.ndw-head .row { display: flex; align-items: baseline; gap: 13px; }
.ndw-logo { font: 700 24px var(--kai); letter-spacing: 0.06em; }
.ndw-anno { font: 11.5px var(--kai); color: var(--pencil); letter-spacing: 0.16em; }
.ndw-head h1 { margin-top: 18px; font-size: 33px; font-weight: 700; letter-spacing: 0.04em; }
.ndw-head h1 .u { position: relative; white-space: nowrap; }
.ndw-head h1 .u svg { position: absolute; left: -2%; width: 104%; height: 9px; bottom: -6px; }
.ndw-sub { margin-top: 12px; font-size: 14.5px; line-height: 1.85; color: var(--ink-2); }

.ndw-card { position: absolute; right: 4%; top: 19%; width: 25%; padding: 34px 36px 26px;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: -3px 4px 6px rgba(93,74,44,0.2), -9px 18px 34px rgba(93,74,44,0.26);
  transform: rotate(-0.4deg); transform-origin: 50% 8px; z-index: 8; }
.ndw-card h2 { font: 700 21px var(--kai); letter-spacing: 0.05em; }
.ndw-card .m { margin-top: 4px; font-size: 13px; color: var(--pencil); }
.ndw-tabs { margin-top: 19px; display: flex; gap: 24px; }
.ndw-tabs button { background: none; border: none; padding: 0 0 7px; cursor: pointer;
  font: 15px var(--kai); color: var(--pencil); position: relative; }
.ndw-tabs button.on { color: var(--ink); font-weight: 700; }
.ndw-tabs button svg { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 6px; }
.ndw-field { margin-top: 17px; }
.ndw-field label { display: block; font: 11px var(--kai); letter-spacing: 0.2em; color: var(--pencil); }
.ndw-field input { width: 100%; margin-top: 3px; padding: 8px 2px; font-size: 16px; font-family: var(--kai);
  background: transparent; border: none; border-bottom: 1.5px solid var(--hair); outline: none; color: var(--ink); }
.ndw-field input::placeholder { color: var(--pencil); }
.ndw-field input:focus { border-bottom-color: var(--ink); }
.ndw-err { margin-top: 12px; min-height: 17px; font: 12.5px var(--kai); color: var(--red); }
.ndw-card button.go { width: 100%; margin-top: 10px; padding: 12px 0; font: 700 16px var(--kai);
  letter-spacing: 0.35em; text-indent: 0.35em; background: var(--ink); color: #F5F0E4;
  border: none; border-radius: 3px; cursor: pointer; }
.ndw-card button.go:disabled { opacity: 0.55; cursor: default; }
.ndw-card .foot { margin-top: 13px; font: 12px var(--kai); color: var(--pencil); text-align: center; }
.ndw-stamp { position: absolute; right: 22px; top: 22px; padding: 4px 12px; border: 1.5px solid var(--red);
  color: var(--red); border-radius: 3px; font: 12px var(--kai); letter-spacing: 0.24em;
  text-indent: 0.24em; transform: rotate(3deg); opacity: 0.85; }

/* ===== 窄屏：整面墙收起，只留登记卡 ===== */
.ndw.narrow { display: grid; place-items: center; padding: 24px; }
.ndw.narrow .ndw-stage { display: none; }
/* 窄屏那张卡沿用 .ndw-card 的全部内部样式，只把定位和宽度改掉 */
.ndw-solo { position: relative; right: auto; top: auto;
  width: 100%; max-width: 360px; padding: 32px 30px 24px; }
.ndw-solo .brand { display: block; font: 700 20px var(--kai);
  letter-spacing: 0.06em; margin-bottom: 16px; }
/* ===== 定格切换（2026-08-17）=====
   用户的原话是「定格动画那种感觉」—— 不是淡入淡出、不是平滑位移，是一帧一帧
   跳的手做感。所以两条动画都走 「steps()」：浏览器只在那几个整数帧上采样，中间
   的插值全部被丢掉，看着就是有人一张一张把纸钉上去 / 摘下来。

   每张纸自带 「--i」（第几张），延迟 = i × 一格的时间 —— 手不可能同时钉八张。
   摘的时候顺序反过来（后钉的先摘），像倒放。 */
.ndw-scene { position: absolute; inset: 0; }
@keyframes ndw-pin-in {
  0%   { opacity: 0; transform: rotate(calc(var(--rot, 0deg) + 3deg)) translate(6px, -14px); }
  100% { opacity: 1; transform: rotate(var(--rot, 0deg)) translate(0, 0); }
}
@keyframes ndw-pin-out {
  0%   { opacity: 1; transform: rotate(var(--rot, 0deg)) translate(0, 0); }
  100% { opacity: 0; transform: rotate(calc(var(--rot, 0deg) - 4deg)) translate(-9px, 16px); }
}
/* 板上的字、涂鸦、线索线没有 --rot，单独一套（只跳明暗，不跳位置） */
@keyframes ndw-ink-in  { from { opacity: 0 } to { opacity: 1 } }
@keyframes ndw-ink-out { from { opacity: 1 } to { opacity: 0 } }

/* ⚠️ 这两条要压得过 「.ndw .sway」（那是常驻的风吹纸摆，也写在 animation 上）。
   压得过靠的是特异度：「.ndw-scene.enter .paper」 是 (0,3,0)，「.ndw .sway」 是
   (0,2,0)。别把它改成 「.ndw-scene .paper.enter」 那种写法 —— 一旦打平，两条
   动画抢同一个 transform，纸会在切换那一瞬瞬移。 */
.ndw-scene.enter .paper {
  animation: ndw-pin-in ${MOTION.enter}ms steps(3, jump-none) both;
  animation-delay: calc(var(--i, 0) * ${MOTION.stepIn}ms);
}
.ndw-scene.leave .paper {
  animation: ndw-pin-out ${MOTION.leave}ms steps(2, jump-none) both;
  animation-delay: calc(var(--out, 0) * ${MOTION.stepOut}ms);
}
/* 墨迹分两拨上，**顺序是有意义的**：
   ①「板上的东西」—— 随手涂鸦和写在板子上的字。它们画在板面本身，纸是后来
      钉上去压在它们上面的，所以先出现。
   ②「串纸的东西」—— 红线和手写标签。线是用来连两张纸的，纸还没钉上去线就
      先浮出来，读起来是反的（第一版就是这样，抓过一帧看见线先到）。所以
      它们等**所有纸都钉完**再上：延迟 = 纸的张数 × 一格。
   都走 steps，5 格比纸更碎一点，像墨慢慢洇出来。 */
.ndw-scene.enter .doodle, .ndw-scene.enter .wall {
  animation: ndw-ink-in 300ms steps(5, jump-none) both;
  animation-delay: calc(var(--i, 0) * 40ms);
}
.ndw-scene.enter .hand, .ndw-scene.enter .ndw-thread {
  animation: ndw-ink-in 300ms steps(5, jump-none) both;
  animation-delay: calc(${MOTION.inkDelay}ms + var(--pins, 20) * ${MOTION.stepIn}ms + var(--i, 0) * 60ms);
}
.ndw-scene.leave .doodle, .ndw-scene.leave .hand,
.ndw-scene.leave .wall, .ndw-scene.leave .ndw-thread {
  animation: ndw-ink-out 200ms steps(3, jump-none) both;
}
@media (prefers-reduced-motion: reduce) {
  .ndw-scene.enter *, .ndw-scene.leave * { animation: none !important; opacity: 1 !important; }
}
`;
