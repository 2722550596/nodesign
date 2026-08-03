import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, XCircle, SquarePen, History } from 'lucide-react';
import MessageList from './MessageList.jsx';
import ChatComposer from './ChatComposer.jsx';
import ContextMeter from './ContextMeter.jsx';
import TodoPanel from './TodoPanel.jsx';
import { COLOR, CHROME, GAP, RADIUS, FONT_SIZE, FONT_KAI, CANVAS } from '../../lib/theme.js';

/**
 * Chat Panel — 左栏整体壳
 *
 * 结构：header → TodoPanel（可选，agent 计划清单）→ MessageList → ChatComposer
 *
 * S4：header 显示当前 session 标题（来自 SDK SDKSessionInfo.summary /
 * customTitle / firstPrompt），点击触发 SessionListModal 切换/fork/rename/tag/delete。
 */
const headerBtn = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `3px ${GAP.sm}px`,
  fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: CHROME.pencil,
  background: 'transparent', border: 'none', borderRadius: RADIUS.sm,
  cursor: 'pointer', letterSpacing: '0.04em',
  transition: 'background 0.15s, color 0.15s',
};

export default function ChatPanel({
  messages = [], onSend, isStreaming = false,
  queueDepth = 0,
  wsStatus = 'open',          // 'connecting' | 'open' | 'reconnecting' | 'closed'
  lastEventAt = 0,            // 最近一次 WS 事件时间戳——header dot 据此判断"在动 vs 静默"
  trayItems, onRemoveTrayItem, onPickFile,
  promptSuggestion, onDismissSuggestion,
  agentProgress,
  thinkingTokens = null,      // run.status thinking 心跳的累计 tokens（null = 非思考期）
  onStop,
  todos,
  sessionTitle,
  subagents = {},             // 子代理时间轴：{ [toolUseId]: { description, taskType, status } }
  onOpenSessionList,
  onCloseSession,            // streamInput 重构：用户主动结束当前 session（终结 query）
  onNewChat,                 // 开新对话（原画布工具槽的"新任务"，本质是对话通道操作）
  hasActiveSession = false,  // 有 currentSessionId 才显示"结束会话"入口
  projectId,                   // Phase B 批次 2：rewindFiles 走 /api/projects/:pid/sessions/:sid/rewind
  sessionId,
  onCanvasReload,              // 回调：rewindFiles 成功后让 iframe bump reloadToken
  systemInfo = null,           // run.system_init 的会话常量（model / 工具数…）→ ContextMeter popover
  contextUsage = null,         // run.context_usage 实时用量 → composer 上沿指示条
  onCompact,                   // 手动 /compact（指示条 ≥85% 时长出入口 + [+] 菜单常驻入口）
  onRefreshUsage,              // [+] 菜单展开时重问一次用量（两轮之间 WS 不推）
}) {
  // V2：streaming 状态从 header 移到 Send 按钮，header 不再显示文字。
  // agentProgress 还保留——后续如果想加进度气泡（hover Send 看 last tool）可用。
  void agentProgress;

  // ── 子代理时间轴（2026-07-28）：一个事件流两个投影 ——
  // 「对话」= 主线（无 parentToolUseId）；每个子代理一个 tab，看它自己的流。
  // 消息按 parentToolUseId 拆分（server forwardSubagentText 透传，
  // lib/chat-stream.js 折叠时已隔离不互吸）。
  const [chatTab, setChatTab] = useState('main');
  useEffect(() => { setChatTab('main'); }, [sessionId]);
  useEffect(() => {
    if (chatTab !== 'main' && !subagents[chatTab]) setChatTab('main');
  }, [chatTab, subagents]);
  const shownMessages = useMemo(() => (
    chatTab === 'main'
      ? messages.filter(m => !m.parentToolUseId)
      : messages.filter(m => m.parentToolUseId === chatTab)
  ), [messages, chatTab]);

  // Header liveness dot：
  //   isStreaming + 距上次事件 < 2s → 绿色 pulse（agent 在产 output）
  //   isStreaming + ≥ 2s 无事件   → 灰色 static（在 turn 内但静默：深度思考 / 长工具调用）
  //   !isStreaming                 → 不渲染
  // 替换老的"已 30s 无输出"chip——liveness 范式：图标在动 = OK, 不动 = 待审视。
  const [iconActive, setIconActive] = useState(false);
  useEffect(() => {
    if (!isStreaming) { setIconActive(false); return undefined; }
    setIconActive(true);
    const timer = setTimeout(() => setIconActive(false), 2000);
    return () => clearTimeout(timer);
  }, [isStreaming, lastEventAt]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶部 header：session selector（点击弹 SessionListModal）+ 流式状态 */}
      <div style={{
        padding: `${GAP.md}px ${GAP.lg}px`,
        borderBottom: `1px solid ${CHROME.border}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: GAP.md,
      }}>
        {/* 会话切换器：原来是一行裸标题，看不出能点。2026-07-28 做成带框的
            下拉块（历史图标 + 标题 + ⌄），一眼看出"对话历史从这进" */}
        <button
          onClick={onOpenSessionList}
          disabled={!onOpenSessionList}
          title={onOpenSessionList ? '切换会话 / 翻历史对话（重命名、复刻、删除也在这）' : ''}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.sm}px`,
            fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, fontWeight: 500,
            color: COLOR.text,
            background: 'transparent',
            border: `1px solid ${CHROME.border}`,
            borderRadius: RADIUS.md,
            cursor: onOpenSessionList ? 'pointer' : 'default',
            flex: 1,
            minWidth: 0,
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => {
            if (!onOpenSessionList) return;
            e.currentTarget.style.background = CHROME.hover;
            e.currentTarget.style.borderColor = COLOR.borderHv;
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = CHROME.border;
          }}
        >
          <History size={11} strokeWidth={1.75} color={COLOR.sub} style={{ flexShrink: 0 }} />
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0,
            letterSpacing: 0,
            textTransform: 'none',
          }}>
            {sessionTitle || '新对话'}
          </span>
          <ChevronDown size={12} strokeWidth={1.75} color={COLOR.sub} style={{ flexShrink: 0 }} />
        </button>

        {/* 开新对话：原来在画布工具槽叫"新任务"（名不副实——它开的是对话通道，
            不是任务文件夹）。2026-07-28 挪到会话头，跟结束会话并排 */}
        {hasActiveSession && onNewChat && (
          <button
            onClick={onNewChat}
            title="开新对话（当前会话保留，随时从会话列表回来）"
            style={headerBtn}
            onMouseEnter={e => { e.currentTarget.style.background = CHROME.hover; e.currentTarget.style.color = COLOR.text2; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = COLOR.sub; }}
          >
            <SquarePen size={12} strokeWidth={1.75} />
            新对话
          </button>
        )}

        {/* 结束本会话：streamInput query 终结 + URL 跳回 /work（前端 state 由 effect reset）。
            2026-07-30 想把它收进会话下拉（低频 + 不可逆，跟高频的「新对话」并排容易误点），
            但它同时是**释放 agent 进程的唯一显式出口**，而内测有每用户并发上限：
            埋起来 → 用户留一堆活会话 → 撞 429 BUSY 且不知道为什么。等空闲自动回收
            落地后再移。眼下只降级成图标，不跟「新对话」争视觉重量。 */}
        {hasActiveSession && onCloseSession && (
          <button
            onClick={onCloseSession}
            title="结束当前会话（终结 agent，历史保留，可从会话列表找回）"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              padding: `${GAP.xs}px ${GAP.sm}px`,
              fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.sub,
              background: 'transparent', border: 'none', borderRadius: RADIUS.sm,
              cursor: 'pointer',
              letterSpacing: '0.04em',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = CHROME.hover;
              e.currentTarget.style.color = COLOR.text2;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = COLOR.sub;
            }}
          >
            <XCircle size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {/* 子代理时间轴 tabs：有子代理跑过才出现 */}
      {Object.keys(subagents).length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: GAP.xs, flexWrap: 'wrap',
          padding: `${GAP.xs}px ${GAP.lg}px`,
          borderBottom: `1px solid ${CHROME.border}`,
          background: 'rgba(43,33,23,0.02)',
        }}>
          <button onClick={() => setChatTab('main')} style={timelineTab(chatTab === 'main')}>对话</button>
          {Object.entries(subagents).map(([tid, sa]) => (
            <button key={tid} onClick={() => setChatTab(tid)} style={timelineTab(chatTab === tid)} title={sa.description}>
              <span style={{
                width: 6, height: 6, borderRadius: RADIUS.round, flexShrink: 0,
                background: sa.status === 'running' ? CANVAS.brass : sa.status === 'completed' ? '#4f8f5b' : '#b0554f',
                animation: sa.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : 'none',
              }} />
              {(sa.description || sa.taskType || '子代理').slice(0, 14)}
            </button>
          ))}
        </div>
      )}

      <TodoPanel todos={todos} />
      <MessageList
        onOpenSessionList={onOpenSessionList}
        messages={shownMessages}
        isStreaming={isStreaming}
        thinkingTokens={thinkingTokens}
        agentActive={iconActive}
        projectId={projectId}
        sessionId={sessionId}
        onCanvasReload={onCanvasReload}
      />

      {/* WS 连接异常 — 真错误才弹（agent 静默走 header dot 显示，不再发文字 chip） */}
      {(wsStatus === 'reconnecting' || wsStatus === 'closed') && (
        <div style={{
          padding: `${GAP.xs}px ${GAP.lg}px`,
          fontFamily: FONT_KAI,
          fontSize: FONT_SIZE.md,
          color: wsStatus === 'closed' ? COLOR.error : COLOR.sub,
          letterSpacing: '0.04em',
          background: wsStatus === 'closed' ? 'rgba(220, 53, 69, 0.06)' : 'rgba(255, 193, 7, 0.06)',
          borderTop: `1px dashed ${COLOR.borderLt}`,
          display: 'flex', alignItems: 'center', gap: GAP.sm,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: RADIUS.round,
            background: wsStatus === 'closed' ? COLOR.error : COLOR.warn,
            animation: wsStatus === 'reconnecting' ? 'pulse 1.5s ease-in-out infinite' : 'none',
          }} />
          {wsStatus === 'closed'
            ? '连接已关闭 · 请刷新页面'
            : '正在重连服务器…（已收到的事件不会丢，重连后会补 replay）'}
        </div>
      )}

      {/* streamInput 排队提示：当用户在 agent 跑时追加消息后 inputQueue 积压，
          显示"已排队 N 条"chip，agent 会跑完当前 turn 后自动吃下一条 */}
      {queueDepth > 0 && (
        <div style={{
          padding: `${GAP.xs}px ${GAP.lg}px`,
          fontFamily: FONT_KAI,
          fontSize: FONT_SIZE.md,
          color: COLOR.sub,
          letterSpacing: '0.04em',
          background: 'rgba(45, 36, 24, 0.04)',
          borderTop: `1px dashed ${COLOR.borderLt}`,
          display: 'flex', alignItems: 'center', gap: GAP.sm,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: RADIUS.round,
            background: COLOR.warn,
          }} />
          已排队 {queueDepth} 条 · agent 跑完当前会自动处理
        </div>
      )}
      {/* 上下文指示：composer 上沿的一条 hairline，60% 以下零像素（见 ContextMeter） */}
      <ContextMeter
        usage={contextUsage}
        info={systemInfo}
        onCompact={onCompact}
        isStreaming={isStreaming}
      />
      <ChatComposer
        onSend={onSend}
        // disabled 给外部留口（hydrateError 等）；isRunning 单独控 Send/停止 形态
        disabled={false}
        isRunning={isStreaming}
        onStop={onStop}
        trayItems={trayItems}
        onRemoveTrayItem={onRemoveTrayItem}
        onPickFile={onPickFile}
        promptSuggestion={promptSuggestion}
        onDismissSuggestion={onDismissSuggestion}
        contextUsage={contextUsage}
        systemInfo={systemInfo}
        onCompact={onCompact}
        onRefreshUsage={onRefreshUsage}
        projectId={projectId}
        sessionId={sessionId}
      />
    </div>
  );
}

/** 子代理时间轴 tab 按钮（对话 / 各子代理）*/
function timelineTab(active) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: `3px ${GAP.base}px`, borderRadius: RADIUS.pill, border: 0,
    fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, fontWeight: 500,
    color: active ? '#F5F0E4' : CHROME.ink,
    background: active ? CHROME.ink : 'rgba(43,33,23,0.06)',
    cursor: 'pointer', transition: 'all 0.15s',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180,
  };
}
