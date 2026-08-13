import { useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import FloatingToolbar from '../ui/FloatingToolbar.jsx';
import { PAPER, PAPER_SHADOW, INK_SURFACE } from '../../lib/paper.js';
import { COLOR, GAP, FONT_SANS, FONT_SIZE, RADIUS } from '../../lib/theme.js';
import { POP_IN } from '../../lib/board-geometry.js';

/**
 * ArtifactWindow —— 三种产物共用的那扇窗（2026-08-07；2026-08-13 改成装订文件）
 *
 * 在这之前 deck / 站点 / 世界 是三个各长各样的东西：deck 是压暗背景 + 内缩的
 * 最大化窗、顶着一条 44px 的 CanvasToolbar；站点是铺满、40px 窗口头 + 30px
 * 地址栏 + 提示条三层；世界压根不是窗，只是画布卡片展开后内嵌的一块地图。
 * 同一个动作（打开一件产物看/改）长出三种外观，用户每换一种形态就要重新找
 * 一遍「关闭在哪、模式切换在哪、刷新在哪」。
 *
 * 现在的外壳：
 *
 *   压暗层（点=关）
 *   └ 窗框（inset 8/10，几乎铺满）
 *     ├ 订口：左缘一条竖带 + 三枚线迹
 *     └ 右半整列
 *       ├ 固定条（headerExtra / banner）
 *       └ 内容区
 *         ├ children
 *         ├ 身份牌 + 关闭（右上角浮层，不占布局高度）
 *         └ 浮动工具栏（FloatingToolbar，可拖，位置按项目记住）
 *
 * ## 为什么工具要浮起来
 *
 * 固定工具栏是按"最宽的那一种"占高度的：deck 44px + 站点 40+30+提示条，
 * 内容区被永久切掉一条，而那些按钮大部分时候你并不在用。浮起来之后
 * 内容拿到整扇窗，工具想放哪放哪（挡住了就拖开），三种窗共用同一个容器组件。
 *
 * ## 2026-08-13：名牌条也退役了
 *
 * 那条 34px 的横带是浏览器顶栏的思路 —— 工具搬进浮动工具栏之后它只剩身份和
 * 关闭两样东西，不值一整条。改成右上角一小片浮起来的纸，内容真正吃满；
 * 窗自己的 inset 也从 16/20 收到 8/10。
 *
 * ## 关闭钮为什么不跟着工具条跑
 *
 * 它是唯一一个"必须永远在同一个地方"的控件 —— 找不到关闭的窗口是能把人
 * 困住的。所以身份与关闭是一片**位置固定**的浮层，只有工具进浮动工具栏。
 *
 * ⚠️ 从左上角挪到右上角是用户 2026-08-13 拍的板（聊天栏之后要改位置）。
 * 在聊天栏挪走之前，右上角**可能被它压住** —— ESC 和点压暗层是活的退路。
 * 原来在左的理由记在这儿备查：聊天栏默认贴右浮在窗上面，左边是唯一一块
 * 浮窗默认不去的地方。
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

/** 订口宽度：够画三枚线迹，又不真占走内容 */
const BINDING_W = 20;

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
  /** 身份牌上跟关闭钮并排的东西（站点的上线控件） */
  chromeExtra = null,
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

      {/* 窗 = 一份摊开的装订文件。左缘那条是订口，其余全交给内容。 */}
      <div style={{
        position: 'absolute', inset: '8px 10px',
        background: PAPER.paper, borderRadius: 10, overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(30,22,8,0.45)',
        display: 'flex',
        animation: POP_IN,
      }}>
        {/* 订口：一条竖带 + 三枚线迹。装订在左边是因为右边归浮窗
            （聊天栏默认贴右），左缘是这扇窗唯一能长期占住的一条边。 */}
        <div aria-hidden style={{
          width: BINDING_W, flexShrink: 0, position: 'relative',
          background: PAPER.wall,
          borderRight: `1px solid ${PAPER.hair}`,
        }}>
          {[0.28, 0.5, 0.72].map(t => (
            <div key={t} style={{
              position: 'absolute', left: '50%', top: `${t * 100}%`,
              width: 2, height: 26, marginLeft: -1, marginTop: -13,
              borderRadius: 1, background: PAPER.pencil, opacity: 0.75,
            }} />
          ))}
        </div>

        {/* 右半整列。固定条在**内容区之外** —— contentRef 同时是浮动工具栏的
            活动边界，把固定条圈进去的话工具条的默认落点（上方居中）正好压在
            deck 的试作切换条上。 */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {headerExtra}
          {banner}

          <div
            ref={contentRef}
            style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', ...contentStyle }}
          >
            {children}

            {/* 身份牌 + 关闭（位置固定，理由见文件头） */}
            <div style={{
              position: 'absolute', top: GAP.sm, right: GAP.sm, zIndex: 20,
              display: 'flex', alignItems: 'center', gap: GAP.sm,
              padding: `${GAP.xxs}px ${GAP.xxs}px ${GAP.xxs}px ${GAP.sm}px`,
              maxWidth: '46%',
              background: PAPER.paper, borderRadius: RADIUS.md,
              boxShadow: PAPER_SHADOW.far,
            }}>
              <span style={{
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600, color: COLOR.text,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
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
              {chromeExtra}
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
