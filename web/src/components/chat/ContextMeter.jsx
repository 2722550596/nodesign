import { useState, useRef, useEffect } from 'react';
import { Cpu, Wrench, Plug, Users, Box, BookOpen, FoldVertical } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * ContextMeter —— 上下文用量指示（composer 上沿）
 *
 * 取代原来顶栏的 ContextUsageBar。两处改动是有理由的，不只是搬家：
 *
 * **归属**：上下文用量是「这次对话」的属性，不是项目的属性。挂在项目级顶栏上，
 * 切会话时它突变而周围什么都没变，读起来错位。放在 composer 上沿，跟对话同生死，
 * 而且用户打字时视线本来就在这。
 *
 * **静息态是零像素**：60% 以下什么都不画。常驻的仪表本身就是要治的病，一条淡线
 * 也还是仪表。有 autoCompact 兜底，这个区间的信息行动价值为零。
 *   < 60%    无
 *   60-85%   一条 hairline，可点开详情
 *   ≥ 85%    hairline + 「87% · 压缩」，压缩入口长在指示条上，不另占一个按钮
 *
 * 数字（39.1k/1000k）、model、tools/mcp/agents/plugins/skills 计数全进 popover。
 * 那五个计数是 run.system_init 给的会话常量，整场不变，不值得常驻像素。
 *
 * 2026-07-30：明细块拆成 `ContextDetail` 导出，composer 的 [+] 菜单复用同一份 ——
 * 那里是「随时想看」的入口（不受 60% 门槛约束），这里是「到点了提醒你」的入口。
 * 两处显示同一组数字，只能有一份格式化逻辑。
 */
export const SHOW_FROM = 60;
export const URGENT_FROM = 85;

/** 用量 → 颜色：安静 / 提醒 / 紧迫。指示条和 [+] 菜单里的进度条共用 */
export function usageColor(pct) {
  if (pct >= URGENT_FROM) return COLOR.error;
  if (pct >= SHOW_FROM) return COLOR.warn;
  return COLOR.text4;
}

