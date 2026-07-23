import { useEffect, useState } from 'react';
import { ChevronDown, XCircle } from 'lucide-react';
import MessageList from './MessageList.jsx';
import ChatComposer from './ChatComposer.jsx';
import TodoPanel from './TodoPanel.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';

/**
 * Chat Panel — 左栏整体壳
 *
 * 结构：header → TodoPanel（可选，agent 计划清单）→ MessageList → ChatComposer
 *
 * S4：header 显示当前 session 标题（来自 SDK SDKSessionInfo.summary /
 * customTitle / firstPrompt），点击触发 SessionListModal 切换/fork/rename/tag/delete。
 */
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
  onOpenSessionList,
  onCloseSession,            // streamInput 重构：用户主动结束当前 session（终结 query）
  hasActiveSession = false,  // 有 currentSessionId 才显示"结束会话"入口
  projectId,                   // Phase B 批次 2：rewindFiles 走 /api/projects/:pid/sessions/:sid/rewind
  sessionId,
  onCanvasReload,              // 回调：rewindFiles 成功后让 iframe bump reloadToken
}) {
  // V2：streaming 状态从 header 移到 Send 按钮，header 不再显示文字。
  // agentProgress 还保留——后续如果想加进度气泡（hover Send 看 last tool）可用。
  void agentProgress;

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
        borderBottom: `1px solid ${COLOR.borderLt}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: GAP.md,
      }}>
        <button
          onClick={onOpenSessionList}
          disabled={!onOpenSessionList}
          title={onOpenSessionList ? '切换 / 管理会话' : ''}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.sm}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
            color: COLOR.text,
            background: 'transparent',
            border: 'none',
            borderRadius: 4,
            cursor: onOpenSessionList ? 'pointer' : 'default',
            maxWidth: '60%',
            minWidth: 0,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => { if (onOpenSessionList) e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
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

        {/* Liveness dot — isStreaming 期间常驻，event 进来时 pulse，2s 静默后转灰静态 */}
        {isStreaming && (
          <span
            title={iconActive ? 'Agent 正在输出' : 'Agent 在 turn 内但暂无输出（深度思考 / 长工具 / 外部资源）'}
            style={{
              width: 7, height: 7, borderRadius: '50%',
              flexShrink: 0,
              background: iconActive ? COLOR.success : COLOR.sub,
              animation: iconActive ? 'pulse 1.2s ease-in-out infinite' : 'none',
              transition: 'background 0.3s ease',
            }}
          />
        )}

        {/* 思考进度 — run.status status='thinking' 心跳（~1s/条，累计 tokens）。
            有它在跳说明后端活着且模型在思考；正文/工具事件到达即被父级清掉 */}
        {isStreaming && thinkingTokens != null && (
          <span style={{
            fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
            flexShrink: 0, whiteSpace: 'nowrap',
          }}>
            思考中 · ~{thinkingTokens >= 1000 ? `${(thinkingTokens / 1000).toFixed(1)}k` : thinkingTokens} tok
          </span>
        )}

        {/* 结束本会话：streamInput query 终结 + URL 跳回 /work（前端 state 由 effect reset）
            仅当有 active session 时显示，避免 /work 路径误触 */}
        {hasActiveSession && onCloseSession && (
          <button
            onClick={onCloseSession}
            title="结束当前会话（终结 agent，session 历史保留可从列表找回）"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: `${GAP.xs}px ${GAP.sm}px`,
              fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
              background: 'transparent', border: 'none', borderRadius: 4,
              cursor: 'pointer',
              letterSpacing: '0.04em',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(0,0,0,0.04)';
              e.currentTarget.style.color = COLOR.text2;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = COLOR.sub;
            }}
          >
            <XCircle size={12} strokeWidth={1.75} />
            结束会话
          </button>
        )}
      </div>

      <TodoPanel todos={todos} />
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        projectId={projectId}
        sessionId={sessionId}
        onCanvasReload={onCanvasReload}
      />

      {/* WS 连接异常 — 真错误才弹（agent 静默走 header dot 显示，不再发文字 chip） */}
      {(wsStatus === 'reconnecting' || wsStatus === 'closed') && (
        <div style={{
          padding: `${GAP.xs}px ${GAP.lg}px`,
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: wsStatus === 'closed' ? COLOR.error : COLOR.sub,
          letterSpacing: '0.04em',
          background: wsStatus === 'closed' ? 'rgba(220, 53, 69, 0.06)' : 'rgba(255, 193, 7, 0.06)',
          borderTop: `1px dashed ${COLOR.borderLt}`,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
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
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: COLOR.sub,
          letterSpacing: '0.04em',
          background: 'rgba(45, 36, 24, 0.04)',
          borderTop: `1px dashed ${COLOR.borderLt}`,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: COLOR.warn,
          }} />
          已排队 {queueDepth} 条 · agent 跑完当前会自动处理
        </div>
      )}
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
      />
    </div>
  );
}
