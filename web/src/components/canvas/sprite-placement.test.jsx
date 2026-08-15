// @vitest-environment happy-dom
// 精灵贴目标时的留白（2026-08-15 用户报"贴太紧，摘要压产物"）
import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { AmbientSpriteLayer } from './SpriteSketchLayer.jsx';

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
});
