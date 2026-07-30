import { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, Bot, Wrench, Check, EyeOff, Trash2, RotateCcw } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { Admin } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { timeAgo } from '../lib/helpers.js';

/**
 * Issues — harness 问题库（/admin/issues，admin 才有意义，后端 adminGuard 兜底）
 *
 * 两个来源写同一张表：
 *   auto  PostToolUseFailure 自动记的工具失败 —— 不依赖 agent 自觉，
 *         抓得到"某工具这周失败 40 次但从没人提"
 *   agent report_friction 主动报的摩擦 —— 补"为什么难受、期望怎样"，
 *         这是自动层拿不到、但真正指向修法的那半句
 *
 * 默认按次数降序：一眼看到最该修的那个。
 */
const SOURCE_META = {
  auto: { label: '自动', icon: Wrench, color: COLOR.sub },
  agent: { label: 'agent 上报', icon: Bot, color: COLOR.brown },
};

export default function Issues() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('open');
  const [source, setSource] = useState('all');
  const showToast = useGlobalStore(s => s.showToast);

  const load = () => {
    Admin.issues({ status: status === 'all' ? undefined : status, source: source === 'all' ? undefined : source })
      .then(setData)
      .catch(err => { showToast(`拉取失败：${err.message}`, 'error'); setData({ issues: [], stats: [] }); });
  };
  useEffect(load, [status, source]);   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (id, next) => {
    try {
      if (next === 'delete') await Admin.removeIssue(id);
      else await Admin.setIssueStatus(id, next);
      load();
    } catch (err) {
      showToast(`操作失败：${err.message}`, 'error');
    }
  };

  const topTools = useMemo(() => (data?.stats || []).slice(0, 6), [data]);

  return (
    <AppShell breadcrumb={[{ label: 'Harness 问题库' }]}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>
        <header style={{ marginBottom: GAP.xl }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginBottom: GAP.sm }}>
            <AlertTriangle size={18} color={COLOR.warn} />
            <h1 style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
              color: COLOR.text, letterSpacing: '-0.01em', margin: 0,
            }}>Harness 问题库</h1>
          </div>
          <p style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
            lineHeight: 1.65, margin: 0, maxWidth: 680,
          }}>
            工具失败自动进这里（不依赖 agent 说），agent 也能主动报绕路和期望。
            同类累加计数，按次数排序——排在前面的是最值得修的。
          </p>
        </header>

        {topTools.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.sm, marginBottom: GAP.xl }}>
            {topTools.map((s, i) => (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2,
                padding: `${GAP.xs}px ${GAP.md}px`,
                background: 'rgba(0,0,0,0.035)', borderRadius: 100,
              }}>
                {shortTool(s.toolName)}
                <b style={{ color: COLOR.text }}>{s.total}</b>
                <span style={{ color: COLOR.sub }}>/ {s.kinds} 类</span>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: GAP.lg, marginBottom: GAP.lg, flexWrap: 'wrap' }}>
          <Segmented value={status} onChange={setStatus} options={[
            ['open', '待处理'], ['ack', '已知'], ['ignored', '忽略'], ['closed', '已修'], ['all', '全部'],
          ]} />
          <Segmented value={source} onChange={setSource} options={[
            ['all', '全部来源'], ['auto', '自动'], ['agent', 'agent 上报'],
          ]} />
        </div>

        {!data ? (
          <div style={emptyStyle}>加载中…</div>
        ) : data.issues.length === 0 ? (
          <div style={emptyStyle}>这个筛选下没有记录。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
            {data.issues.map(issue => (
              <IssueRow key={issue.id} issue={issue} onAct={act} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function shortTool(name) {
  if (!name) return '（无工具）';
  return name.replace(/^mcp__nodesign__/, '');
}

function IssueRow({ issue, onAct }) {
  const [open, setOpen] = useState(false);
  const meta = SOURCE_META[issue.source] || SOURCE_META.auto;
  const Icon = meta.icon;
  const hot = issue.count >= 5;

  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${COLOR.border}`,
      borderLeft: `3px solid ${hot ? COLOR.warn : COLOR.border}`,
      borderRadius: 10,
      padding: `${GAP.md}px ${GAP.lg}px`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: GAP.md }}>
        <Icon size={13} color={meta.color} style={{ flexShrink: 0, marginTop: 3 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <button
            onClick={() => setOpen(v => !v)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text, lineHeight: 1.5,
            }}
          >{issue.summary}</button>

          <div style={{
            display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap',
            marginTop: 4, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }}>
            <span style={{ color: hot ? COLOR.warn : COLOR.text2, fontWeight: 600 }}>×{issue.count}</span>
            <span>{shortTool(issue.toolName)}</span>
            <span>{meta.label}</span>
            <span>最近 {timeAgo(issue.lastSeen)}</span>
            {issue.status !== 'open' && <span style={{ color: COLOR.dim }}>[{issue.status}]</span>}
          </div>

          {open && (
            <div style={{
              marginTop: GAP.md,
              padding: `${GAP.md}px ${GAP.lg}px`,
              background: 'rgba(0,0,0,0.025)', borderRadius: 8,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2,
              lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {issue.detail || '（无详情）'}
              {issue.expectation && (
                <div style={{ marginTop: GAP.md, paddingTop: GAP.md, borderTop: `1px solid ${COLOR.borderLt}` }}>
                  <b style={{ color: COLOR.text3 }}>期望：</b>{issue.expectation}
                </div>
              )}
              <div style={{ marginTop: GAP.md, color: COLOR.dim }}>
                首次 {issue.firstSeen} · {issue.projectId || '无项目'} · {issue.sessionId || '无会话'}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          {issue.status !== 'closed'
            ? <IconBtn title="标记已修" onClick={() => onAct(issue.id, 'closed')}><Check size={13} /></IconBtn>
            : <IconBtn title="重新打开" onClick={() => onAct(issue.id, 'open')}><RotateCcw size={13} /></IconBtn>}
          {issue.status !== 'ignored' && (
            <IconBtn title="忽略（噪音）" onClick={() => onAct(issue.id, 'ignored')}><EyeOff size={13} /></IconBtn>
          )}
          <IconBtn title="删除" onClick={() => onAct(issue.id, 'delete')} danger><Trash2 size={13} /></IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ children, title, onClick, danger }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 26, height: 26, borderRadius: 6,
        background: 'transparent', border: 0, cursor: 'pointer',
        color: danger ? COLOR.error : COLOR.sub,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >{children}</button>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'rgba(0,0,0,0.04)', borderRadius: 8 }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            padding: `${GAP.xs}px ${GAP.md}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
            color: value === v ? COLOR.text : COLOR.sub,
            background: value === v ? '#fff' : 'transparent',
            border: 0, borderRadius: 6, cursor: 'pointer',
            boxShadow: value === v ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
          }}
        >{label}</button>
      ))}
    </div>
  );
}

const emptyStyle = {
  padding: `${GAP.page}px ${GAP.xl}px`,
  textAlign: 'center',
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
};
