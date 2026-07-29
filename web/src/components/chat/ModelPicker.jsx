import { useState, useRef, useEffect } from 'react';
import { Cpu, Check } from 'lucide-react';
import { COLOR, GAP, FONT_SANS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * 模型选择 —— Composer 工具栏里的小 picker（2026-07-29）。
 *
 * 语义：选择存 localStorage（globalStore.modelPref），随每条消息的 body.model
 * 下发；服务端写进 session-config.json 并在会话空闲时重启 query 生效。
 * 也就是说它是"从下一条消息起用哪个模型"，对当前正在跑的 turn 无效 ——
 * 所以 isRunning 时禁用，别给用户"点了就切"的错觉。
 *
 * null = 跟随服务端默认（NODESIGN_MODEL，当前 sonnet-5 1M）。
 */
const OPTIONS = [
  {
    id: null,
    label: 'Sonnet',
    desc: '默认 · 快，日常改稿和铺页够用',
  },
  {
    id: 'claude-opus-5[1m]',
    label: 'Opus 5',
    desc: '前端与审美更强 · 烧订阅额度快得多，重活再开',
  },
];

export default function ModelPicker({ disabled = false }) {
  const modelPref = useGlobalStore(s => s.modelPref);
  const setModelPref = useGlobalStore(s => s.setModelPref);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const current = OPTIONS.find(o => o.id === modelPref) || OPTIONS[0];
  const isDefault = current.id === null;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => !disabled && setOpen(v => !v)}
        disabled={disabled}
        title={disabled
          ? '这一轮跑完再切（切换从下一条消息生效）'
          : `当前模型：${current.label}。切换从下一条消息生效，对话不丢`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: `4px ${GAP.sm}px`,
          fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
          color: isDefault ? COLOR.text2 : COLOR.btnText,
          background: isDefault ? 'transparent' : COLOR.btn,
          border: `1px solid ${isDefault ? COLOR.borderMd : COLOR.btn}`,
          borderRadius: 6,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'all 0.15s',
        }}
      >
        <Cpu size={11} />
        {current.label}
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0,
          minWidth: 230,
          background: '#fff',
          border: `1px solid ${COLOR.borderMd}`,
          borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
          padding: 4,
          zIndex: 60,
        }}>
          {OPTIONS.map((o) => {
            const active = o.id === current.id;
            return (
              <button
                key={o.id ?? 'default'}
                onClick={() => { setModelPref(o.id); setOpen(false); }}
                style={{
                  width: '100%',
                  display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
                  padding: `${GAP.sm}px ${GAP.md}px`,
                  background: 'transparent', border: 'none', borderRadius: 4,
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ width: 13, flexShrink: 0, marginTop: 2 }}>
                  {active && <Check size={12} color={COLOR.text} />}
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>
                    {o.label}
                  </span>
                  <span style={{ display: 'block', fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, marginTop: 1 }}>
                    {o.desc}
                  </span>
                </span>
              </button>
            );
          })}
          <div style={{
            padding: `4px ${GAP.md}px ${GAP.xs}px`, borderTop: `1px solid ${COLOR.borderLt}`,
            marginTop: 2, fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub,
          }}>
            从下一条消息生效，对话与画布不丢
          </div>
        </div>
      )}
    </div>
  );
}
