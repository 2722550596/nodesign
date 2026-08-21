// @vitest-environment happy-dom
/**
 * 精灵身体（2026-08-21 按会话模型换身份）。
 * 三件事值得钉住：换 brand 真的换了图形、干活态才有那些动作、潜的节拍器真的会开跑
 * （计时器这种东西"写了"和"跑了"是两回事，这仓库为此立过规矩：重构后要运行时证据）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { SpriteFigure, figureWidth } from './sprite-figures.jsx';
import { MARKS } from '../ui/ModelMark.jsx';

function mount(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<SpriteFigure size={44} {...props} />); });
  return {
    host,
    html: () => host.innerHTML,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('SpriteFigure', () => {
  it('换 brand 换图形：鲸画的是鲸的 path，星芒画的是星芒的', () => {
    const whale = mount({ brand: 'deepseek' });
    expect(whale.html()).toContain(MARKS.deepseek.paths[0].d.slice(0, 40));
    expect(whale.html()).not.toContain(MARKS.claude.paths[0].d.slice(0, 40));
    whale.unmount();

    const star = mount({ brand: 'claude' });
    expect(star.html()).toContain(MARKS.claude.paths[0].d.slice(0, 40));
    star.unmount();
  });

  it('认不出的 brand 什么都不画（宁可空着也不画错一家的标）', () => {
    const m = mount({ brand: 'nobody' });
    expect(m.html()).toBe('');
    m.unmount();
  });

  it('闲时鲸只呼吸；干活才加起伏/甩尾/喷气', () => {
    const idle = mount({ brand: 'deepseek', active: false });
    expect(idle.html()).toContain('ndSeaBreath');
    expect(idle.html()).not.toContain('ndSeaBob');
    expect(idle.html()).not.toContain('ndSeaSpout');
    idle.unmount();

    const busy = mount({ brand: 'deepseek', active: true });
    expect(busy.html()).toContain('ndSeaBob');
    expect(busy.html()).toContain('ndSeaTail');
    expect(busy.html()).toContain('ndSeaSpout');
    busy.unmount();
  });

  it('干活起手会潜一次；闲下来立刻不潜（节拍器真的在跑，不是写在那儿好看）', () => {
    vi.useFakeTimers();
    const m = mount({ brand: 'deepseek', active: true });
    expect(m.html()).not.toContain('ndSeaDive');      // 起手先游一会儿
    act(() => { vi.advanceTimersByTime(1200); });
    expect(m.html()).toContain('ndSeaDive');
    act(() => { vi.advanceTimersByTime(3200); });     // 潜完回到常态
    expect(m.html()).not.toContain('ndSeaDive');
    m.unmount();
  });

  it('每个形状只画一份 —— 画两份会成双影：静止时严丝合缝，一动就露出来（08-21 自己踩过）', () => {
    const whale = mount({ brand: 'deepseek', active: true });
    const d = MARKS.deepseek.paths[0].d;
    expect(whale.html().split(d).length - 1).toBe(2);   // 一道铅笔稿 + 一份墨色，仅此
    whale.unmount();

    const oc = mount({ brand: 'opencode', active: true });
    const block = MARKS.opencode.paths[1].d;
    expect(oc.html().split(block).length - 1).toBe(2);
    oc.unmount();
  });

  it('Claude 干活是脉冲星芒：12 根触点 + 中心毂各是一份形状', () => {
    const m = mount({ brand: 'claude', active: true });
    expect(m.html().match(/ndRayPulse/g) || []).toHaveLength(12);
    expect(m.html()).toContain('ndCoreBreath');
    m.unmount();
  });

  it('OpenCode 干活时那截填充块才涨落', () => {
    const idle = mount({ brand: 'opencode', active: false });
    expect(idle.html()).not.toContain('ndOcFill');
    idle.unmount();
    const busy = mount({ brand: 'opencode', active: true });
    expect(busy.html()).toContain('ndOcFill');
    busy.unmount();
  });

  it('figureWidth 按各家外框比例算：鲸最宽、方块最窄、星芒是方的', () => {
    expect(figureWidth('claude', 44)).toBe(44);
    expect(figureWidth('deepseek', 44)).toBeGreaterThan(50);   // 24 : 17.66
    expect(figureWidth('opencode', 44)).toBeLessThan(40);      // 12 : 15
    expect(figureWidth('nobody', 44)).toBe(44);
  });
});
