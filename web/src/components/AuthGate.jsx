/**
 * AuthGate — 登录墙（2026-07-30 多用户版；2026-08-03 线索墙改版）
 *
 * 挂载时查 /api/auth/status：
 *   - required=false（dev 模式）或已有有效身份 → 渲染 app，并把 user 挂到
 *     globalStore（顶栏显示用户名 / 登出、admin 判定都从那读）
 *   - 否则渲染登录页；「邀请码注册」tab 给内测新用户自助开号
 *
 * 全局 401：api.js jsonRequest 收到 401 时派发 `nd:unauthorized` window 事件，
 * 这里监听 → 回登录态（解决 cookie 过期后散落报错、WS 4401 停止重连后卡死）。
 *
 * cookie 是 HttpOnly + 30 天，同源 fetch 自动携带。
 *
 * 门面（2026-08-03 改版）：一面钉满纸的线索墙，读的是「一件作品从一句话到上线」
 * 的六个节拍（①~⑥，红线串起来，最后一箭指向登记卡）。排布本身要有因果，不是
 * 一堆好看的纸摆在一起。这个页面在鉴权之前，不能走 /api，也绝不引用真实用户数据，
 * 墙上的内容全是写死的样例。
 *
 * 尺寸策略：整面墙是一张 1500x800 的设计稿，对着 1500x780 的安全框做 contain、
 * 顶边对齐 —— 位置全用设计稿坐标，任何视口下构图都不会散，竖向富余一律留给底边
 * （底排纸本来就设计成出血），顶边永不裁。窄屏（<980px）整面墙收起，只留登记卡。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useGlobalStore } from '../stores/globalStore.js';
import kaiRegular from '../assets/fonts/lxgw-nd-regular.woff2';
import kaiBold from '../assets/fonts/lxgw-nd-bold.woff2';
import artNight from '../assets/login-wall/ink-night.webp';
import artDesk from '../assets/login-wall/ink-desk.webp';
import artPortrait from '../assets/login-wall/ink-portrait.webp';
import artPlane from '../assets/login-wall/ink-plane.webp';
import dTangle from '../assets/login-wall/doodles/tangle.webp';
import dReject from '../assets/login-wall/doodles/reject.webp';
import dBulb from '../assets/login-wall/doodles/bulb.webp';
import dThumb from '../assets/login-wall/doodles/thumb.webp';
import dQuestion from '../assets/login-wall/doodles/question.webp';
import dClock from '../assets/login-wall/doodles/clock.webp';

/**
 * 板子上的随手涂鸦。**字是和画一起生成的**，不是 CSS 排上去的 ——
 * 用户要的是「写的话都不工整，但看起来很有条理很舒服」，字体排不出那个手感。
 * 每一个都是一句话不是一个物件；尺寸跨度 46~185（四倍）。
 */
const DOODLES = [
  { src: dBulb,     left: '0.3%',  top: '25%',   w: 46,  rot: -7 },  // 有了
  { src: dClock,    left: '46.7%', top: '21.5%', w: 68,  rot: 6 },   // 周五前
  { src: dQuestion, left: '48.5%', top: '43%',   w: 78,  rot: 4 },   // 先放着
  { src: dThumb,    left: '48.3%', top: '76%',   w: 96,  rot: -8 },  // 这版过
  { src: dTangle,   left: '83.3%', top: '72.5%', w: 150, rot: -4 },  // 突然通了
  { src: dReject,   left: '1%',    top: '45%',   w: 185, rot: -3 },  // 这版不行
];

const DESIGN_W = 1500;
const DESIGN_H = 800;
// 安全框比设计稿矮一点：底排纸本来就设计成出血，少的这 20px 正好当出血量
const SAFE_H = 780;

