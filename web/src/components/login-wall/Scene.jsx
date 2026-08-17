import { useLayoutEffect, useRef } from 'react';

/**
 * 一面墙的壳（2026-08-17）。
 *
 * 场景自己只管「纸摆在哪、写什么、线怎么走」；钉上去和摘下来的那点手感在这儿。
 *
 * ## `--i` 为什么在运行时算而不是写进场景数据
 *
 * 定格切换是**一张一张**钉上去的，所以每张纸要知道自己排第几。让场景作者手工
 * 给二十张纸编号，等于每次调整摆放顺序都要重编一遍，而漏编一个的表现是「有一
 * 张纸抢跑」—— 没人会把它跟一个忘了改的数字联系起来。DOM 顺序本来就是作者写
 * 下的顺序，直接拿它当号。
 *
 * 摘的时候倒着来（后钉的先摘），像倒放。
 */
export default function Scene({ scene, phase }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const papers = root.querySelectorAll('.paper');
    papers.forEach((el, i) => {
      el.style.setProperty('--i', String(i));
      el.style.setProperty('--out', String(papers.length - 1 - i));
    });
    // 红线和手写要等所有纸钉完再画上去（CSS 里按这个数算延迟）
    root.style.setProperty('--pins', String(papers.length));
    // 板上的墨（涂鸦 / 写在板子上的字）先于纸出现，彼此之间也错开一点
    root.querySelectorAll('.doodle, .wall').forEach((el, i) => {
      el.style.setProperty('--i', String(i));
    });
    root.querySelectorAll('.hand').forEach((el, i) => {
      el.style.setProperty('--i', String(i));
    });
  }, [scene.id]);

  return (
    <div ref={ref} className={`ndw-scene sc-${scene.id}${phase ? ` ${phase}` : ''}`}>
      <style>{scene.css}</style>
      {scene.render()}
    </div>
  );
}
