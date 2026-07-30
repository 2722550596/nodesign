import { useState, useRef, useEffect } from 'react';
import { Plus, Paperclip, FoldVertical } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { ContextDetail, usageColor, formatK, clamp } from './ContextMeter.jsx';
import { Me } from '../../lib/api.js';

/**
 * ComposerMenu —— composer 左下角的 [+] 展开菜单（2026-07-30）
 *
 * 起因：上下文用量的指示条只在 60% 以上现身，那是「到点了提醒你」；用户还需要一个
 * 「我现在就想看」的入口，以及一个不依赖用量门槛的手动压缩按钮。仿 Claude Code 的
 * 命令展开菜单：平时一个 [+]，点开才有内容。
 *
 * 收进来的东西按「我要给这次对话添点什么 / 这次对话现在什么状况」两类分组：
 *   添加   → 上传附件（原来是工具栏上一个裸的回形针）
 *   上下文 → 进度条 + 明细（复用 ContextMeter 的 ContextDetail）+ 压缩对话
 *
 * 没收进来的：模型 picker 留在工具栏可见。它是「发出去之前要确认的东西」，
 * 跟发送按钮同一条决策链上，藏一层等于每次都要多点一下才敢发。
 */
export default function ComposerMenu({
  onUpload,
  usage = null,
  info = null,
  onCompact,
  onRefreshUsage,
  isStreaming = false,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // 展开即重问一次：turn 之间服务端不推 run.context_usage，手里的数字可能是上一轮
  // 结束时的。菜单是"我现在就想知道"的入口，不能给隔夜数据。
  useEffect(() => { if (open) onRefreshUsage?.(); }, [open, onRefreshUsage]);

  // 账号今日用量。顶栏头像也有（近限额时描边变色 = 常驻的那一个比特），这里是
  // 数字本身 —— 跟"这次对话装了多少"放在一起才好判断"还能不能再开一轮大的"。
  const [account, setAccount] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    Me.usage().then((u) => { if (alive) setAccount(u); }).catch(() => { /* fail-soft：不显示这一段 */ });
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const pct = usage ? clamp(usage.percentage || 0, 0, 100) : 0;

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => !disabled && setOpen(v => !v)}
        disabled={disabled}
        title="附件 / 上下文 / 压缩"
        style={{
          width: 28, height: 28,
          borderRadius: 6,
          color: open ? COLOR.text2 : COLOR.text4,
          background: open ? 'rgba(0,0,0,0.05)' : 'transparent',
          border: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 0.15s, color 0.15s, transform 0.15s',
          transform: open ? 'rotate(45deg)' : 'none',
        }}
        onMouseEnter={e => { if (!disabled) { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = COLOR.text2; } }}
        onMouseLeave={e => { if (!open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = COLOR.text4; } }}
      >
        <Plus size={15} strokeWidth={1.75} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0,
          width: 292,
          background: '#fff',
          border: `1px solid ${COLOR.borderMd}`,
          borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
          padding: 4,
          zIndex: 40,
          // 三段全展开（上下文明细 + 工具排行 + 账号）大约 480；给到 70vh 让它
          // 在常见窗口高度下一次看完，再高才滚
          maxHeight: 'min(70vh, 560px)', overflow: 'auto',
        }}>
          <SectionLabel>添加</SectionLabel>
          <MenuItem
            icon={<Paperclip size={13} strokeWidth={1.75} />}
            label="上传附件"
            hint="图片 / PDF / HTML"
            onClick={() => { setOpen(false); onUpload?.(); }}
          />

          <Divider />
          <SectionLabel>上下文</SectionLabel>

          {usage ? (
            <div style={{ padding: `2px ${GAP.md}px ${GAP.sm}px` }}>
              {/* 进度条：菜单里不设门槛，任何用量都画。颜色仍按三档，一眼分辨要不要动手 */}
              <div style={{
                height: 4, borderRadius: 2, overflow: 'hidden',
                background: 'rgba(0,0,0,0.06)', marginBottom: 6,
              }}>
                <div style={{
                  width: `${pct}%`, height: '100%',
                  background: usageColor(pct),
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <ContextDetail usage={usage} info={info} pct={pct} />
              {usage.live === false && (
                <div style={{
                  marginTop: 4,
                  fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
                }}>
                  当前没有活跃会话 · 这是最后一轮的数字
                </div>
              )}
            </div>
          ) : (
            <div style={{
              padding: `${GAP.xs}px ${GAP.md}px ${GAP.sm}px`,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            }}>
              还没开始对话 · 发一条消息后这里会有数字
            </div>
          )}

          {onCompact && (
            <MenuItem
              icon={<FoldVertical size={13} strokeWidth={1.75} />}
              label="压缩对话"
              hint={isStreaming ? 'agent 跑完再压缩' : (usage ? '把历史换成摘要，腾出空间' : '对话开始后可用')}
              disabled={isStreaming || !usage}
              onClick={() => { setOpen(false); onCompact(); }}
            />
          )}

          {account && (
            <>
              <Divider />
              <SectionLabel>账号</SectionLabel>
              <AccountUsage account={account} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 今日用量 / 日限额。
 *
 * 限额是每天按 Asia/Shanghai 日界重置的 input+output tokens 总量；admin 无限额，
 * 那种情况只报数字，不画一条永远填不满的条。
 */
function AccountUsage({ account }) {
  const { usedToday = 0, limit = null, username, role } = account;
  const capped = typeof limit === 'number' && limit > 0;
  const pct = capped ? clamp((usedToday / limit) * 100, 0, 100) : 0;
  // 80% 起变色：跟顶栏头像那圈描边同一条线，两处对同一件事的判断不能不一样
  const color = pct >= 100 ? COLOR.error : pct >= 80 ? COLOR.warn : COLOR.text4;

  return (
    <div style={{ padding: `2px ${GAP.md}px ${GAP.sm}px` }}>
      {capped && (
        <div style={{
          height: 4, borderRadius: 2, overflow: 'hidden',
          background: 'rgba(0,0,0,0.06)', marginBottom: 6,
        }}>
          <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s ease' }} />
        </div>
      )}
      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: GAP.lg,
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, lineHeight: 1.9,
        color: capped && pct >= 80 ? color : COLOR.text2,
      }}>
        <span style={{ color: COLOR.sub }}>今日</span>
        <span>{formatK(usedToday)}{capped ? ` / ${formatK(limit)} · ${pct.toFixed(0)}%` : ' · 不限额'}</span>
      </div>
      {username && (
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
          {username}{role === 'admin' && username !== 'admin' ? ' · admin' : ''}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      padding: `${GAP.xs}px ${GAP.md}px 2px`,
      fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.06em',
      color: COLOR.sub,
    }}>{children}</div>
  );
}

function MenuItem({ icon, label, hint, onClick, disabled = false }) {
  return (
    <button
      onClick={() => { if (!disabled) onClick?.(); }}
      disabled={disabled}
      title={hint}
      style={{
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        width: '100%',
        padding: `${GAP.sm}px ${GAP.md}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: disabled ? COLOR.text4 : COLOR.text,
        background: 'transparent', border: 0, borderRadius: 6,
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ color: disabled ? COLOR.text4 : COLOR.text2, display: 'flex', flexShrink: 0 }}>{icon}</span>
      <span style={{ flexShrink: 0 }}>{label}</span>
      {hint && (
        <span style={{
          marginLeft: 'auto',
          fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{hint}</span>
      )}
    </button>
  );
}

function Divider() {
  return <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px 0` }} />;
}
