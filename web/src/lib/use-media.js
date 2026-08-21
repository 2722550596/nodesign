import { useEffect, useState } from 'react';

/**
 * 视口与输入方式的两个探针（2026-08-21 移动端适配）。
 *
 * 全站原来一个都没有：窄屏靠 CSS media query 各写各的，而**内联样式的组件够不着
 * media query**（顶栏、悬浮卡这一族全是内联样式），于是手机上它们照着 1440 的尺寸挤成一团。
 *
 * ⚠️ 两条判据别混用：
 *   - `(max-width: …)` 是**版面**问题（放不放得下）；
 *   - `(pointer: coarse)` 是**手指**问题（有没有 hover、有没有 Shift+Enter、命中区要多大）。
 *     平板是「宽 + 粗指针」，手机横屏是「不太窄 + 粗指针」—— 拿宽度去猜手指，这两种都判错。
 */
function subscribe(query, cb) {
  const mq = window.matchMedia(query);
  // Safari 14 以下只有 addListener；这站的用户里真有老 iPad
  if (mq.addEventListener) { mq.addEventListener('change', cb); return () => mq.removeEventListener('change', cb); }
  mq.addListener(cb);
  return () => mq.removeListener(cb);
}

/** 一条 media query 现在成不成立（跟着变） */
export function useMedia(query) {
  const [on, setOn] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const cb = () => setOn(window.matchMedia(query).matches);
    cb();
    return subscribe(query, cb);
  }, [query]);
  return on;
}

/** 窄屏断点：手机竖屏（含大屏手机）都在里面，平板竖屏不在 */
export const NARROW = '(max-width: 640px)';
/** 手指（触屏 / 触控笔）：没有 hover，也没有物理键盘的 Shift+Enter */
export const COARSE = '(pointer: coarse)';

/**
 * 视口宽度（px）。只在**真要算像素**的地方用（比如卡要平移多远），
 * 判"是不是窄屏"请用 useMedia(NARROW) —— resize 事件比 media query 吵得多。
 */
export function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}
