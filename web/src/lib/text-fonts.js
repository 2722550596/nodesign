/**
 * 画布手写文字的字体表（2026-08-08）。
 *
 * 白名单而不是自由字符串：这个值最终会进 CSS，而 board.json 是 agent 也能写的
 * （pin_to_board 那条路）。服务端 `board-store.js` 的 TEXT_FONTS 是同一份清单，
 * 两边对不上时以服务端为准 —— 它是校验方，这里只是渲染。
 *
 * 默认楷体：整套语言里正文就是楷体，手写在白板上的一句话跟它同源。
 * 等宽只留给机器写的东西（这条规矩全站一致，见 lib/theme.js 的 FONT_MONO）。
 */
import { FONT_KAI, FONT_MONO } from './theme.js';

export const TEXT_FONT_CSS = {
  // 手写（默认）：拉丁字符走 Caveat（龙藏的英文字形糙），中文落龙藏体硬笔字
  // —— "白板上随手写的一句"就该长这样。回落链放楷体：字体还在路上
  // （龙藏 2.9MB swap）或极少数字缺字时不至于跳成黑体。
  pen: `'Caveat ND', 'Long Cang ND', ${FONT_KAI}`,
  kai: FONT_KAI,
  // 黑体给的是**真黑体栈**，不是 FONT_SANS —— 那个常量全站指向楷体
  // （theme.js:114），用它的话设置面板里"楷体/黑体"是同一张脸（2026-08-13 修）
  sans: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
  // 衬线：给标题式的一句话用，跟正文拉开层次
  serif: 'Songti SC, SimSun, Georgia, "Times New Roman", serif',
  mono: FONT_MONO,
};

/** 给设置面板用的人话名字 */
export const TEXT_FONT_LABELS = { pen: '手写', kai: '楷体', sans: '黑体', serif: '宋体', mono: '等宽' };

export const TEXT_SIZE_PX = { sm: 13, md: 16, lg: 22, xl: 30 };
export const TEXT_SIZE_LABELS = { sm: '小', md: '中', lg: '大', xl: '特大' };
