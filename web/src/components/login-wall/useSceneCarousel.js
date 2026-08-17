import { useEffect, useRef, useState } from 'react';
import { leaveMs, enterMs } from './wall-css.js';

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};

/**
 * 墙的轮播（2026-08-17）。
 *
 * 一套停 `scene.hold`，然后**先把纸一张张摘下来，摘干净了再钉下一套** ——
 * 不重叠、不交叉淡入。两套纸同时在墙上会立刻穿帮：它们的 z-index 是各自
 * 构图里算好的，混在一起谁压谁全乱。
 *
 * 返回 `{ scene, phase }`，phase 是 '' | 'leave' | 'enter'，直接当 class 给 Scene。
 *
 * 只有一套场景时整套机制不启动（连定时器都不装）—— 这也是 `prefers-reduced-motion`
 * 那条路：不转，就停在第一套。用户当初点名要的三条之一。
 */
export function useSceneCarousel(scenes, { enabled = true, paperCount = 20 } = {}) {
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState('');
  const timers = useRef([]);

  useEffect(() => {
    const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
    if (!enabled || scenes.length < 2 || reducedMotion()) { clear(); return clear; }

    const hold = scenes[i]?.hold ?? 15000;
    const out = leaveMs(paperCount);
    const push = (fn, ms) => timers.current.push(setTimeout(fn, ms));

    push(() => {
      setPhase('leave');
      push(() => {
        setI(n => (n + 1) % scenes.length);
        setPhase('enter');
        // 钉完就把 class 摘掉，交还给常驻的风吹纸摆
        push(() => setPhase(''), enterMs(paperCount));
      }, out);
    }, hold);

    return clear;
  }, [i, scenes, enabled, paperCount]);

  return { scene: scenes[i], phase, index: i };
}
