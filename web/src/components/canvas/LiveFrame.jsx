import { useEffect, useRef, useState } from 'react';

/**
 * LiveFrame — 双缓冲 iframe：src 变化时旧画面原地不动，新文档在一层看不见的
 * staging iframe 里加载，load 完成才提升为前台 —— 刷新（和站内换页）不再闪白。
 *
 * 同一份文件的刷新（路径相同、只有 ?v= 变了）会把滚动位置从旧文档带到新文档，
 * 用户正读到一半时 agent 改了别处样式，画面原地更新、视线不丢。换到不同页面
 * 则回到顶部（这是导航，不是刷新）。
 *
 * 实现要点：
 *   - 前台/staging 以**数组**渲染，提升时 staging 的 key 移到前台槽位，React 按
 *     key 复用同一个 DOM 节点 —— 只改样式不重载，画面无缝。JSX 固定槽位的写法
 *     做不到这一点（跨槽位不按 key 对账，会重挂 = 白闪一次）。
 *   - staging 用 visibility:hidden + absolute：不进布局流、不截事件，但照常加载
 *     和执行文档（display:none 在部分浏览器会拿不到布局，getBoundingClientRect
 *     全 0，promote 后 overlay 首帧算歪）。
 *   - onActive(frame) 在"前台文档就绪"时机触发：首挂的 onLoad + 每次提升之后。
 *     调用方在这里挂桥/重绑 overlay（等价于原来的 iframe onLoad）。
 */
export default function LiveFrame({
  src,
  title,
  sandbox = 'allow-scripts allow-same-origin',
  style,
  frameRef = null,      // 外部要拿"当前前台 iframe 元素"的 ref
  onActive = null,      // (iframeEl) => void 前台文档就绪（首载 + 每次换代）
}) {
  const keyRef = useRef(1);
  const [active, setActive] = useState(() => ({ src, key: 1 }));
  const [staging, setStaging] = useState(null);
  const activeElRef = useRef(null);
  const pendingActivateRef = useRef(false);
  const onActiveRef = useRef(onActive); onActiveRef.current = onActive;

  useEffect(() => {
    if (src === active.src) { setStaging(null); return; }
    setStaging(prev => (prev && prev.src === src) ? prev : { src, key: ++keyRef.current });
  }, [src, active.src]);

  const bindActive = (el) => {
    if (!el) return;
    activeElRef.current = el;
    if (frameRef) frameRef.current = el;
  };

  const promote = (stg, el) => {
    // 同一份文件刷新 → 滚动位置带过去；不同页面 → 回顶（导航语义）
    try {
      const oldWin = activeElRef.current?.contentWindow;
      const samePage = stripQuery(active.src) === stripQuery(stg.src);
      if (samePage && oldWin) el.contentWindow?.scrollTo(oldWin.scrollX, oldWin.scrollY);
    } catch { /* 同源场景不该抛；保守兜底 */ }
    pendingActivateRef.current = true;
    setActive(stg);
    setStaging(null);
  };

  // 提升后的 onActive 必须等 React 把节点翻到前台（样式已切换）再发，
  // 调用方 handleLoad 里的 docTick/桥重挂才指向正确的前台元素
  useEffect(() => {
    if (pendingActivateRef.current && activeElRef.current) {
      pendingActivateRef.current = false;
      onActiveRef.current?.(activeElRef.current);
    }
  }, [active]);

  const frames = [
    <iframe
      key={active.key}
      ref={bindActive}
      title={title}
      src={active.src}
      sandbox={sandbox}
      style={style}
      onLoad={(e) => { if (!pendingActivateRef.current) onActiveRef.current?.(e.currentTarget); }}
    />,
  ];
  if (staging) {
    frames.push(
      <iframe
        key={staging.key}
        title={`${title || 'frame'}-staging`}
        src={staging.src}
        sandbox={sandbox}
        style={{ ...style, position: 'absolute', left: 0, top: 0, visibility: 'hidden', pointerEvents: 'none' }}
        onLoad={(e) => promote(staging, e.currentTarget)}
      />,
    );
  }
  return <>{frames}</>;
}

function stripQuery(s) {
  return typeof s === 'string' ? s.split('?')[0] : s;
}
