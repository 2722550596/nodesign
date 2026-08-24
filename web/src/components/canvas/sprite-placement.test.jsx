// @vitest-environment happy-dom
// 精灵贴目标时的留白（2026-08-15 用户报"贴太紧，摘要压产物"）
// + 避让（2026-08-24 体检：贴目标不跑避让 / 槽位被压不自愈 / 脚印口径混用）
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { AmbientSpriteLayer, findAmbientSlot, findWorkSpot } from './SpriteSketchLayer.jsx';

const CAM = { x: 0, y: 0, z: 1 };
const VIEW = { w: 1200, h: 800 };

function mount(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <AmbientSpriteLayer cam={CAM} viewport={VIEW} obstacles={[]} text="正在把配色调暖" {...props} />,
    );
  });
  const node = host.querySelector('div[style*="position: absolute"]');
  const style = node?.getAttribute('style') || '';
  act(() => { root.unmount(); });
  host.remove();
  return style;
}

describe('精灵摆位', () => {
  const anchor = { x: 400, y: 300, w: 320, h: 240 };

  it('贴目标时吊在目标上边线之上：下沿对齐 + 固定留白', () => {
    const style = mount({ workAnchor: anchor, agentActive: true });
    // top 落在目标上边线之上 WORK_GAP(26)，再靠 translateY(-100%) 把整块吊上去
    expect(style).toContain('top: 274px');
    expect(style).toContain('translateY(-100%)');
  });

  it('句子长短不改变留白（吊的是下沿，不是上沿）', () => {
    const 短 = mount({ workAnchor: anchor, text: '改配色' });
    const 长 = mount({ workAnchor: anchor, text: '正在把三张封面的配色统一调暖并重新导出一遍看看效果' });
    expect(短).toBe(长);
  });

  it('闲时（无目标）按槽位摆，不吊', () => {
    const style = mount({ workAnchor: null });
    expect(style).not.toContain('translateY(-100%)');
  });

  it('闲时槽位被新产物压住 → 防抖后自愈换位（活跃时也让）', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<AmbientSpriteLayer cam={CAM} viewport={VIEW} obstacles={[]} text="hi" agentActive />);
    });
    // 首选槽 (0.5, 0.25)：x = 600-200 = 400，y = 200-50 = 150
    let node = host.querySelector('div[style*="position: absolute"]');
    expect(node.getAttribute('style')).toContain('top: 150px');
    // run 收尾排进来一张 640×360 的新产物，正压着这个槽
    act(() => {
      root.render(<AmbientSpriteLayer cam={CAM} viewport={VIEW} obstacles={[{ x: 380, y: 140, w: 640, h: 360 }]} text="hi" agentActive />);
    });
    act(() => { vi.advanceTimersByTime(600); });
    node = host.querySelector('div[style*="position: absolute"]');
    // 上排三个槽全被占（矩形横跨 380..1020），落到下半屏 (0.5, 0.72) → top 526
    expect(node.getAttribute('style')).toContain('top: 526px');
    act(() => { root.unmount(); });
    host.remove();
    vi.useRealTimers();
  });
});

describe('findWorkSpot（贴目标也要避让）', () => {
  const anchor = { x: 400, y: 300, w: 320, h: 240 };
  const SPRITE = { w: 400, h: 100 };
  const hit = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

  it('头顶空着就用头顶（老落点语义不变，底边吊装）', () => {
    const s = findWorkSpot(anchor, []);
    expect(s.hang).toBe(true);
    expect(s.y).toBe(274);
  });

  it('头顶被上一行的卡占着 → 让去别的方位，不与那张卡相交', () => {
    const above = { x: 300, y: 100, w: 640, h: 180 };   // 盖住头顶槽的带子
    const s = findWorkSpot(anchor, [above]);
    const rect = { x: s.x, y: s.hang ? s.y - SPRITE.h : s.y, w: SPRITE.w, h: SPRITE.h };
    expect(hit(rect, above)).toBe(false);
  });

  it('四个方位全被占 → 认最小遮挡而不是消失', () => {
    const everywhere = { x: -2000, y: -2000, w: 6000, h: 6000 };
    expect(findWorkSpot(anchor, [everywhere])).toBeTruthy();
  });
});

describe('findAmbientSlot 脚印口径（世界单位，与镜头无关）', () => {
  it('z=2 时压着就换槽（老口径把脚印除以 z，会误判不压）', () => {
    const ob = { x: 90, y: 40, w: 420, h: 120 };        // 盖住 z=2 下的首选槽
    const slot = findAmbientSlot({ x: 0, y: 0, z: 2 }, VIEW, [ob]);
    expect(slot).toBeTruthy();
    const rect = { x: slot.x, y: slot.y, w: 400, h: 100 };
    const overlap = !(rect.x + rect.w <= ob.x || ob.x + ob.w <= rect.x || rect.y + rect.h <= ob.y || ob.y + ob.h <= rect.y);
    expect(overlap).toBe(false);
  });
});