const CSS = `
@font-face {
  font-family: 'LXGW WenKai ND';
  src: url('${kaiRegular}') format('woff2');
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'LXGW WenKai ND';
  src: url('${kaiBold}') format('woff2');
  font-weight: 700; font-style: normal; font-display: swap;
}

.ndw {
  --wall: #F0EADB;
  --paper: #FFFEF6;
  --legal: #FAF0C6;
  --kraft: #E2D3B4;
  --sticky: #FBF3CF;
  --ink: #2B2117;
  --ink-2: #5F5142;
  --pencil: #A39882;
  --hair: rgba(43,33,23,0.22);
  --red: #A8362B;
  --kai: 'LXGW WenKai ND', 'LXGW WenKai', '霞鹜文楷', serif;
  --code: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 0.17 0 0 0 0 0.13 0 0 0 0 0.06 0 0 0 0.1 0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");

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

/* ① 一句话 */
.ndw .b1 { left: 3.5%; top: 31%; width: 11%; padding: 13px 13px 15px;
  background-color: var(--sticky);
  background-image: linear-gradient(180deg, rgba(43,33,23,0.05) 0 9px, transparent 9px), var(--grain);
  font: 13px var(--kai); line-height: 1.72; color: var(--ink-2);
  box-shadow: -1px 3px 5px rgba(93,74,44,0.16), -3px 8px 14px rgba(93,74,44,0.16); }
.ndw .who { display: block; margin-bottom: 5px; font: 10px var(--kai); color: var(--pencil); letter-spacing: 0.16em; }

/* ② 骨架 */
.ndw .b2 { left: 17%; top: 34.5%; width: 13%; padding: 13px 13px 11px;
  background-image: var(--grain),
    repeating-linear-gradient(0deg, rgba(74,107,143,0.11) 0 1px, transparent 1px 13px),
    repeating-linear-gradient(90deg, rgba(74,107,143,0.11) 0 1px, transparent 1px 13px); }
.ndw .b2 .wf { border: 1.5px solid var(--ink-2); height: 78px; position: relative; opacity: 0.82; }
.ndw .b2 .wf i { position: absolute; border: 1px solid var(--ink-2); }
.ndw .b2 .wf b { position: absolute; left: 8%; top: 42%; right: 46%; height: 4px; background: rgba(43,33,23,0.3); }
.ndw .b2 .cap { margin-top: 8px; font: 11.5px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .b2 .cap b { font: 9.5px var(--code); color: var(--pencil); font-weight: 400; }

/* ③ 终端墨版 */
.ndw .b3 { left: 33%; top: 31.5%; width: 15%; padding: 11px 13px 12px; border-radius: 3px;
  background: linear-gradient(180deg, #2b2318, #241d14);
  box-shadow: 0 4px 11px rgba(43,33,23,0.34), 0 1px 2px rgba(43,33,23,0.2);
  font: 10px var(--code); color: #E4DCC8; line-height: 2.05; }
.ndw .b3 .t { font: 600 9px var(--code); letter-spacing: 0.16em; color: #9b917c;
  border-bottom: 1px solid rgba(228,220,200,0.16); padding-bottom: 6px; margin-bottom: 7px; }
.ndw .b3 .ok { color: #9DBF9A; }
.ndw .b3 .dim { color: #8A8069; }
.ndw .b3 .tail { margin-top: 7px; font-size: 9px; color: #8A8069; }
.ndw .b3 .cur { display: inline-block; width: 6px; height: 11px; background: #E4DCC8;
  vertical-align: -1px; opacity: 0.75; }

/* ④ 成品 */
.ndw .b4 { left: 5%; top: 60%; width: 19.5%; padding: 9px 9px 7px; }
.ndw .b4 img { width: 100%; display: block; }
.ndw .b4 .cap { padding-top: 7px; padding-right: 20px; font: 12px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .b4 .cap b { font: 9.5px var(--code); color: var(--pencil); font-weight: 400; }

/* ⑤ 批注 */
.ndw .b5 { left: 27%; top: 63%; width: 10.5%; padding: 12px 12px 14px;
  background-color: var(--sticky);
  background-image: linear-gradient(180deg, rgba(43,33,23,0.05) 0 8px, transparent 8px), var(--grain);
  font: 12.5px var(--kai); line-height: 1.7; color: var(--red);
  box-shadow: -1px 3px 5px rgba(93,74,44,0.16), -3px 8px 14px rgba(93,74,44,0.16); }

/* ⑥ 上线 */
.ndw .b6 { left: 39.5%; top: 61%; width: 15.5%; padding: 13px 15px 14px 22px;
  background-color: var(--kraft); background-image: var(--grain); }
.ndw .b6 .tab { position: absolute; top: -13px; left: 16px; background: var(--kraft); padding: 2px 13px;
  font: 11.5px var(--kai); color: var(--ink-2); border-radius: 4px 4px 0 0; }
.ndw .b6 .t { font: 700 14.5px var(--kai); padding-right: 74px; }
.ndw .b6 .d { margin-top: 3px; font: 11.5px var(--kai); line-height: 1.65; color: var(--ink-2); }
.ndw .b6 .r { margin-top: 9px; padding-top: 7px; border-top: 1px solid rgba(95,81,66,0.3);
  font: 9.5px var(--kai); letter-spacing: 0.06em; color: rgba(95,81,66,0.8);
  display: flex; justify-content: space-between; }
.ndw .b6 .live { position: absolute; right: 13px; top: 14px; padding: 3px 9px; border: 1.5px solid var(--red);
  border-radius: 2px; font: 11px var(--kai); color: var(--red); letter-spacing: 0.16em;
  text-indent: 0.16em; transform: rotate(-4deg); opacity: 0.82; }

/* 侧料 */
.ndw .s-legal { left: 56.5%; top: 5%; width: 12.5%; padding: 15px 14px 16px;
  background-color: var(--legal);
  background-image: var(--grain), repeating-linear-gradient(0deg, transparent 0 25px, rgba(168,54,43,0.15) 25px 26px);
  clip-path: polygon(0 5px, 4% 0, 8% 5px, 12% 0, 16% 5px, 20% 0, 24% 5px, 28% 0, 32% 5px, 36% 0, 40% 5px, 44% 0, 48% 5px, 52% 0, 56% 5px, 60% 0, 64% 5px, 68% 0, 72% 5px, 76% 0, 80% 5px, 84% 0, 88% 5px, 92% 0, 96% 5px, 100% 0, 100% 100%, 0 100%); }
.ndw .s-legal .h { font: 700 14px var(--kai); margin-bottom: 6px; }
.ndw .s-legal li { list-style: none; font: 13px var(--kai); line-height: 25px; color: var(--ink-2); }
.ndw .s-legal li i { font-style: normal; color: var(--red); margin-right: 5px; }

.ndw .s-index { left: 57.5%; top: 27%; width: 12.5%; padding: 13px 14px 16px;
  background-image: var(--grain),
    repeating-linear-gradient(180deg, transparent 0 25px, rgba(74,107,143,0.13) 25px 26px); }
.ndw .s-index .h { font: 700 13px var(--kai); border-bottom: 1.5px solid rgba(168,54,43,0.35); padding-bottom: 5px; }
.ndw .s-index .b { margin-top: 7px; font: 12.5px var(--kai); line-height: 1.8; color: var(--ink-2); }

.ndw .s-strip { left: 57.5%; top: 39%; width: 10%; padding: 17px 12px 10px;
  background-color: #E9D8BB; background-image: var(--grain);
  font: 12px var(--kai); color: var(--ink-2); text-align: center;
  clip-path: polygon(3% 0, 97% 0, 100% 24%, 96% 47%, 100% 72%, 97% 100%, 3% 100%, 0 76%, 4% 50%, 0 26%); }

.ndw .s-receipt { left: 40%; top: 76%; width: 5.4%; padding: 10px 9px 14px;
  font: 8.5px var(--code); color: var(--ink-2); line-height: 2; letter-spacing: 0.03em;
  clip-path: polygon(0 0, 100% 0, 100% 96%, 90% 100%, 80% 96%, 70% 100%, 60% 96%, 50% 100%, 40% 96%, 30% 100%, 20% 96%, 10% 100%, 0 100%); }
.ndw .s-receipt .h { font: 700 8.5px var(--kai); color: var(--ink);
  border-bottom: 1px dashed var(--hair); padding-bottom: 3px; margin-bottom: 4px; }

.ndw .s-old { left: 58.5%; top: 73%; width: 8%; padding: 7px 7px 5px; }
.ndw .s-old img { width: 100%; display: block; }
.ndw .s-old .cap { padding-top: 5px; font: 10.5px var(--kai); color: var(--pencil); text-align: center; }

/* 钉在登记卡正上方：回答访客的下一个问题「进去之后我说什么」 */
.ndw .s-hint { right: 4.5%; top: 2.4%; width: 19.5%; padding: 10px 12px 11px; }
.ndw .s-hint .h { font: 10px var(--kai); letter-spacing: 0.14em; color: var(--pencil);
  border-bottom: 1px solid rgba(43,33,23,0.14); padding-bottom: 5px; }
.ndw .s-hint li { list-style: none; margin-top: 4px; font: 11px var(--kai);
  line-height: 1.5; color: var(--ink-2); display: flex; gap: 6px; }
.ndw .s-hint li i { font-style: normal; color: var(--red); opacity: 0.7; }

.ndw .s-trace { left: 64%; top: 76.5%; width: 8.5%; padding: 13px 12px 15px;
  background-color: rgba(243,241,230,0.72); background-image: var(--grain);
  box-shadow: 0 2px 6px rgba(93,74,44,0.14);
  font: 11.5px var(--kai); line-height: 1.68; color: rgba(60,50,38,0.78); }

.ndw .s-plane { left: 74%; top: 78%; width: 8%; padding: 7px 7px 5px; }
.ndw .s-plane img { width: 100%; display: block; mix-blend-mode: multiply; }
.ndw .s-plane .cap { padding-top: 4px; font: 11px var(--kai); color: var(--pencil); text-align: center; }

.ndw .s-desk { left: 33%; top: 4%; width: 12%; padding: 8px 8px 6px; }
.ndw .s-desk img { width: 100%; display: block; mix-blend-mode: multiply; }
.ndw .s-desk .cap { padding-top: 5px; font: 11px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .s-desk .cap b { font: 9px var(--code); color: var(--pencil); font-weight: 400; }

/* ===== 登记卡：线索的终点 ===== */
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
`;

