import { useState, memo } from 'react';
import { ChevronDown, CheckCircle2 } from 'lucide-react';
import Message from './Message.jsx';
import TimelineNode from './TimelineNode.jsx';
import { TimelinePositionProvider } from './TimelineGroupContext.js';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { toolLabelOf, fileNameOf } from '../../lib/stage.js';

/**
 * TimelineGroup —— 把连续的 thinking + tool 节点包成一个可折叠的"思考片段"
 *
 * 设计意图（参考用户图）：
 *   - 顶部 collapsible 标题栏：从第一段 thinking 自动提取一句话作 summary
 *     （像 Claude Code native UI "Architecting data structure..." 风格）
 *     props.summary 仍可显式传入覆盖
 *   - 中部：连续的 thinking / tool TimelineNode，竖线自动连成时间轴
 *   - 底部（仅 closed=true 时）：CheckCircle2 + "DONE" 节点，标记该思考片段
 *     收尾，准备开始正式 assistant 回复
 *
 * closed 由 MessageList groupMessages 计算：group 后面出现非 thinking/tool
 * 消息（即 assistant 正式回复 / system / user）→ closed=true。run 还在进行
 * 中且 group 是最后一组 → closed=false（Done 不显示，避免误导）。
 */
const SUMMARY_MAX = 60;

/**
 * 给"思考片段"起个标题。
 *
 * 老做法是把 thinking 头 60 个字符硬切下来当标题，结果长这样：
 *   "I'm setting up a straightforward image generation te…"
 * 英文原文、从句子中间断开、还全是"I'm going to…"这种没信息量的开场白。
 *
 * 现在按人读得懂的顺序来（全部本地算，不调 LLM）：
 *   ① 这段里真动了什么 —— 有工具就用工具说话（"改 canvas.html · 截图"），
 *      这是用户真正关心的，也天然是中文
 *   ② 没工具就退回 thinking 的**第一句**，先剥掉开场白，再按词边界截
 */
