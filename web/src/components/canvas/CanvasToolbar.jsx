import { Edit3, Eye, Code2, Maximize2, Settings, Sliders, MessageSquare, RotateCcw } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, STAGE } from '../../lib/theme.js';

const MODES = [
  { id: 'edit',    label: 'Edit',    icon: Edit3 },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'code',    label: 'Code',    icon: Code2 },
];

/**
 * CanvasToolbar — 2026-05-07 改造
 *
 * 布局（左→右）：
 *   [Mode segment Edit/Preview/Code]  ……spacer……  [Zoom Fit -% +]  [Tweaks 按钮+开关]  [Comment 按钮]  [System gear]
 *
 * 改造点：
 *   - **Mode segment 保留**（用户反馈：3 模式切换有用）
 *   - **Zoom 保留**（用户反馈：fit + +/- 挺有用）
 *   - **Tweaks = 按钮 + 旁边 toggle switch**：开关 ON/OFF 对应后端注入不同提示词
 *     - ON：agent 主动暴露核心微调参数让用户拖动
 *     - OFF：agent 不 expose_tweaks，按对话方式让用户提需求 agent 改
 *   - **Comment = 按钮**：点击打开评论汇总（CommentOverview），不是"进入评论模式"
 *   - **Reload 直接放 toolbar**（2026-05-07 改回；之前藏 SystemPopover 太隐蔽，
 *     iframe 偶发不刷新时用户找不到入口）
 *   - **A11y 仍在 SystemPopover**（mock，次要）
 */