/** 手写红圈：编号用 */
function Ring() {
  return (
    <svg viewBox="0 0 30 30" aria-hidden="true">
      <path
        d="M15.5 2.6 C 23.4 2.2, 28.4 8.2, 27.4 15.4 C 26.5 22.6, 20.6 27.8, 13.6 27.3
           C 6.4 26.8, 2.1 21.2, 2.7 14.2 C 3.3 7.4, 8.2 3.2, 15.5 2.6
           C 17.2 2.5, 19.1 2.9, 20.6 3.6"
        fill="none" stroke="#A8362B" strokeWidth="1.5" strokeLinecap="round" opacity="0.85"
      />
    </svg>
  );
}

function Clip({ cx }) {
  return (
    <svg className="clip" style={{ '--cx': cx }} viewBox="0 0 40 66" aria-hidden="true">
      <path d="M13 46 V15 a7.5 7.5 0 0 1 15 0 v33 a11.5 11.5 0 0 1-23 0 V19"
        fill="none" stroke="#8f8676" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}

/** 手绘下划线 */
function Underline({ w = 2 }) {
  return (
    <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
      <path d="M3 4 Q 30 2, 55 4.5 T 97 3.5" fill="none" stroke="#2B2117"
        strokeWidth={w} strokeLinecap="round" opacity="0.8" />
    </svg>
  );
}

export default function AuthGate({ children }) {
  // checking | login | ok
  const [phase, setPhase] = useState('checking');
  const [mode, setMode] = useState('login');   // login | register
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const rootRef = useRef(null);

  const applyStatus = (s) => {
    if (!s.required || s.authed) {
      useGlobalStore.getState().setAuthUser?.(s.user || null);
      setPhase('ok');
    } else {
      setPhase('login');
    }
  };

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then(applyStatus)
      .catch(() => setPhase('login'));
  }, []);

  // 全局 401（api.js 派发）→ 回登录态。WS 4401 断连后接口一定跟着 401，同一条路收口
  useEffect(() => {
    const onUnauthorized = () => {
      useGlobalStore.getState().setAuthUser?.(null);
      setPhase((p) => (p === 'ok' ? 'login' : p));
    };
    window.addEventListener('nd:unauthorized', onUnauthorized);
    return () => window.removeEventListener('nd:unauthorized', onUnauthorized);
  }, []);

  // 墙按安全框 contain、顶边对齐：竖向富余留给底边，顶边永不裁
  useLayoutEffect(() => {
    if (phase !== 'login') return undefined;
    const fit = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setNarrow(w < 980);
      if (rootRef.current) {
        rootRef.current.style.setProperty('--s', String(Math.min(w / DESIGN_W, h / SAFE_H)));
      }
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [phase]);

  async function submit(e) {
    e.preventDefault();
    if (busy || !username || !password) return;
    if (mode === 'register' && !inviteCode) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register'
          ? { username, password, inviteCode }
          : { username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        useGlobalStore.getState().setAuthUser?.(data.user || null);
        setPhase('ok');
      } else {
        setError(data.error || `${mode === 'register' ? '注册' : '登录'}失败 (${res.status})`);
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'ok') return children;
  if (phase === 'checking') return <div style={{ minHeight: '100vh', background: '#F0EADB' }} />;

  const isRegister = mode === 'register';

  const form = (
    <>
      <h2>来访登记</h2>
      <div className="m">小范围内测中</div>
      <div className="ndw-tabs">
        <button type="button" className={isRegister ? '' : 'on'}
          onClick={() => { setMode('login'); setError(''); }}>
          登录{!isRegister && <Underline />}
        </button>
        <button type="button" className={isRegister ? 'on' : ''}
          onClick={() => { setMode('register'); setError(''); }}>
          邀请码注册{isRegister && <Underline />}
        </button>
      </div>
      <div className="ndw-field">
        <label htmlFor="ndw-u">用户名 · USERNAME</label>
        <input id="ndw-u" value={username} placeholder="写下用户名" autoFocus
          autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="ndw-field">
        <label htmlFor="ndw-p">密码 · PASSWORD</label>
        <input id="ndw-p" type="password" value={password}
          placeholder={isRegister ? '设置密码，至少 8 位' : '写下密码'}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          onChange={(e) => setPassword(e.target.value)} />
      </div>
      {isRegister && (
        <div className="ndw-field">
          <label htmlFor="ndw-i">邀请码 · INVITE</label>
          <input id="ndw-i" value={inviteCode} placeholder="nd-xxxxxxxx"
            onChange={(e) => setInviteCode(e.target.value)} />
        </div>
      )}
      <p className="ndw-err">{error}</p>
      <button className="go" type="submit" disabled={busy}>
        {busy ? '核 对 中' : isRegister ? '开 号' : '进 门'}
      </button>
      <p className="foot">没有邀请码？在 Boss 或者小红书上找我要。</p>
    </>
  );

  return (
    <div className={`ndw${narrow ? ' narrow' : ''}`} ref={rootRef}>
      <style>{CSS}</style>

      {!narrow && (
        <>
          <div className="ndw-ghost" style={{ left: '2%', top: '64%', width: 132, height: 96, transform: 'rotate(-2deg)' }} />
          <div className="ndw-ghost" style={{ left: '90.5%', top: '10%', width: 108, height: 148, transform: 'rotate(1.6deg)' }} />
          <div className="ndw-ghost" style={{ left: '6.5%', top: '11%', width: 92, height: 70, transform: 'rotate(2.4deg)' }} />
          <div className="ndw-ghost" style={{ left: '85%', top: '76%', width: 150, height: 104, transform: 'rotate(-1.2deg)' }} />
        </>
      )}
      {narrow ? (
        <form className="ndw-card ndw-solo" onSubmit={submit}>
          <span className="brand">Nodesign</span>
          {form}
        </form>
      ) : (
        <div className="ndw-stage">
          {/* 板上的字：进度记在墙上，纸只记事 */}
          <div className="wall blk" style={{ left: '46.5%', top: '6%', transform: 'rotate(-0.6deg)' }}>
            <span className="t">八月第一周</span>
            <svg className="rule" viewBox="0 0 104 7" preserveAspectRatio="none" aria-hidden="true">
              <path d="M1 4 Q 26 2, 52 4.2 T 103 3" fill="none"
                stroke="rgba(122,111,92,0.55)" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            在做 <span className="n">演示 deck</span><br />
            已上线 <span className="n">3 件</span><br />
            这个月花了 <span className="n">$4.10</span>
          </div>
          <span className="wall lbl" style={{ left: '56.4%', top: '1.4%', fontSize: 16, transform: 'rotate(-1.4deg)' }}>墙上别的</span>
          <div className="wall lbl" style={{ left: '48.5%', top: '33%', width: 104, fontSize: 11, lineHeight: 2, transform: 'rotate(-1.2deg)' }}>
            ① 到 ⑥ 是同一件东西，周二晚开的头，周四凌晨上线
          </div>

          {DOODLES.map((d, i) => (
            <img key={i} className="doodle" src={d.src} alt=""
              style={{ left: d.left, top: d.top, width: d.w, transform: `rotate(${d.rot}deg)` }} />
          ))}

          <div className="ndw-head">
            <div className="row">
              <span className="ndw-logo">Nodesign</span>
              <span className="ndw-anno">创作者的 agent 工作间</span>
            </div>
            <h1>想到，<span className="u">做出来<Underline w={1.8} /></span>，验一遍</h1>
            <p className="ndw-sub">不用会画图，也不用学工具。</p>
          </div>

          {/* ① 一句话 */}
          <div className="paper b1 z2 sway" style={{ '--rot': '-1.8deg', '--dur': '5.2s' }}>
            <span className="no"><Ring />①</span>
            <span className="pin r" />
            <span className="who">我说</span>给这首歌做个歌词页，安静一点，星空的感觉
            <span className="when">周二 22:10</span>
          </div>

          {/* ② 骨架：后面还垫着前一版 */}
          <div className="paper pstack" aria-hidden="true"
            style={{ left: '17.5%', top: '35.7%', width: '12.7%', height: 130, '--rot': '2.9deg' }} />
          <div className="paper b2 z0 crease sway" style={{ '--rot': '1deg', '--dur': '6.6s', '--delay': '-2.1s' }}>
            <span className="no"><Ring />②</span>
            <Clip cx="20%" />
            <div className="wf">
              <i style={{ left: '7%', top: '10%', width: '38%', height: '24%' }} />
              <i style={{ right: '7%', top: '10%', width: '36%', height: '62%' }} />
              <b />
              <i style={{ left: '7%', bottom: '12%', width: '52%', height: '20%' }} />
            </div>
            <div className="cap"><span>它先给了个骨架</span><b>FIG. 01</b></div>
            <span className="bow" />
          </div>

          {/* ③ 它自己动手 */}
          <div className="paper b3 sway" style={{ '--rot': '-0.8deg', '--dur': '7.4s', '--delay': '-3.6s' }}>
            <span className="no"><Ring />③</span>
            <span className="pin" />
            <div className="t">它自己动手</div>
            <span className="ok">✓</span> generate_image <span className="dim">夜空底</span><br />
            <span className="ok">✓</span> remove_background <span className="dim">2.1s</span><br />
            <span className="ok">✓</span> write_page <span className="dim">lyrics.html</span><br />
            <span className="dim">&gt;</span> screenshot_canvas <span className="cur" />
            <div className="tail">已经跑了 11 分 04 秒</div>
          </div>

          {/* ④ 成品 */}
          <div className="paper b4 z2 dog sway" style={{ '--rot': '-1.4deg', '--dur': '6s', '--delay': '-1.2s' }}>
            <span className="no"><Ring />④</span>
            <span className="pin" />
            <img src={artNight} alt="站内做出来的 SPiCa 歌词页样张" />
            <div className="cap"><span>出来的东西 · 22:26</span><b>lyrics.html</b></div>
            <span className="bow" />
          </div>

          {/* ⑤ 批注 */}
          <div className="paper b5 z2 sway" style={{ '--rot': '2.2deg', '--dur': '4.8s', '--delay': '-2.9s' }}>
            <span className="no"><Ring />⑤</span>
            <span className="pin r" />
            <span className="who">我说</span>字体再收一号，留白多一点
            <span className="when">周三 09:40</span>
          </div>

          {/* ⑥ 上线：卷宗里不止一页 */}
          <div className="paper pstack" aria-hidden="true"
            style={{ left: '39.9%', top: '61.7%', width: '15.2%', height: 106, '--rot': '-1.7deg' }} />
          <div className="paper b6 wrinkle sway" style={{ '--rot': '0.7deg', '--dur': '8s', '--delay': '-5.2s' }}>
            <span className="no"><Ring />⑥</span>
            <span className="tab">项目 · 卷宗</span>
            <span className="holes" />
            <div className="t">SPiCa 歌词页</div>
            <div className="d">改完第二版，凌晨两点推上去的</div>
            <div className="r"><span>FIG. 02</span><span>周四 01:50</span></div>
            <span className="live">已上线</span>
            <span className="bow" />
          </div>

          {/* 侧料 */}
          <div className="paper pstack" aria-hidden="true"
            style={{ left: '56.9%', top: '5.7%', width: '12.2%', height: 152, '--rot': '-1.6deg' }} />
          <div className="paper s-legal z0 sway" style={{ '--rot': '0.9deg', '--dur': '7s', '--delay': '-4.3s' }}>
            <span className="staple" style={{ '--cx': '18px' }} />
            <span className="staple" style={{ '--cx': 'calc(100% - 32px)' }} />
            <div className="h">这周做完的</div>
            <li><i>✓</i>SPiCa 歌词页</li>
            <li><i>✓</i>角色档案站</li>
            <li><i>✓</i>同人资料站</li>
            <li>演示 deck，周五前</li>
            <span className="bow" />
          </div>

          <div className="paper s-index z0 dog sway" style={{ '--rot': '-1.1deg', '--dur': '6.3s', '--delay': '-1.7s' }}>
            <span className="pin" />
            <div className="h">下一件</div>
            <div className="b">歌词页要不要做一版竖屏？手机上翻着看。</div>
          </div>

          <div className="paper s-strip sway" style={{ '--rot': '-1.5deg', '--dur': '5.7s', '--delay': '-1.4s' }}>
            <span className="pin r" />上个月那批还挂着
          </div>

          <div className="paper s-receipt sway" style={{ '--rot': '1.9deg', '--dur': '5.5s', '--delay': '-3.1s' }}>
            <span className="pin" />
            <div className="h">用量小票</div>
            RUN 0802-17<br />48,212 tok<br />$0.026<br />* * *
          </div>

          <div className="paper s-old dog sway" style={{ '--rot': '1.6deg', '--dur': '6.5s', '--delay': '-3.8s' }}>
            <span className="pin" />
            <img src={artPortrait} alt="站内做出来的角色档案站样张" />
            <div className="cap">角色档案站</div>
          </div>

          <div className="paper s-trace z2 sway" style={{ '--rot': '-2deg', '--dur': '5.9s', '--delay': '-4.8s' }}>
            <Clip cx="30%" />
            描图纸压一版<br />字往下挪两格
          </div>

          <div className="paper s-plane sway" style={{ '--rot': '1.3deg', '--dur': '6.8s', '--delay': '-2.4s' }}>
            <span className="pin" />
            <img src={artPlane} alt="" />
            <div className="cap">还没起飞</div>
          </div>

          <div className="paper s-desk z0 crease-h sway" style={{ '--rot': '1.2deg', '--dur': '7.7s', '--delay': '-5.9s' }}>
            <Clip cx="66%" />
            <img src={artDesk} alt="" />
            <div className="cap"><span>工作台 · 版式草稿</span><b>DESK-001</b></div>
          </div>

          <div className="paper s-hint z0 sway" style={{ '--rot': '0.8deg', '--dur': '7.2s', '--delay': '-2.6s' }}>
            <span className="staple" style={{ '--cx': '16px' }} />
            <span className="staple" style={{ '--cx': 'calc(100% - 30px)' }} />
            <div className="h">别人进门先说的</div>
            <li><i>“</i>给我的新歌做个歌词视觉页</li>
            <li><i>“</i>把这半年做的整理成一份 deck</li>
            <li><i>“</i>做个收集角色设定的档案站</li>
          </div>

          {/* 登记卡 */}
          <form className="ndw-card" onSubmit={submit}>
            <span className="pin" />
            <div className="ndw-stamp">凭邀请</div>
            {form}
          </form>

          {/* 线索线：① 到 ⑥ 一条红线，最后把笔递给你 */}
          <svg className="ndw-thread" viewBox="0 0 1500 800" preserveAspectRatio="none" aria-hidden="true">
            <path d="M 208 300 C 226 306, 238 312, 250 320 M 236 314 l 16 7 l -6 -15" />
            <path d="M 448 322 C 462 314, 476 306, 492 300 M 478 302 l 16 -3 l -10 13" />
            <path d="M 588 400 C 540 470, 380 454, 232 466 M 250 458 l -19 9 l 17 11" />
            <path d="M 372 556 C 386 550, 396 546, 408 542 M 394 538 l 15 4 l -11 11" />
            <path d="M 570 550 C 578 542, 586 536, 596 532 M 583 528 l 15 4 l -11 11" />
            <path className="soft" d="M 842 528 C 916 476, 972 448, 1040 424 M 1024 420 l 17 4 l -9 14" />
          </svg>
          <span className="hand" style={{ left: '15.2%', top: '55.4%', fontSize: 17, transform: 'rotate(-5deg)' }}>出图了</span>
          <span className="hand" style={{ left: '62.4%', top: '49.5%', fontSize: 23, transform: 'rotate(-3.5deg)' }}>轮到你了</span>
          <span className="hand p" style={{ left: '4.2%', top: '27.6%', fontSize: 11.5, transform: 'rotate(-2.5deg)' }}>一句话开始 ↓</span>
        </div>
      )}
    </div>
  );
}
