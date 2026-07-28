import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Monitor, Tablet, Smartphone, RotateCw, ExternalLink, FileCode, Eye, ArrowLeft } from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { SITE_VIEWPORTS, POP_IN } from '../../lib/board-geometry.js';
import CodeCanvas from './CodeCanvas.jsx';

/**
 * SiteWindow —— 站点的最大化窗口（2026-07-28，跟 DeckWindow 并列的第二种产物窗）
 *
 * 为什么不复用 DeckWindow：那扇窗的核心是 **letterbox**——把一份 1920×1080 的设计稿
 * 等比缩进窗口里。站点没有"设计稿尺寸"这回事，它的版面是被视口宽度算出来的。
 * 拿 deck 那套缩放去看站点，手机档只会得到"缩小的桌面版"，断点有没有生效根本
 * 看不出来 —— 那等于给 agent 和用户都蒙上眼睛，还是无声的。
 *
 * 所以这里：iframe 的 CSS 像素宽 = 目标设备宽度，**不做 transform 缩放**；
 * 窗口装不下就整体等比缩一次（只为了塞进屏幕，媒体查询已经按真实宽度算过了）。
 *
 * 站内导航是窗口内部状态：点站内链接就在同一扇窗里换页，地址栏跟着走。
 */
export default function SiteWindow({
  projectId,
  task,
  entry = 'index.html',
  title,
  pages = [],
  refreshToken = 0,
  onClose,
}) {
  const [viewport, setViewport] = useState(SITE_VIEWPORTS[0].id);
  const [tab, setTab] = useState('preview');
  const [current, setCurrent] = useState(entry);      // 当前看的是站内哪一页
  const [history, setHistory] = useState([]);          // 站内后退栈
  const [sourceText, setSourceText] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [wrapSize, setWrapSize] = useState({ width: 0, height: 0 });
  const wrapRef = useRef(null);
  const iframeRef = useRef(null);

  const vp = SITE_VIEWPORTS.find(v => v.id === viewport) || SITE_VIEWPORTS[0];
  const relPath = `tasks/${task}/${current}`;
  const src = `${Assets.artifactFileUrl(projectId, relPath)}?v=${refreshToken}-${reloadKey}`;

  // 换任务 / 换入口时回到入口页（同一扇窗被复用的场景）
  useEffect(() => { setCurrent(entry); setHistory([]); }, [task, entry]);

  // 量取景框：只在窗口装不下目标宽度时整体缩一次
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setWrapSize(prev => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    let ro = null;
    try { ro = new ResizeObserver(measure); ro.observe(el); } catch { /* 老浏览器回退 window */ }
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [tab]);

  const scale = wrapSize.width > 0 ? Math.min(1, (wrapSize.width - 32) / vp.w) : 1;

  // Code 标签：拉当前这一页的源码
  useEffect(() => {
    if (tab !== 'code') return;
    let cancelled = false;
    fetch(Assets.artifactFileUrl(projectId, relPath))
      .then(r => r.text())
      .then(t => { if (!cancelled) setSourceText(t); })
      .catch(() => { if (!cancelled) setSourceText('<!-- 读不到源码 -->'); });
    return () => { cancelled = true; };
  }, [tab, projectId, relPath, reloadKey, refreshToken]);

  const navigateTo = useCallback((page) => {
    setHistory(h => [...h, current]);
    setCurrent(page);
  }, [current]);

  const goBack = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setCurrent(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }, []);

  // ESC 的 handler 只挂一次（依赖 onClose），拿 ref 读最新的后退栈与后退动作，
  // 免得每次导航都重挂 listener
  const historyRef = useRef(history);
  const goBackRef = useRef(goBack);
  useEffect(() => { historyRef.current = history; goBackRef.current = goBack; }, [history, goBack]);

  // ESC：站内有后退栈先后退，栈空了才关窗（跟 DeckWindow 的"先清选中再关窗"同构）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.stopPropagation();
      if (historyRef.current.length > 0) goBackRef.current();
      else onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);


  /**
   * 站内链接接管：iframe 里点 `<a href="about.html">` 默认会在 iframe 内部跳转，
   * 地址栏和「当前页」状态就跟丢了 —— 用户后退不了，Code 标签还显示着上一页的源码。
   * 这里在 load 后拦截同源站内链接，翻译成窗口状态。
   */
  const handleLoad = useCallback(() => {
    const frame = iframeRef.current;
    let doc;
    try { doc = frame?.contentDocument; } catch { return; }
    if (!doc) return;
    const dir = current.includes('/') ? current.slice(0, current.lastIndexOf('/') + 1) : '';
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/^(?:[a-z][a-z0-9+\-.]*:|\/\/|#)/i.test(href)) continue;   // 外链 / 锚点不管
      a.addEventListener('click', (e) => {
        const clean = href.split('#')[0].split('?')[0];
        if (!clean) return;
        // 站内相对路径归一成"相对任务目录"
        const parts = (dir + clean).split('/');
        const stack = [];
        for (const seg of parts) {
          if (seg === '.' || seg === '') continue;
          if (seg === '..') stack.pop();
          else stack.push(seg);
        }
        const next = stack.join('/');
        if (!/\.html?$/i.test(next)) return;    // 不是站内页面就交回浏览器
        e.preventDefault();
        navigateTo(next);
      });
    }
  }, [current, navigateTo]);

  const pageList = useMemo(() => (pages.length ? pages : [entry]), [pages, entry]);

  const tabBtn = (id, label, Icon) => (
    <button
      onClick={() => setTab(id)}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer',
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
        background: tab === id ? COLOR.text : 'transparent',
        color: tab === id ? '#fff' : COLOR.sub,
      }}
    >
      <Icon size={11} />{label}
    </button>
  );

  const vpBtn = (v) => {
    const Icon = v.icon === 'monitor' ? Monitor : v.icon === 'tablet' ? Tablet : Smartphone;
    return (
      <button
        key={v.id}
        onClick={() => setViewport(v.id)}
        title={`${v.label} · ${v.w}px`}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 8px', borderRadius: 5, border: 'none', cursor: 'pointer',
          fontFamily: FONT_MONO, fontSize: 10,
          background: viewport === v.id ? 'rgba(0,0,0,0.07)' : 'transparent',
          color: viewport === v.id ? COLOR.text : COLOR.sub,
        }}
      >
        <Icon size={11} />{v.w}
      </button>
    );
  };

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 400,
      display: 'flex', flexDirection: 'column',
      background: '#fff', animation: POP_IN,
    }}>
      {/* 窗口头 */}
      <div style={{
        height: 40, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `0 ${GAP.md}px`,
        borderBottom: `1px solid ${COLOR.borderLt}`,
      }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600, color: COLOR.text }}>
          {title || task}
        </span>
        <div style={{ display: 'flex', gap: 2 }}>
          {tabBtn('preview', '预览', Eye)}
          {tabBtn('code', '源码', FileCode)}
        </div>
        <div style={{ flex: 1 }} />
        {tab === 'preview' && <div style={{ display: 'flex', gap: 2 }}>{SITE_VIEWPORTS.map(vpBtn)}</div>}
        <button onClick={() => setReloadKey(k => k + 1)} title="刷新" style={iconBtn}>
          <RotateCw size={13} />
        </button>
        <a
          href={Assets.artifactFileUrl(projectId, relPath)} target="_blank" rel="noreferrer"
          title="在新标签页打开" style={{ ...iconBtn, textDecoration: 'none' }}
        >
          <ExternalLink size={13} />
        </a>
        <button onClick={onClose} title="关闭（ESC）" style={iconBtn}>
          <X size={14} />
        </button>
      </div>

      {/* 地址栏：站内页面清单 + 后退 */}
      <div style={{
        height: 30, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 6,
        padding: `0 ${GAP.md}px`,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        background: '#fafaf9',
        overflowX: 'auto',
      }}>
        <button onClick={goBack} disabled={history.length === 0} title="后退" style={{
          ...iconBtn, opacity: history.length === 0 ? 0.3 : 1,
          cursor: history.length === 0 ? 'default' : 'pointer',
        }}>
          <ArrowLeft size={12} />
        </button>
        {pageList.map(p => (
          <button
            key={p}
            onClick={() => (p === current ? null : navigateTo(p))}
            style={{
              padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontFamily: FONT_MONO, fontSize: 10, whiteSpace: 'nowrap',
              background: p === current ? 'rgba(0,0,0,0.07)' : 'transparent',
              color: p === current ? COLOR.text : COLOR.sub,
            }}
          >
            {p}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      {tab === 'preview' ? (
        <div ref={wrapRef} style={{
          flex: 1, minHeight: 0, overflow: 'auto',
          display: 'flex', justifyContent: 'center',
          background: '#f4f2ee', padding: GAP.md,
        }}>
          {/* 外壳按缩放后的尺寸占位，iframe 按**真实设备宽度**渲染再整体缩。
              transformOrigin 必须是 top left：用 top center 的话，1440 宽的元素在
              1108 宽的盒子里绕中心缩放，左边缘会往右挪 (720-720×scale) px，整个
              取景框看着偏右一大块。 */}
          <div style={{
            width: vp.w * scale,
            height: Math.max(0, wrapSize.height - GAP.md * 2),
            flexShrink: 0,
          }}>
            <iframe
              ref={iframeRef}
              key={`${relPath}-${reloadKey}`}
              title={`site-${task}-${current}`}
              src={src}
              onLoad={handleLoad}
              sandbox="allow-scripts allow-same-origin"
              style={{
                width: vp.w,
                height: scale > 0 ? Math.max(0, (wrapSize.height - GAP.md * 2) / scale) : '100%',
                border: 0,
                background: '#fff',
                boxShadow: '0 2px 18px rgba(0,0,0,0.08)',
                display: 'block',
                transform: scale < 1 ? `scale(${scale})` : 'none',
                transformOrigin: 'top left',
              }}
            />
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <CodeCanvas value={sourceText} readOnly onChange={() => {}} />
        </div>
      )}
    </div>
  );
}

const iconBtn = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 24, height: 24, borderRadius: 5,
  border: 'none', background: 'transparent', color: COLOR.sub, cursor: 'pointer',
};
