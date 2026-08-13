import { useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import FloatingToolbar from '../ui/FloatingToolbar.jsx';
import { PAPER, PAPER_SHADOW, GRAIN, INK_SURFACE } from '../../lib/paper.js';
import { COLOR, GAP, FONT_SANS, FONT_SIZE, RADIUS } from '../../lib/theme.js';
import { POP_IN } from '../../lib/board-geometry.js';
import { exportItemsFor } from '../../lib/export-formats.js';

/**
 * ArtifactWindow —— 三种产物共用的那扇窗（2026-08-07；2026-08-13 改成装订文件）
 *
 * 在这之前 deck / 站点 / 世界 是三个各长各样的东西：deck 是压暗背景 + 内缩的
 * 最大化窗、顶着一条 44px 的 CanvasToolbar；站点是铺满、40px 窗口头 + 30px
 * 地址栏 + 提示条三层；世界压根不是窗，只是画布卡片展开后内嵌的一块地图。
 * 同一个动作（打开一件产物看/改）长出三种外观，用户每换一种形态就要重新找
 * 一遍「关闭在哪、模式切换在哪、刷新在哪」。
 *
 * 现在的外壳 —— **一张钉在板上的大纸**，跟首页那些项目卡是同一套物料
 * （纸色 + 颗粒 + 单光向影子 + 直角）：
 *
 *   压暗层（点=关）
 *   └ 纸（inset 8/10，几乎铺满）
 *     ├ 顶栏（30px）：钉纽扣 · 这是什么 · 关闭
 *     ├ 固定条（headerExtra / banner）
 *     └ 内容区
 *       ├ children
 *       └ 浮动工具栏（FloatingToolbar，可拖，位置按项目记住）
 *
 * ## 为什么工具要浮起来
 *
 * 固定工具栏是按"最宽的那一种"占高度的：deck 44px + 站点 40+30+提示条，
 * 内容区被永久切掉一条，而那些按钮大部分时候你并不在用。浮起来之后
 * 内容拿到整扇窗，工具想放哪放哪（挡住了就拖开），三种窗共用同一个容器组件。
 *
 * ## 2026-08-13 的两次改动，第二次推翻了第一次的一半
 *
 * 先把 34px 的名牌条整个拆了（工具搬走之后它只剩身份和关闭，不值一整条），
 * 窗做成左缘带订口的"装订文件"。用户看完的评价是**丑，而且跟设计语言不合**
 * —— 全站是直角纸质卡片，装订那套线迹是另一个物料世界的东西。
 *
 * 所以回到纸：外壳照首页项目卡那张纸做（纸色 + 颗粒 + PAPER_SHADOW + 直角），
 * 顶上留一条**很窄**的顶栏装身份和关闭，正中钉一枚纽扣。inset 保持 8/10 ——
 * "内容吃满"那半是对的，留下了。
 *
 * ## 关闭钮为什么不跟着工具条跑
 *
 * 它是唯一一个"必须永远在同一个地方"的控件 —— 找不到关闭的窗口是能把人
 * 困住的。所以它钉死在顶栏右端，只有工具进浮动工具栏。
 *
 * ⚠️ 放右边是用户 2026-08-13 拍的板（聊天栏之后要改位置）。在聊天栏挪走
 * 之前，右上角**可能被它压住** —— ESC 和点压暗层是活的退路。原来在左的
 * 理由记在这儿备查：聊天栏默认贴右浮在窗上面，左边是唯一一块浮窗默认
 * 不去的地方。
 */

/**
 * 窗在画布之上、浮窗层之下。
 *
 * 「之下」是刻意的：聊天栏要能压在打开的产物上面，不然看着 deck 就没法跟
 * agent 说话，而那是这个工具的全部意义。靠的是 ProjectWorkspace 里画布
 * section 的 `isolation:'isolate'` —— 窗关在那个层叠上下文里出不来，
 * 外面的浮窗层永远在上。
 */
export const ARTIFACT_WINDOW_Z = 500;

/** 顶栏高度。只装身份和关闭，越窄越好 —— 内容才是主角 */
const CHROME_H = 30;

export default function ArtifactWindow({
  /** 'deck' | 'site' | 'world' —— 决定工具条位置存在哪个槽位 */
  kind,
  title,
  /** 身份牌上标题右边的小字（站点写当前页，世界写地点/角色计数） */
  subtitle = null,
  onClose,
  /** 浮动工具栏的组，形状见 FloatingToolbar */
  groups = [],
  /**
   * 窗里的工具横着排一条。画布那条是竖着堆的（那边只有两组，且左上角是
   * 传统工具箱位置）；窗里组数多（模式 / 页面 / 视口 / 动作），竖着堆会长成
   * 一根柱子把内容从上到下切开。
   */
  toolbarStack = 'row',
  /**
   * 默认落在上方居中。**不是** Figma 那种底部居中 —— 窗底早就住着三条别的
   * 东西（幻灯翻页、待应用改动、拖拽暂存确认），而且这三种窗的工具本来就
   * 在顶上，工具还在原来的位置只是浮起来了，肌肉记忆不用重建。
   */
  toolbarAnchor = 'top-center',
  /** 内容区顶上的说明条：怎么用 / 警示。说明不是工具，不进工具栏 */
  banner = null,
  /** 固定条：内容区上方那条一直在的横带（deck 的试作切换） */
  headerExtra = null,
  /**
   * ESC 关窗。**自己有 ESC 优先级的窗要关掉它**（deck 和站点都是「先清选中 /
   * 先站内后退，都没有才关」）—— 两边都挂 window 监听的话，先注册的先跑，
   * 而 React 的 effect 是子先父后，这个壳会抢在窗前面把窗关掉。
   */
  escToClose = true,
  children,
  contentStyle,
}) {
  const contentRef = useRef(null);

  useEffect(() => {
    if (!onClose || !escToClose) return;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target;
      if (t?.getAttribute?.('contenteditable') === 'true') return;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, escToClose]);

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: ARTIFACT_WINDOW_Z }}>
      <style>{'@keyframes ndDimIn{from{opacity:0}to{opacity:1}}'}</style>
      <div
        onClick={onClose}
        title="点击回到工作台"
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(32, 26, 14, 0.4)',
          animation: 'ndDimIn 200ms ease',
        }}
      />

      {/* 窗 = 一张钉在板上的大纸（物料同首页项目卡：纸色 + 颗粒 + 直角） */}
      <div style={{
        position: 'absolute', inset: '8px 10px',
        background: PAPER.paper, backgroundImage: GRAIN,
        borderRadius: 0, overflow: 'hidden',
        boxShadow: PAPER_SHADOW.near,
        display: 'flex', flexDirection: 'column',
        animation: POP_IN,
      }}>
        {/* 顶栏：钉纽扣 · 这是什么 · 关闭。只有这三样，越窄越好。 */}
        <div style={{
          height: CHROME_H, flexShrink: 0, position: 'relative',
          display: 'flex', alignItems: 'center', gap: GAP.sm,
          padding: `0 ${GAP.xs}px 0 ${GAP.md}px`,
          borderBottom: `1px solid ${PAPER.hair}`,
        }}>
          {/* 钉纽扣：跟首页那些卡是同一枚钉子（同一段渐变、同一个光向）。
              纯装饰，不吃事件 —— 它说明的是"这张纸是被钉上去的"。 */}
          <span aria-hidden style={{
            position: 'absolute', left: '50%', top: 6, marginLeft: -4.5,
            width: 9, height: 9, borderRadius: '50%', pointerEvents: 'none',
            background: 'radial-gradient(circle at 35% 30%, #8a7a62, #453a2c 65%)',
            boxShadow: '-1px 2px 3px rgba(43,33,23,0.45)',
          }} />

          <span style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600, color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '32%',
          }}>
            {title}
          </span>
          {subtitle && (
            <span style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
            }}>
              {subtitle}
            </span>
          )}

          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="关闭（Esc）"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: RADIUS.sm, flexShrink: 0,
              border: 'none', background: 'transparent', color: COLOR.sub, cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={14} />
          </button>
        </div>

        {headerExtra}
        {banner}

        <div
          ref={contentRef}
          style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', ...contentStyle }}
        >
          {children}

          {/* ⚠️ 工具栏必须渲染在 contentRef **内部**：anchoredPosition 只拿
              bounds 的宽高算落点，坐标却是相对自己 offset parent 的。渲染在
              外面的话 `top-center` 会落到固定条上面去 —— 两者差一个固定条
              的高度，而且只有 deck（有试作切换条）那扇窗看得出来。 */}
          <FloatingToolbar
            id={`win-${kind}`}
            groups={groups}
            boundsRef={contentRef}
            anchor={toolbarAnchor}
            stack={toolbarStack}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 说明条。窗内容上方那条浅色提示（怎么用 / 这是构建产物 / 拼贴式版面警告）。
 * 各窗自己拼内容，样式统一在这。
 */
