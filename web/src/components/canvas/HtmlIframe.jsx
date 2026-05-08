import { useEffect, useRef } from 'react';
import { attachEditMode, detachAll } from './DirectEditBridge.js';

/**
 * HtmlIframe — 加载 HTML 产物的核心 iframe
 *
 * iframe logical viewport 固定 1920×1080（设计稿坐标系），通过
 * `transform: scale(zoom)` 缩放到 wrap 容器内（contain letterbox 居中）。
 * 内部 fit script 注 100vw×100vh `__nd-page-frame` 包每个 section，
 * scroll-snap-y mandatory → 滚轮 / 键盘按页切；跟 standalone 离线打开行为一致。
 *
 * 模式行为：
 *   - 'edit'    iframe 加载完成后挂 dblclick / click bridge（contenteditable + select）
 *   - 'preview' 加载但不挂 bridge，纯展示
 *
 * P1：sandbox 暂时给 allow-scripts allow-same-origin（开发同源）；部署不同 origin 时
 *     退化成 postMessage 通信，bridge 文件预埋 listener。
 */
const DECK_W = 1920;
const DECK_H = 1080;
export default function HtmlIframe({ src, srcDoc, mode = 'edit', onSelect, onTextEdit, onIframeReady, zoom = 1 }) {
  const ref = useRef(null);
  const loadedRef = useRef(false);

  // C32：保留 reload 前的 scrollY，让 FileChanged hook 触发的 reload 不丢用户位置
  // 用 useRef 而非 state（避免 reload 触发额外 re-render）
  const lastScrollY = useRef(0);

  // mode 切换 → 重新挂/卸 bridge（不需要 reload）
  useEffect(() => {
    const iframe = ref.current;
    if (!iframe || !loadedRef.current) return;
    detachAll(iframe);
    if (mode === 'edit') {
      attachEditMode(iframe, { onSelect, onTextEdit });
    }
    return () => detachAll(iframe);
  }, [mode, onSelect, onTextEdit]);

  // C32：src 变化（reloadToken bump）前，从当前 iframe 内捕获 scrollY
  // useEffect 在 src prop 变化时跑，DOM 还没换 → contentWindow 仍是旧 doc
  useEffect(() => {
    return () => {
      // cleanup 在 src 变化前跑（React effect 卸载时）—— 此时 iframe 仍是旧内容
      try {
        const win = ref.current?.contentWindow;
        if (win && typeof win.scrollY === 'number') {
          lastScrollY.current = win.scrollY;
        }
      } catch { /* cross-origin / window null */ }
    };
  }, [src, srcDoc]);

  // src / srcDoc 切换 → reload。loaded 后再 attach bridge + 还原 scrollY
  const handleLoad = () => {
    loadedRef.current = true;
    const iframe = ref.current;
    if (!iframe) return;
    onIframeReady?.(iframe); // 把 iframe 元素回报给父，父可以拿 .contentDocument
    if (mode === 'edit') {
      attachEditMode(iframe, { onSelect, onTextEdit });
    }
    // C32：还原 scrollY（agent reload 后用户位置不丢）
    if (lastScrollY.current > 0) {
      try {
        // 等下一帧 layout 稳定再 scroll，避免 0 位置撞回
        requestAnimationFrame(() => {
          try { iframe.contentWindow?.scrollTo(0, lastScrollY.current); } catch { /* cross-origin */ }
        });
      } catch { /* ignore */ }
    }
  };

  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      overflow: 'hidden',
      background: '#fff',
      position: 'relative',
      // letterbox：iframe 1920×1080 缩放后居中放置；外侧空隙是白底 letterbox
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <iframe
        ref={ref}
        src={src}
        srcDoc={srcDoc}
        onLoad={handleLoad}
        sandbox="allow-scripts allow-same-origin"
        style={{
          // logical viewport 固定 1920×1080，让 iframe 内 fit script 的 100vw/100vh
          // = 设计稿尺寸 = scroll-snap 切页边界 = 跟 standalone 离线打开行为一致
          width: `${DECK_W}px`,
          height: `${DECK_H}px`,
          flexShrink: 0,
          border: 0,
          background: '#fff',
          transform: zoom === 1 ? 'none' : `scale(${zoom})`,
          transformOrigin: 'center center',
        }}
      />
    </div>
  );
}
