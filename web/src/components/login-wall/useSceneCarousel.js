import { useEffect, useRef, useState } from 'react';
import { leaveMs, enterMs, MOTION } from './wall-css.js';

/** 首屏那一套多站这么久再开始动 —— 页面刚打开，先让人看清这是什么 */
const FIRST_HOLD_EXTRA = 2600;

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};

/**
 * 墙的轮播（2026-08-17）。
 *
 * 一轮 = **慢慢钉上去 → 站着一拍 → 中速摘下来 → 下一套**，一直循环，全长约 10 秒
 * （节拍表在 wall-css.js 的 MOTION）。摘干净了才钉下一套，不重叠不交叉淡入 ——
 * 两套纸同时在墙上会立刻穿帮：它们的 z-index 是各自构图里算好的，混在一起谁压谁
 * 全乱。
 *
 * `scene.hold` 是**站着不动的那一拍**（不是"这一套播多久"）。想给访客读的时间就
 * 把它调大，别去动 MOTION 里的 step —— 那会连带改掉"一张张摆上去"的手感。
 *
 * 返回 `{ scene, phase }`，phase 是 '' | 'leave' | 'enter'，直接当 class 给 Scene。
 *
 * ⚠️ 第一套是**直接站在墙上**的，不播进场：访客打开页面就该看见一面完整的墙，
 * 让他盯着空板等五秒纸慢慢贴上来是把加载做成了动画。动画从第一次换场才开始。
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

    const still = scenes[i]?.hold ?? MOTION.still;
    /**
     * ⚠️ 这一套是**刚换过来正在钉**，还是**已经站在墙上**？
     *
     * 差别就是要不要把进场那 5.5 秒算进去。第一版没算 —— 换完场立刻按 `still`
     * 起计时，于是纸还在一张张往上钉，收起的定时器已经烧到一半了。旧版看不出来
     * 是因为 hold 是 15 秒，比进场长得多，正好盖住。真跑抓帧才现形：
     * 第二套进场才 2.5 秒就被报成 leave。
     */
    const entering = phase === 'enter';
    // 首屏那一套不播进场（打开就该是完整的墙），但多站一会儿再开始动
    const wait = entering ? enterMs(paperCount) + still : still + FIRST_HOLD_EXTRA;
    const out = leaveMs(paperCount);
    const push = (fn, ms) => timers.current.push(setTimeout(fn, ms));

    /**
     * 钉完把 `enter` 摘掉，交还给常驻的风吹纸摆。
     *
     * ⚠️ 这条**必须挂在本轮 effect 上**，不能写进上一轮那串回调里。定时器都记在
     * 同一个数组里，而 `i` 一变 effect 就清空整个数组 —— 上一轮塞进去的这条会被
     * 连坐清掉，`enter` 于是一直挂到下次收起，那期间 `.enter .paper` 的
     * `both` 填充压着 sway，整面墙一动不动（测试就是这么抓到的）。
     */
    if (entering) push(() => setPhase(''), enterMs(paperCount));

    push(() => {
      setPhase('leave');
      push(() => {
        setI(n => (n + 1) % scenes.length);
        setPhase('enter');
      }, out);
    }, wait);

    return clear;
    // phase 不进依赖：它在这个 effect 内部被推进，写进去会让定时器每一步重装
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, scenes, enabled, paperCount]);

  return { scene: scenes[i], phase, index: i };
}