export function WindowBanner({ children }) {
  return (
    <div style={{
      flexShrink: 0, padding: `${GAP.xs}px ${GAP.md}px`,
      display: 'flex', alignItems: 'center', gap: GAP.sm,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
      background: '#fdf8ef', borderBottom: `1px solid ${COLOR.borderLt}`,
    }}>
      {children}
    </div>
  );
}

/** 工具条上的墨色小读数（缩放百分比那种），跟 INK_SURFACE 同一套色 */
export const INK_READOUT = {
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
  color: INK_SURFACE.text,
};

/**
 * 导出组 —— 三扇窗共用的那一小撮按钮（2026-08-13 从顶栏搬进工具栏）。
 *
 * 顶栏那个下拉是"对当前聚焦的任务导出"，而窗开着的时候当前上下文明明白白
 * 就是这一件产物，还要收起窗去顶栏找一遍是绕路。
 *
 * 格式清单由**服务端**给（`/artifacts` 的 `tasks[].exports`，随 focusDeck 一路
 * 传下来），前端不硬编码 —— 第三种形态上线时这里自动跟上。
 *
 * ⚠️ 导出路由目前仍是会话作用域的（`Exports.download(pid, sid, format)`），
 * 没有活跃会话时点了会 toast「请先选中一个会话再导出」。那是会话耦合时代的
 * 遗留，跟这条工具栏无关。
 */
export function exportToolGroup({ kind, exports: formats, onExport }) {
  if (!onExport) return null;
  const items = exportItemsFor(kind, formats).map(it => ({
    id: it.id,
    icon: it.icon,
    title: `导出 ${it.label} —— ${it.desc}`,
    onClick: () => onExport(it.id),
  }));
  return items.length ? { id: 'export', items } : null;
}
