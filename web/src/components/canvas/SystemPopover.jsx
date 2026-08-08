import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import { useAnchoredPosition } from '../../lib/anchored-popover.js';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { TEXT_FONT_CSS, TEXT_FONT_LABELS, TEXT_SIZE_LABELS } from '../../lib/text-fonts.js';
import SystemTab from '../context-panel/SystemTab.jsx';
import DecisionsTab from '../context-panel/DecisionsTab.jsx';

/**
 * SystemPopover — 项目档案 popover（贴 toolbar Settings 按钮）
 *
 * 2026-05-07：A11y 留在这里（mock，次要工具）；Reload 改回 toolbar 直接显示。
 *
 * 内容：
 *   - 顶部 Canvas 工具（A11y）
 *   - 中部 SystemTab 4 段（Skill / DS / Model / Spec 摘要）
 *   - 底部"项目档案"折叠（默认收起）：展开后嵌 DecisionsTab（含 decisions + history）
 */
export default function SystemPopover({
  anchorRef, onClose,
  project, deckSpec,
  projectId, sessionId, decisionsReloadKey = 0,
  onA11yClick,
  // Tweaks 模式开关（2026-08-07 从工具栏挪进来）：它是**会话设置**不是工具 ——
  // 决定后端给 agent 注入哪一版提示词，设一次管一整段，不该常驻占工具位。
  tweaksEnabled = null, onTweaksEnabledChange = null,
}) {
  const canvasFont = useGlobalStore(st => st.canvasFont);
  const setCanvasFont = useGlobalStore(st => st.setCanvasFont);
  const ref = useRef(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const anchored = useAnchoredPosition(anchorRef, 360);

  // 点外面关
  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose?.();
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [onClose, anchorRef]);

  // ESC 关
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        ...anchored,
        width: 360,
        background: COLOR.bgWhite,
        borderRadius: 2,
        boxShadow:
          '0 2px 4px rgba(0,0,0,0.04), 0 8px 20px rgba(0,0,0,0.08), 0 24px 48px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.8)',
        zIndex: 60,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: `${GAP.md}px ${GAP.lg}px`,
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        flexShrink: 0,
      }}>
        <SettingsIcon size={12} color={COLOR.text4} />
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text,
        }}>System</span>
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {/* Canvas 工具（A11y） */}
        {onA11yClick && (
          <div style={{
            padding: `${GAP.md}px ${GAP.lg}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
            display: 'flex', flexDirection: 'column', gap: GAP.sm,
          }}>
            <div style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.sub, textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              Canvas 工具
            </div>
            <div style={{ display: 'flex', gap: GAP.sm }}>
              <button
                onClick={() => { onA11yClick(); onClose?.(); }}
                style={popoverToolBtn}
                title="无障碍审查（mock）"
              >
                <ShieldCheck size={11} /> A11y
              </button>
            </div>
          </div>
        )}

        {onTweaksEnabledChange && (
          <div style={{
            padding: `${GAP.md}px ${GAP.lg}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
            display: 'flex', alignItems: 'center', gap: GAP.sm,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text }}>
                Tweaks 模式
              </div>
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2, lineHeight: 1.5 }}>
                {tweaksEnabled
                  ? '开：agent 会主动把核心参数做成控件让你拖'
                  : '关：不暴露控件，改样式走对话'}
              </div>
            </div>
            <ToggleSwitch checked={!!tweaksEnabled} onChange={onTweaksEnabledChange} />
          </div>
        )}

        {/* 画布手写字体（2026-08-08）。放设置里而不是工具栏：它是设一次管很久的
            偏好，不是每次落笔都要选的东西。存 localStorage —— 是这台机器上这个
            人的手感，不是项目属性。 */}
        <div style={{
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderBottom: `1px solid ${COLOR.borderLt}`,
        }}>
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text }}>
            画布手写字体
          </div>
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2, marginBottom: GAP.sm }}>
            用「文字」工具（T）在画布上写字时用这个
          </div>
          <div style={{ display: 'flex', gap: GAP.xs, flexWrap: 'wrap' }}>
            {Object.entries(TEXT_FONT_LABELS).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCanvasFont({ ...canvasFont, font: k })}
                style={{
                  padding: `${GAP.xs}px ${GAP.sm}px`, borderRadius: RADIUS.md, cursor: 'pointer',
                  fontFamily: TEXT_FONT_CSS[k], fontSize: FONT_SIZE.sm,
                  border: `1px solid ${canvasFont.font === k ? COLOR.text : COLOR.borderLt}`,
                  background: canvasFont.font === k ? COLOR.text : 'transparent',
                  color: canvasFont.font === k ? COLOR.bg : COLOR.text2,
                }}
              >{label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: GAP.xs, marginTop: GAP.sm }}>
            {Object.entries(TEXT_SIZE_LABELS).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCanvasFont({ ...canvasFont, size: k })}
                style={{
                  padding: `${GAP.xs}px ${GAP.sm}px`, borderRadius: RADIUS.md, cursor: 'pointer',
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                  border: `1px solid ${canvasFont.size === k ? COLOR.text : COLOR.borderLt}`,
                  background: canvasFont.size === k ? COLOR.text : 'transparent',
                  color: canvasFont.size === k ? COLOR.bg : COLOR.text2,
                }}
              >{label}</button>
            ))}
          </div>
        </div>

        <SystemTab project={project} deckSpec={deckSpec} projectId={projectId} />

        {/* 项目档案 折叠 — 默认收起（agent 内部知识，用户偶尔翻） */}
        <div style={{
          borderTop: `1px solid ${COLOR.borderLt}`,
          padding: `${GAP.md}px ${GAP.lg}px 0`,
        }}>
          <button
            onClick={() => setArchiveOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: GAP.xs,
              width: '100%', padding: `${GAP.xs}px 0`,
              background: 'transparent', border: 'none',
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.sub, textTransform: 'uppercase', letterSpacing: '0.05em',
              cursor: 'pointer',
            }}
          >
            <ChevronRight
              size={11}
              style={{
                transform: archiveOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.12s ease',
              }}
            />
            项目档案 — Decisions / History
          </button>
          {!archiveOpen && (
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
              padding: `${GAP.xs}px 0 ${GAP.md}px ${GAP.lg}px`,
              lineHeight: 1.5,
            }}>
              展开看 agent 记录的设计决策 + compact 摘要历史。
            </div>
          )}
        </div>

        {archiveOpen && (
          <div style={{
            background: 'rgba(0,0,0,0.015)',
            margin: `0 ${GAP.lg}px ${GAP.md}px`,
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: RADIUS.md,
          }}>
            <DecisionsTab
              projectId={projectId}
              sessionId={sessionId}
              reloadKey={decisionsReloadKey}
            />
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div style={{
        padding: `${GAP.sm}px ${GAP.lg}px`,
        background: COLOR.bgCard,
        borderTop: `1px solid ${COLOR.borderLt}`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.5,
        flexShrink: 0,
      }}>
        spec 不可在此编辑 — 改 spec 跟 agent 说，触发新 run。
      </div>
    </div>
  );
}

/** 极简 toggle（原来长在 CanvasToolbar 里，那条工具栏 2026-08-07 退役了） */
function ToggleSwitch({ checked, onChange, title }) {
  return (
    <button
      onClick={() => onChange?.(!checked)}
      title={title}
      style={{
        width: 28, height: 16, padding: 0, border: 'none',
        borderRadius: RADIUS.lg,
        background: checked ? COLOR.text : 'rgba(0,0,0,0.18)',
        position: 'relative', cursor: 'pointer',
        transition: 'background 0.15s', flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 14 : 2,
        width: 12, height: 12, borderRadius: RADIUS.round,
        background: COLOR.bgWhite, boxShadow: SHADOW.crispSm,
        transition: 'left 0.15s',
      }} />
    </button>
  );
}

const popoverToolBtn = {
  padding: `${GAP.xs + 1}px ${GAP.md}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text4,
  background: 'rgba(0,0,0,0.04)',
  border: 'none',
  borderRadius: RADIUS.sm,
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  cursor: 'pointer',
};
