/**
 * 「agent 正在动这张卡」那圈流光的形状契约（2026-08-17）。
 *
 * ## 这条测试为什么存在
 *
 * 亮弧原本写成 `@keyframes ndAgentSweep{to{transform:rotate(1turn)}}`，转的是
 * 那个**遮罩矩形本身**。正方形转 90° 还是自己，所以在小卡上看不出问题；真实
 * 产物卡是 240×200、文字卡更是窄高，转到 45° 时那道光整个飞到卡外面，看着就是
 * 一道断掉的折线浮在卡的上方 —— 用户报的「流光破损」。复现方式：把 BoardObject
 * 那段 CSS 原样搬进一张空白页，逐相位截图（0/45°/90°…），一眼就见。
 *
 * 改法是转**渐变的起始角**（`--ndSweep`）而不是元素。这里钉三件事：
 *
 *   1. sweep 的关键帧里不许再出现 transform —— 那是原病灶本身
 *   2. `--ndSweep` 必须用 @property 注册成 <angle>；不注册的自定义属性只做
 *      离散动画，会在 50% 处直接跳一格，光弧看着是"闪"不是"转"
 *   3. 关键帧动的属性和 BoardObject 里渐变读的属性得是同一个名字 —— 这是一条
 *      跨文件契约，改名字只改一头的话动画照跑、光弧不动，而且不报任何错
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_KEYFRAMES } from './board-keyframes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD_OBJECT = fs.readFileSync(path.join(HERE, 'cards/BoardObject.jsx'), 'utf8');

/** 取一条 @keyframes 的整段正文 */
function keyframeBody(css, name) {
  const at = css.indexOf(`@keyframes ${name}{`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  return null;
}

describe('agent 光圈的流光', () => {
  it('转的是渐变角度，不是那个矩形（transform 会让光飞出非正方的卡）', () => {
    const body = keyframeBody(BOARD_KEYFRAMES, 'ndAgentSweep');
    expect(body, 'ndAgentSweep 关键帧不见了').toBeTruthy();
    expect(body).not.toMatch(/transform/);
    expect(body).toMatch(/--ndSweep\s*:\s*360deg/);
  });

  it('--ndSweep 注册成 <angle>（不注册就是离散动画，光弧会跳格）', () => {
    expect(BOARD_KEYFRAMES).toMatch(/@property\s+--ndSweep\s*\{[^}]*syntax\s*:\s*"<angle>"/);
  });

  it('渐变读的就是关键帧动的那个属性，并带静态回落值', () => {
    // 回落值：浏览器不认 @property 时，`from var(--ndSweep)` 整条 background
    // 声明会在计算值阶段作废 —— 光圈直接消失。写了默认值就只是不转。
    expect(BOARD_OBJECT).toMatch(/conic-gradient\(from var\(--ndSweep,\s*0deg\)/);
    expect(BOARD_OBJECT).toMatch(/animation:\s*'ndAgentSweep/);
  });
});
