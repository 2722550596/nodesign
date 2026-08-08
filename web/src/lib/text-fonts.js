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
import { FONT_KAI, FONT_SANS, FONT_MONO } from './theme.js';

export const TEXT_FONT_CSS = {
  kai: FONT_KAI,
  sans: FONT_SANS,
  // 衬线：给标题式的一句话用，跟正文拉开层次
  serif: 'Songti SC, SimSun, Georgia, "Times New Roman", serif',
  mono: FONT_MONO,
};

/** 给设置面板用的人话名字 */
export const TEXT_FONT_LABELS = { kai: '楷体', sans: '黑体', serif: '宋体', mono: '等宽' };

export const TEXT_SIZE_PX = { sm: 13, md: 16, lg: 22, xl: 30 };
export const TEXT_SIZE_LABELS = { sm: '小', md: '中', lg: '大', xl: '特大' };
