import { useMemo, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import Message from './Message.jsx';
import TimelineGroup from './TimelineGroup.jsx';
import { History } from 'lucide-react';
import { COLOR, GAP, FONT_SANS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * groupMessages —— thinking + tool 进 timeline group；中间穿插的 assistant
 * 也进 group（让 timeline 跨 narration 不断）；末尾连续的 assistant 剥出来
 * 作 single（"真正的最终回复"——后面没工具调用了，让用户看到独立大字号）。
 *
 * 演进史：
 *   - H5：thinking+tool+assistant 全进 group + 末尾抽 final text
 *   - V2：assistant 全 break
 *   - V3：启发式 isShortNarration 当过场不 break（被 V4 撤）
 *   - V4：assistant 全 break，每段工作收尾出 DONE
 *   - V5：assistant 全进 group → 用户反 push："最终回复也被塞 timeline 里了"
 *   - V6（本次）：assistant 进 group 但 closed group 末尾的连续 assistant
 *     被剥出 → 中间穿插的窄 narration 进 timeline 不断线，末尾大段 final
 *     reply 出来正常 markdown 大字号显示。
 *
 * group 的 closed 信号：
 *   - 后面接 user / system → closed=true（新一轮 turn 起点 / 系统拦截独立）
 *   - 最后一个 group + !isStreaming → closed=true
 *   - 最后一个 group + isStreaming → closed=false（不剥尾，因为可能还有 tool 在路上）
 */
function groupMessages(messages, isStreaming) {
  const raw = [];
  let current = null;
  for (const m of messages) {
    const isTimeline = m.role === 'thinking' || m.role === 'tool' || m.role === 'assistant';
    if (isTimeline) {
      if (!current) {
        current = { type: 'timeline', items: [], closed: false };
        raw.push(current);
      }
      current.items.push(m);
    } else {
      // user / system break group
      if (current) { current.closed = true; current = null; }
      raw.push({ type: 'single', message: m });
    }
  }

  if (current && !isStreaming) {
    current.closed = true;
  }

  // Post-pass：closed timeline group 末尾连续的 assistant 剥成 single
  // （"final reply" 不进 timeline）。!closed group 不剥，避免 streaming 中
  // 当前 assistant 假装是 final 但其实下一帧又有 tool 来。
  const groups = [];
  for (const g of raw) {
    if (g.type !== 'timeline' || !g.closed) {
      groups.push(g);
      continue;
    }
    let lastNonAssistant = g.items.length - 1;
    while (lastNonAssistant >= 0 && g.items[lastNonAssistant].role === 'assistant') {
      lastNonAssistant--;
    }
    const inGroup = g.items.slice(0, lastNonAssistant + 1);
    const tail = g.items.slice(lastNonAssistant + 1);
    if (inGroup.length > 0) {
      groups.push({ type: 'timeline', items: inGroup, closed: true });
    }
    for (const m of tail) {
      groups.push({ type: 'single', message: m });
    }
  }
  return groups;
}

/**
 * 消息流容器 — Virtuoso 虚拟滚动（>2MB jsonl 几千条 message 必备）。
 *
 * 设计：
 *   - data={groups}：每个虚拟 item 是一个 group（timeline 或 single）
 *   - computeItemKey 用 group 内首条 message.id：streaming 末尾 group items 数组
 *     变化但 key 不变 → Virtuoso 复用同一 DOM + TimelineGroup memo 内部决定要不要 rerender
 *   - followOutput='auto'：用户在底部自动跟随；离底则不强行拽回（替代旧 stickToBottom 逻辑）
 *   - atBottomThreshold=80：跟旧 STICK_THRESHOLD 一致
 *   - initialTopMostItemIndex 让 hydrate 后首屏直接定位到末尾，跟旧的"useEffect scrollTop=scrollHeight"等价
 */
function groupKey(_index, g) {
  if (!g) return `idx-${_index}`;
  if (g.type === 'timeline') {
    const first = g.items[0];
    // closed flag 进 key 让 timeline group 关闭/打开时强制重 mount
    // （保留 TimelineGroup 内部的 open state；不希望复用旧 DOM 的 open=true 状态）
    return `tl-${first?.id || _index}-${g.closed ? 'c' : 'o'}`;
  }
  return `m-${g.message?.id || _index}`;
}

export default function MessageList({
  messages = [],
  isStreaming = false,
  projectId,
  sessionId,
  onCanvasReload,
  onOpenSessionList,
}) {
  const virtuosoRef = useRef(null);
  const groups = useMemo(() => groupMessages(messages, isStreaming), [messages, isStreaming]);

  // 空态：没有 message 时不渲染 Virtuoso（避免 height 0 时它的内部测量警告）
  if (messages.length === 0) {
    return <EmptyState onOpenSessionList={onOpenSessionList} />;
  }

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={groups}
      computeItemKey={groupKey}
      followOutput="auto"
      atBottomThreshold={80}
      initialTopMostItemIndex={Math.max(0, groups.length - 1)}
      style={{ flex: 1, minHeight: 0, padding: `${GAP.lg}px 0` }}
      itemContent={(_index, g) => g.type === 'timeline'
        ? <TimelineGroup messages={g.items} closed={g.closed} projectId={projectId} sessionId={sessionId} onCanvasReload={onCanvasReload} />
        : <Message message={g.message} projectId={projectId} sessionId={sessionId} onCanvasReload={onCanvasReload} />}
    />
  );
}


// ── 空态（2026-07-28）：新对话时左栏不再只有一行提示 ──
//
// 三件事讲清楚：怎么开头（可点的起手式，点了填进输入框）、agent 在这儿能干什么、
// 之前的对话去哪找。文案克制，不做成说明书。
const STARTERS = [
  '做一份产品介绍演示文稿，给投资人看',
  '把这组图排成一张竖版海报',
  '梳理一下项目的视觉风格，写进品牌档案',
];

function EmptyState({ onOpenSessionList }) {
  const setChatDraft = useGlobalStore(s => s.setChatDraft);
  return (
    <div style={{
      flex: 1, minHeight: 0, overflow: 'auto',
      padding: `${GAP.xxl}px ${GAP.lg}px`,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: GAP.lg,
      fontFamily: FONT_SANS, color: COLOR.sub, textAlign: 'center',
    }}>
      <div style={{ fontSize: FONT_SIZE.sm, lineHeight: 1.7 }}>
        输入 brief 开始<br />
        描述你想做什么、给谁看、传达什么。
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 300 }}>
        {STARTERS.map((t) => (
          <button
            key={t}
            onClick={() => setChatDraft(t)}
            title="填进输入框，可以改了再发"
            style={{
              textAlign: 'left',
              padding: `${GAP.sm}px ${GAP.md}px`,
              border: `1px solid ${COLOR.borderLt}`,
              borderRadius: 8,
              background: '#fff',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
              cursor: 'pointer', lineHeight: 1.5,
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.03)'; e.currentTarget.style.borderColor = COLOR.borderHv; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = COLOR.borderLt; }}
          >{t}</button>
        ))}
      </div>

      <div style={{
        maxWidth: 300, fontSize: 11, lineHeight: 1.7, color: COLOR.sub,
        borderTop: `1px solid ${COLOR.borderLt}`, paddingTop: GAP.md,
      }}>
        agent 会在项目里建一个任务文件夹放产出，写的每一步都在右边画布上实时演。
        它能生成图片、联网查资料、自己截图检查排版、按元素微调。
      </div>

      {onOpenSessionList && (
        <button
          onClick={onOpenSessionList}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: `${GAP.xs}px ${GAP.md}px`,
            border: 'none', background: 'transparent',
            fontFamily: FONT_MONO, fontSize: 11, color: COLOR.text2,
            cursor: 'pointer', borderRadius: 6,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <History size={12} /> 之前的对话都在这
        </button>
      )}
    </div>
  );
}