const OPENERS = [
  /^(?:okay|ok|alright|so|now|first|let me|let's|i'?m going to|i'?ll|i need to|i should|i want to|i will|we need to|we should)\b[,:]?\s*/i,
  /^(?:好的?|那么|现在|首先|接下来|我需要|我要|我先|我来|我应该|让我|我们需要)[，,、：:]?\s*/,
  /^the user (?:is )?(?:asking|wants|said|needs)\b[,:]?\s*/i,
  /^用户(?:在)?(?:问|想要|说|需要)[，,：:]?\s*/,
];

function stripOpener(s) {
  let out = s;
  for (const re of OPENERS) {
    const next = out.replace(re, '');
    if (next !== out) { out = next; break; }
  }
  return out.trim();
}

/** 按词边界截断（中文没有空格，直接切；英文回退到最后一个空格）*/
function clip(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const sp = head.lastIndexOf(' ');
  return (sp > max * 0.6 ? head.slice(0, sp) : head).trimEnd() + '…';
}

/** 这段思考里真动过的工具 → "改 canvas.html · 截图" */
function summaryFromTools(messages) {
  const parts = [];
  for (const m of messages) {
    if (m.role !== 'tool' || !m.toolName) continue;
    const label = toolLabelOf(m.toolName);
    const file = m.toolInput?.file_path ? fileNameOf(m.toolInput.file_path) : null;
    const one = file ? `${label} ${file}` : label;
    if (!parts.includes(one)) parts.push(one);
    if (parts.length >= 3) break;
  }
  return parts.length ? clip(parts.join(' · '), SUMMARY_MAX) : null;
}

function summaryFromThinking(messages) {
  const firstThinking = messages.find(m => m.role === 'thinking' && m.content);
  if (!firstThinking) return null;
  const text = String(firstThinking.content).trim().split(/\n{2,}/)[0].replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // 第一句：中英标点都算句号
  const sentence = (text.match(/^[\s\S]*?(?:[。！？!?]|\.\s|$)/) || [text])[0]
    .replace(/[。！？!?.]\s*$/, '')
    .trim();
  const body = stripOpener(sentence || text);
  if (!body) return null;
  return clip(body, SUMMARY_MAX);
}

function extractSummary(messages) {
  // SDK helper 写的那句 > 工具说话 > thinking 第一句
  const fromSdk = messages.find(m => m.groupSummary)?.groupSummary;
  return fromSdk || summaryFromTools(messages) || summaryFromThinking(messages);
}

function TimelineGroup({ messages, closed, summary, projectId, sessionId, onCanvasReload }) {
  const [open, setOpen] = useState(true);

  if (!messages || messages.length === 0) return null;

  const isActive = !closed && messages.some(m =>
    m.isStreaming || m.status === 'running' || m.taskStatus === 'running',
  );
  const stepCount = messages.length;

  // 优先级：显式 prop > SDK helper 摘要 / 工具 / thinking 首句 > 占位
  const title = summary
    || extractSummary(messages)
    || (isActive ? 'Agent 思考中…' : `Agent 思考过程（${stepCount} 步）`);

  return (
    <div style={{ padding: `${GAP.xs}px 0 ${GAP.sm}px` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: GAP.sm,
          width: '100%',
          padding: `${GAP.xs + 2}px ${GAP.lg}px`,
          fontFamily: FONT_SANS, fontSize: 13,
          fontWeight: 500,
          color: isActive ? COLOR.warn : COLOR.text2,
          background: 'transparent',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(0,0,0,0.025)';
          e.currentTarget.style.color = isActive ? COLOR.warn : COLOR.text1;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = isActive ? COLOR.warn : COLOR.text2;
        }}
      >
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          minWidth: 0, flex: 1,
          lineHeight: 1.5,
        }}>{title}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          color={COLOR.sub}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.2s cubic-bezier(0.25, 1, 0.5, 1)',
          }}
        />
      </button>
      {open && (
        <>
          {messages.map((m, i) => {
            // 给每个节点算 timeline 位置（Context 让 TimelineNode 自己读，
            // 修最后一个节点线段溢出 + 第一个节点线段顶部多余的 bug）
            const isFirst = i === 0;
            const isLastMsg = i === messages.length - 1;
            // 关上的 group 末尾还有 done node → 当前 message 不算 last
            const isLast = isLastMsg && !closed;
            const position = (isFirst && isLast)
              ? 'only'
              : isFirst
                ? 'first'
                : isLast
                  ? 'last'
                  : 'middle';
            return (
              <TimelinePositionProvider key={m.id || `tl-${i}`} value={position}>
                <Message message={m} projectId={projectId} sessionId={sessionId} onCanvasReload={onCanvasReload} />
              </TimelinePositionProvider>
            );
          })}
          {closed && (
            <TimelinePositionProvider value="last">
              <TimelineNode icon={CheckCircle2} iconColor={COLOR.success}>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
                  color: COLOR.sub, fontWeight: 500,
                  letterSpacing: '0.06em',
                }}>
                  DONE
                </span>
              </TimelineNode>
            </TimelinePositionProvider>
          )}
        </>
      )}
    </div>
  );
}

// 自定义浅比较：MessageList 每次 setMessages 都重算 groupMessages，每个 group.items
// 都是新数组引用 — 默认浅比较挡不住。改用"逐条 message 引用 + length + closed"
// 比较：appendTextDelta 只 new 末尾那条 message，其他条引用稳定 → closed group 全部
// 命中 skip 重渲；末尾 active group 因末条 message 引用变会正确重渲。
function timelineGroupPropsEqual(prev, next) {
  if (prev.closed !== next.closed) return false;
  if (prev.summary !== next.summary) return false;
  if (prev.projectId !== next.projectId) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.onCanvasReload !== next.onCanvasReload) return false;
  const a = prev.messages || [];
  const b = next.messages || [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export default memo(TimelineGroup, timelineGroupPropsEqual);
