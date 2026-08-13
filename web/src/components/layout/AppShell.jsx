import { useState, useEffect, useRef } from 'react';
import { COLOR } from '../../lib/theme.js';
import TopBar from './TopBar.jsx';

/**
 * AppShell — 整站外壳：顶栏 + 主内容
 *
 * 两种排布：
 *
 * - **默认（首页 / 橱窗 / 控制台）**：顶栏占一行，内容在它下面。这些页面
 *   本来就是从上往下读的，顶栏是版面的一部分。
 *
 * - **`overlayTop`（工作台）**：顶栏**浮在内容之上**，内容吃满整个视口高度，
 *   鼠标离开顶部就淡出。工作台的内容是一整块画布，横带越少越好。
 *
 *   为什么必须是"浮在上面"而不是"收起时高度变 0"：顶栏一旦参与布局，
 *   收起/展开就会改变画布容器的高度 —— 相机的可视区跟着变，contain 约束
 *   重算，**画面会跳**。浮起来之后画布高度是恒定的 100vh，顶栏来去只是
 *   一层透明度，画布一个像素都不动。
 */

/**
 * 鼠标进到离顶部这么近就唤出顶栏。
 *
 * **只留很薄一条（10px）**：一开始给的是 56（顶栏自己的高度），结果是画布最上面
 * 那一条被顶栏偷走了 —— 那儿要是摆着一个文件夹，鼠标一凑过去顶栏就浮出来盖住它，
 * 点下去点到的是 logo。「接近」应该是"贴到屏幕边上"这个明确动作，不是"往上面走"。
 */
const REVEAL_ZONE = 10;
/** 移开之后再等这么久才淡出（免得贴着边界抖动） */
const HIDE_DELAY = 600;

export default function AppShell({
  breadcrumb, actions, children, overlayTop = false,
  /**
   * 有东西铺满屏幕时（产物窗开着），顶栏**连浮现都不要**。
   *
   * 感应带只有 10px，本来不该碍事 —— 但产物窗的关闭钮就在右上角，鼠标去够它
   * 的路上必然扫过顶部那条，顶栏浮出来正好盖住它（2026-08-13 用户报的）。
   * 顶栏管的是"这个项目"，窗开着的时候那一层根本不是当前上下文。
   */
  topSuppressed = false,
}) {
  const [revealed, setRevealed] = useState(true);
  const hostRef = useRef(null);
  const timerRef = useRef(null);
  // 顶栏里开着菜单（导出 / ⋯ / 头像）时不许收 —— 收了菜单就悬在半空
  const holdRef = useRef(false);

  useEffect(() => {
    if (!overlayTop) return undefined;
    if (topSuppressed) { clearTimeout(timerRef.current); setRevealed(false); return undefined; }
    const schedule = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (!holdRef.current) setRevealed(false);
      }, HIDE_DELAY);
    };
    const onMove = (e) => {
      if (e.clientY <= REVEAL_ZONE) {
        clearTimeout(timerRef.current);
        setRevealed(true);
      } else {
        schedule();
      }
    };
    // 顶栏内部随便点了什么（打开菜单）都算"手还在上面"
    const onFocusIn = (e) => {
      holdRef.current = !!e.target?.closest?.('[data-top-bar]');
      if (holdRef.current) setRevealed(true);
    };
    const onDown = (e) => {
      holdRef.current = !!e.target?.closest?.('[data-top-bar]');
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('focusin', onFocusIn);
    schedule();
    return () => {
      clearTimeout(timerRef.current);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [overlayTop, topSuppressed]);

  if (!overlayTop) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: COLOR.bg }}>
        <TopBar breadcrumb={breadcrumb} actions={actions} />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
      </div>
    );
  }

  return (
    <div ref={hostRef} style={{ position: 'relative', height: '100vh', background: COLOR.bg, overflow: 'hidden' }}>
      {/* 内容吃满整屏。顶栏来去不改它一个像素 —— 这是整件事的重点 */}
      <div style={{ position: 'absolute', inset: 0 }}>{children}</div>

      <div
        data-top-bar
        onPointerEnter={() => setRevealed(true)}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          // 顶栏之上还有浮窗层（聊天栏 z≈120）；顶栏要压得住它，
          // 否则唤出来的顶栏被聊天栏盖掉一半
          zIndex: 900,
          opacity: revealed ? 1 : 0,
          transform: revealed ? 'translateY(0)' : 'translateY(-100%)',
          // 收起时整条不吃指针，否则画布顶部一条永远点不到
          pointerEvents: revealed ? 'auto' : 'none',
          transition: 'opacity 220ms ease, transform 260ms cubic-bezier(0.32,0.72,0,1)',
        }}
      >
        <TopBar breadcrumb={breadcrumb} actions={actions} />
      </div>

      {/* 收起时贴顶的一条感应带：鼠标扫到就唤出（pointermove 已经能唤，
          这层是给"从窗口外面直接滑进来"那种不产生 move 事件的情况兜底） */}
      {!revealed && !topSuppressed && (
        <div
          onPointerEnter={() => setRevealed(true)}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: REVEAL_ZONE, zIndex: 899 }}
        />
      )}
    </div>
  );
}
