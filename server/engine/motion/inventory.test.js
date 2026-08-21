import { describe, it, expect } from 'vitest';
import { splitRules, scanCss, mergeScans, formatMotionInventory } from './inventory.js';

const CSS = `
/* comment { with braces } */
@keyframes float { 0% { transform: translateY(0) } 50% { transform: translateY(-8px) } 100% { transform: translateY(0) } }
@keyframes marquee { from { transform: translateX(0) } to { transform: translateX(-50%) } }
.hero { animation: float 6s ease-in-out infinite; will-change: transform; }
.card { transition: transform .6s cubic-bezier(.2,.8,.2,1), opacity .6s; }
.reveal { opacity: 0; transform: translateY(40px); transition: opacity .8s ease, transform .8s ease; }
.reveal.in { opacity: 1; transform: none; }
.bar { animation-timeline: scroll(); animation-name: grow; }
@media (max-width: 860px) { .snap { scroll-snap-type: y mandatory; } .head { position: sticky; top: 0 } }
@media (prefers-reduced-motion: reduce) { .hero { animation: none } }
@supports (animation-timeline: view()) { .pic { animation-timeline: view(); animation-range: entry 0% cover 40%; } }
`;

describe('motion inventory · CSS 扫描', () => {
  it('splitRules：注释里的花括号不算，@media/@supports 进一层，@keyframes 整块', () => {
    const rules = splitRules(CSS);
    const kf = rules.filter(r => /^@keyframes/.test(r.prelude));
    expect(kf.map(r => r.prelude)).toEqual(['@keyframes float', '@keyframes marquee']);
    const snap = rules.find(r => r.prelude === '.snap');
    expect(snap.context).toEqual(['@media (max-width: 860px)']);
    const pic = rules.find(r => r.prelude === '.pic');
    expect(pic.context[0]).toMatch(/^@supports/);
  });
  it('scanCss：分类计数与样本', () => {
    const r = scanCss(CSS, 'style.css');
    expect(r.keyframes.map(k => [k.name, k.steps])).toEqual([['float', 3], ['marquee', 2]]);
    expect(r.animations.total).toBe(3);             // .hero / .bar(animation-name) / reduced-motion 分支里的 .hero
    expect(r.transitions.total).toBe(2);            // .card / .reveal（.reveal.in 没声明 transition）
    expect(r.scrollTimeline.total).toBe(2);         // .bar scroll() / .pic view()
    expect(r.scrollSnap[0]).toMatchObject({ selector: '.snap', value: 'y mandatory' });
    expect(r.sticky[0].selector).toBe('.head');
    expect(r.willChange).toBe(1);
    expect(r.reducedMotion).toBe(true);
  });
  it('mergeScans 把多张表并起来且保留 total', () => {
    const m = mergeScans([scanCss(CSS, 'a.css'), scanCss('.x{transition:all .3s}', 'b.css')]);
    expect(m.transitions.total).toBe(3);
    expect(m.keyframes.total).toBe(2);
  });
  it('formatMotionInventory 给人话，缺哪路说哪路', () => {
    const lines = formatMotionInventory({
      stylesheets: { count: 2, bytes: 20480 },
      css: scanCss(CSS, 's'),
      libs: { libs: [{ name: 'gsap' }, { name: 'ScrollTrigger' }], scriptHints: ['gsap.min.js'], scrollTriggers: [{ trigger: '.hero', start: 'top top', end: '+=800', scrub: 1, pin: true }], gsapTweens: 12, canvases: 1 },
      scroll: { dispatchedPx: 3000, reachedY: 2800, docHeight: 3700, viewportHeight: 900, revealsTotal: 6, scrubsTotal: 2, reveals: [{ target: '.card', from: { opacity: '0', transform: 'matrix(1,0,0,1,0,40)' }, to: { opacity: '1', transform: 'none' }, transition: 'opacity .8s ease' }], scrubs: [{ target: '.bg', midTransform: 'matrix(1,0,0,1,0,-120)' }], hijackSuspected: false },
      runtime: { count: 3, items: [{ target: '.hero', name: 'float', duration: 6000, easing: 'ease-in-out', iterations: Infinity }] },
      errors: ['getAnimations: boom'],
    });
    const text = lines.join('\n');
    expect(text).toMatch(/动效库：gsap、ScrollTrigger/);
    expect(text).toMatch(/ScrollTrigger ×1：\.hero\[top top→\+=800 scrub=1 pin\]/);
    expect(text).toMatch(/@keyframes ×2（float marquee）/);
    expect(text).toMatch(/CSS 滚动驱动动画.*×2/);
    expect(text).toMatch(/入场 reveal 6 个 · 随滚动位置走的（scrub\/视差）2 个/);
    expect(text).toMatch(/运行时.*3 条活着的：\.hero float 6000ms ease-in-out ∞/);
    expect(text).toMatch(/没采到：getAnimations: boom/);
  });
});