export default function ContextMeter({ usage, info, onCompact, isStreaming }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const pct = clamp(usage?.percentage || 0, 0, 100);
  if (!usage || pct < SHOW_FROM) return null;

  const urgent = pct >= URGENT_FROM;
  const color = usageColor(pct);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      {/* hairline：宽度即用量，颜色即紧迫度 */}
      <button
        onClick={() => setOpen(v => !v)}
        title="上下文用量（点开看明细）"
        style={{
          display: 'block', width: '100%', height: 2,
          padding: 0, border: 0, borderRadius: 0,
          background: 'rgba(0,0,0,0.06)',
          cursor: 'pointer',
          position: 'relative',
        }}
      >
        <span style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct}%`, background: color,
          transition: 'width 0.3s ease, background 0.2s',
        }} />
      </button>

      {urgent && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: GAP.sm,
          padding: `2px ${GAP.lg}px 0`,
        }}>
          <button
            onClick={() => setOpen(v => !v)}
            style={{
              fontFamily: FONT_MONO, fontSize: 10, color,
              background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
            }}
          >{pct.toFixed(0)}%</button>
          {onCompact && !isStreaming && (
            <button
              onClick={onCompact}
              title="把历史换成摘要，给这次对话腾出空间"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                fontFamily: FONT_SANS, fontSize: 10, color: COLOR.text2,
                background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
              }}
            ><FoldVertical size={11} strokeWidth={1.75} /> 压缩</button>
          )}
        </div>
      )}

      {open && <DetailPopover usage={usage} info={info} pct={pct} />}
    </div>
  );
}

function DetailPopover({ usage, info, pct }) {
  return (
    <div style={{
      position: 'absolute', bottom: '100%', left: GAP.lg, right: GAP.lg,
      marginBottom: 6,
      background: '#fff',
      border: `1px solid ${COLOR.borderMd}`,
      borderRadius: 10,
      boxShadow: '0 12px 32px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
      padding: `${GAP.md}px ${GAP.lg}px`,
      zIndex: 40,
      maxHeight: 320, overflow: 'auto',
    }}>
      <ContextDetail usage={usage} info={info} pct={pct} />
    </div>
  );
}

/**
 * 明细本体（无浮层外壳）——指示条 popover 和 composer [+] 菜单都渲染它。
 * @param {object} props.usage  run.context_usage 事件体
 * @param {object} props.info   run.system_init 会话常量
 */
export function ContextDetail({ usage, info, pct }) {
  const b = usage.messageBreakdown;
  const topTools = b?.toolCallsByType?.slice(0, 3) || [];
  const chips = infoChips(info);

  return (
    <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2 }}>
      <Row k="已用" v={`${formatK(usage.totalTokens)} / ${formatK(usage.maxTokens)} · ${pct.toFixed(1)}%`} strong />
      {/* 模型：system_init 还没到时（刷新后、turn 之间）就用 usage 自带的。这是
          「这段上下文实际跑在谁身上」，跟 composer 里那个"下条消息用谁"的 picker
          不是一回事 —— 会话中途换过模型时两者就会不一样，看得见才不会犯迷糊 */}
      {!info?.model && usage.model && <Row k="模型" v={String(usage.model)} />}
      {usage.autoCompactThreshold && (
        <Row k="自动压缩线" v={`${formatK(usage.autoCompactThreshold)}${usage.isAutoCompactEnabled ? '' : '（关）'}`} />
      )}
      {b && (
        <>
          <Divider />
          <Row k="agent 输出" v={formatK(b.assistantMessageTokens)} />
          <Row k="你的消息" v={formatK(b.userMessageTokens)} />
          <Row k="工具" v={`调用 ${formatK(b.toolCallTokens)} / 结果 ${formatK(b.toolResultTokens)}`} />
          {b.attachmentTokens ? <Row k="附件" v={formatK(b.attachmentTokens)} /> : null}
        </>
      )}
      {topTools.length > 0 && (
        <>
          <Divider />
          {topTools.map(t => (
            <Row key={t.name} k={String(t.name).replace(/^mcp__nodesign__/, '')}
              v={formatK((t.callTokens || 0) + (t.resultTokens || 0))} />
          ))}
        </>
      )}
      {chips.length > 0 && (
        <>
          <Divider />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.sm, marginTop: 2 }}>
            {chips.map((c, i) => (
              <span key={i} title={c.title} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                color: COLOR.sub, cursor: 'help',
              }}>
                <c.icon size={10} strokeWidth={1.5} />{c.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v, strong }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: GAP.lg,
      lineHeight: 1.9,
      color: strong ? COLOR.text : COLOR.text2,
      fontWeight: strong ? 500 : 400,
    }}>
      <span style={{ color: COLOR.sub }}>{k}</span>
      <span>{v}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.sm}px 0` }} />;
}

/** 会话常量：model + 五个计数。整场不变，所以只配活在 popover 里 */
function infoChips(info) {
  if (!info) return [];
  const out = [];
  const push = (icon, label, title) => out.push({ icon, label, title });
  if (info.model) push(Cpu, String(info.model), `模型：${info.model}`);
  if (Array.isArray(info.tools)) push(Wrench, `${info.tools.length} 工具`, info.tools.join(', '));
  if (Array.isArray(info.mcpServers) && info.mcpServers.length) {
    const names = info.mcpServers.map(s => s.name || s).filter(Boolean);
    push(Plug, `${names.length} mcp`, names.join(', '));
  }
  if (Array.isArray(info.agents) && info.agents.length) {
    push(Users, `${info.agents.length} 子代理`, info.agents.join(', '));
  }
  if (Array.isArray(info.plugins) && info.plugins.length) {
    const names = info.plugins.map(p => (typeof p === 'string' ? p : (p.name || p.id))).filter(Boolean);
    push(Box, `${names.length} plugin`, names.join(', '));
  }
  if (Array.isArray(info.skills) && info.skills.length) {
    const names = info.skills.map(s => (typeof s === 'string' ? s : (s.name || s.id))).filter(Boolean);
    push(BookOpen, `${names.length} skill`, names.join(', '));
  }
  return out;
}

export function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function formatK(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;   // 3,000,000 显示成 3000.0k 是事故现场
}