export default function CanvasToolbar({
  mode, onModeChange,
  zoom = 1, isAutoFit = false, onZoomChange, onFitToggle,
  onTweaksClick, tweaksAvailable = false, tweaksOpen = false,
  tweaksEnabled = true, onTweaksEnabledChange,
  onCommentClick, commentOverviewOpen = false, commentCount = 0, commentBtnRef,
  onReload,
  onSystemClick, systemBtnRef, systemActive = false,
}) {
  return (
    <div style={{
      height: 44,
      flexShrink: 0,
      borderBottom: `1px solid ${STAGE.borderWarm}`,
      background: 'rgba(255,255,255,0.95)',
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${GAP.lg}px`,
      gap: GAP.lg,
    }}>
      {/* Mode 切换 — 保留 3 段 */}
      <div style={{
        display: 'inline-flex',
        background: 'rgba(0,0,0,0.04)',
        borderRadius: 6,
        padding: 2,
      }}>
        {MODES.map(m => {
          const Icon = m.icon;
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => onModeChange?.(m.id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
                padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
                color: active ? COLOR.text : COLOR.sub,
                background: active ? '#fff' : 'transparent',
                borderRadius: 4,
                boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              <Icon size={11} />
              {m.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      {/* Zoom */}
      {onZoomChange && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        }}>
          {onFitToggle && (
            <button
              onClick={onFitToggle}
              title={isAutoFit ? '已 fit canvas' : '自适应 canvas 宽度'}
              style={{
                ...zoomBtnStyle,
                width: 'auto', padding: `0 ${GAP.sm}px`,
                color: isAutoFit ? COLOR.text : COLOR.sub,
                background: isAutoFit ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.04)',
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              }}
            >
              <Maximize2 size={10} /> Fit
            </button>
          )}
          <button onClick={() => onZoomChange(Math.max(0.25, zoom - 0.1))} style={zoomBtnStyle}>−</button>
          <span style={{ minWidth: 36, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => onZoomChange(Math.min(3, zoom + 0.1))} style={zoomBtnStyle}>+</button>
        </div>
      )}

      {/* Tweaks 按钮 + 旁边 toggle switch — 永远显示（不再受 tweaksAvailable 控制）
          tweaksAvailable=false 表示 agent 还没 expose 任何 control，按钮还在但 panel 内是 empty state */}
      {onTweaksClick && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
        }}>
          <button
            onClick={() => { if (tweaksEnabled) onTweaksClick?.(); }}
            disabled={!tweaksEnabled}
            style={{
              padding: `${GAP.xs + 1}px ${GAP.md}px`,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: !tweaksEnabled ? COLOR.text5 : (tweaksOpen ? COLOR.text : (tweaksAvailable ? COLOR.text4 : COLOR.text5)),
              background: tweaksEnabled && tweaksOpen ? 'rgba(0,0,0,0.06)' : 'transparent',
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              borderRadius: 4,
              opacity: tweaksEnabled ? (tweaksAvailable ? 1 : 0.7) : 0.5,
              cursor: tweaksEnabled ? 'pointer' : 'not-allowed',
            }}
            title={
              !tweaksEnabled
                ? 'Tweaks 已禁用 — 用旁边开关启用'
                : !tweaksAvailable
                  ? 'agent 还没暴露任何微调参数 — 跟 agent 说一句让它 expose_tweaks（或等当前 deck 形态稳定后自动暴露）'
                  : tweaksOpen ? '关闭 Tweaks 面板' : '打开 Tweaks 面板（拖控件实时改样式）'
            }
          >
            <Sliders size={11} /> Tweaks
            {!tweaksAvailable && tweaksEnabled && (
              <span style={{
                fontSize: 9, color: COLOR.text5, marginLeft: 2,
                fontStyle: 'italic',
              }}>(空)</span>
            )}
          </button>
          {/* Toggle switch — 启用/禁用 Tweaks 模式（对应后端注入不同提示词）*/}
          <ToggleSwitch
            checked={tweaksEnabled}
            onChange={onTweaksEnabledChange}
            title={tweaksEnabled
              ? '已启用 Tweaks 模式 — agent 会主动暴露核心微调参数'
              : '已禁用 Tweaks 模式 — agent 走对话改样式不暴露控件'}
          />
        </div>
      )}

      {/* Comment 按钮 — 打开评论汇总（不是进入评论模式）*/}
      {onCommentClick && (
        <button
          ref={commentBtnRef}
          onClick={onCommentClick}
          style={{
            padding: `${GAP.xs + 1}px ${GAP.md}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
            color: commentOverviewOpen ? COLOR.text : COLOR.text4,
            background: commentOverviewOpen ? 'rgba(0,0,0,0.06)' : 'transparent',
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            borderRadius: 4,
            position: 'relative',
          }}
          title="查看本 deck 已有评论"
        >
          <MessageSquare size={11} /> Comment
          {commentCount > 0 && (
            <span style={{
              minWidth: 16, height: 14,
              padding: '0 4px',
              fontFamily: FONT_MONO, fontSize: 9, lineHeight: '14px',
              color: '#fff', background: COLOR.accent || '#c97c4a',
              borderRadius: 7,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>{commentCount}</span>
          )}
        </button>
      )}

      {/* Reload — iframe 偶发不刷新时用户主动 reload；常用，留 toolbar */}
      {onReload && (
        <button
          onClick={onReload}
          style={{
            padding: `${GAP.xs + 1}px ${GAP.sm + 1}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
            color: COLOR.text4,
            background: 'transparent',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 4,
          }}
          title="重载 iframe（agent 改完没刷的时候用）"
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <RotateCcw size={11} />
        </button>
      )}

      {/* System — 项目档案 + 收纳 A11y */}
      {onSystemClick && (
        <button
          ref={systemBtnRef}
          onClick={onSystemClick}
          style={{
            padding: `${GAP.xs + 1}px ${GAP.sm + 1}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
            color: systemActive ? COLOR.text : COLOR.text4,
            background: systemActive ? 'rgba(0,0,0,0.06)' : 'transparent',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 4,
          }}
          title="System — A11y / 项目档案"
        >
          <Settings size={11} />
        </button>
      )}
    </div>
  );
}

/**
 * 极简 toggle switch（避免引第三方）
 */
function ToggleSwitch({ checked, onChange, title }) {
  return (
    <button
      onClick={() => onChange?.(!checked)}
      title={title}
      style={{
        width: 28, height: 16,
        padding: 0,
        border: 'none',
        borderRadius: 8,
        background: checked ? '#3a2a18' : 'rgba(0,0,0,0.18)',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 0.15s',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2, left: checked ? 14 : 2,
        width: 12, height: 12,
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        transition: 'left 0.15s',
      }} />
    </button>
  );
}

const zoomBtnStyle = {
  width: 22, height: 22,
  fontFamily: 'inherit', fontSize: 12,
  color: '#3a2a18',
  background: 'rgba(0,0,0,0.04)',
  borderRadius: 4,
};
