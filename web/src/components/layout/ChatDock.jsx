import { useEffect, useState } from 'react';
import { PanelRightClose, PanelRightOpen, MessageSquare } from 'lucide-react';
import { PAPER, PAPER_SHADOW, GRAIN } from '../../lib/paper.js';
import { FONT_KAI, FONT_SIZE, GAP } from '../../lib/theme.js';

/**
 * ChatDock —— 钉在右侧的对话栏（2026-08-08）。
 *
 * 取代 `FloatingPanel id="chat"`。那是个 `react-rnd` 浮窗：能拖到屏幕任何地方、
 * 能缩到任意尺寸、位置按项目存在 localStorage 里。用户的原话是
 * 「agent 侧边栏应该需要固定在左侧或者右侧，而不该被随意移动」——
 * 对话不是一张可以随手挪开的卡片，它是这个工具的**边**。
 *
 * 于是这里只剩三件事：贴住右缘、能收起、宽度可拖。**位置不再是一个状态**。
 *
 * ## 为什么不是继续用 FloatingPanel 加个「锁定」开关
 *
 * 那样两套语义会一直纠缠：Rnd 的 position 还在、snap 还在、bringToFront 还在，
 * 只是被一个 flag 挡住。而且它的外壳是另一套皮（12px 圆角 + 暖棕描边 +
 * 等宽字标题），跟登录页那套纸语言是两回事 —— 换肤扫不到它正是因为它自成一体。
 *
 * ## 皮
 *
 * 照登录页：纸底 + 颗粒 + **影子而不是描边**（描边是把卡片画出来，影子是把它
 * 垫起来），标题用楷体不用等宽 —— 等宽只留给机器写的东西。左缘那道 hairline
 * 是唯一的线，它不是装饰，是"这里是边界"这件事本身。
 */

const MIN_W = 320;
const MAX_W = 720;
const DEFAULT_W = 380;
const RAIL_W = 44;
const KEY = 'nd:chatdock';

export default function ChatDock({ title = '对话', children }) {
  const [open, setOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem(KEY))?.open ?? true; } catch { return true; }
  });
  const [width, setWidth] = useState(() => {
    try {
      const w = JSON.parse(localStorage.getItem(KEY))?.width;
      return Number.isFinite(w) ? Math.min(MAX_W, Math.max(MIN_W, w)) : DEFAULT_W;
    } catch { return DEFAULT_W; }
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ open, width })); } catch { /* 隐私模式 */ }
  }, [open, width]);

  // 拖左缘改宽度。监听挂 window 而不是把手本身 —— 鼠标甩出把手（很容易，
  // 把手只有 6px 宽）之后还得继续收到 move，否则一快就断。
  useEffect(() => {
    if (!dragging) return;
    const move = (e) => setWidth(Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX)));
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dragging]);

  const shell = {
    position: 'absolute', top: 0, right: 0, bottom: 0,
    display: 'flex', flexDirection: 'column',
    background: PAPER.paper,
    backgroundImage: GRAIN,
    boxShadow: PAPER_SHADOW.near,
    // 唯一的一条线：左缘。它不是装饰，是"这里是边界"本身
    borderLeft: `1px solid ${PAPER.hair}`,
    zIndex: 120,
  };

  if (!open) {
    return (
      <div style={{ ...shell, width: RAIL_W, alignItems: 'center', paddingTop: GAP.md }}>
        <button
          data-no-pan
          title="展开对话"
          onClick={() => setOpen(true)}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: GAP.sm,
            width: '100%', padding: `${GAP.sm}px 0`,
            border: 'none', background: 'transparent', cursor: 'pointer', color: PAPER.ink2,
          }}
        >
          <PanelRightOpen size={16} strokeWidth={1.75} />
          <MessageSquare size={15} strokeWidth={1.75} />
          {/* 收起态把标题竖过来 —— 这条窄轨太窄，横排一个字都放不下 */}
          <span style={{
            fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: PAPER.pencil,
            writingMode: 'vertical-rl', letterSpacing: 2, marginTop: GAP.xs,
          }}>{title}</span>
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...shell, width }}>
      {/* 宽度把手：贴左缘的一条 6px 热区，拖它改宽 */}
      <div
        data-no-pan
        onPointerDown={(e) => { e.preventDefault(); setDragging(true); }}
        style={{
          position: 'absolute', left: -3, top: 0, bottom: 0, width: 6,
          cursor: 'col-resize', zIndex: 2,
          background: dragging ? PAPER.kraft : 'transparent',
        }}
      />
      {/* **不自己画标题栏** —— ChatPanel 的 header 里已经有会话标题和那排按钮了，
          再加一条就是两条。"收起"作为一个动作属于那排按钮，所以用 render prop
          把它递进去，让它跟"开新对话""结束会话"待在一起。 */}
      {typeof children === 'function' ? children({ collapse: () => setOpen(false) }) : children}
    </div>
  );
}
