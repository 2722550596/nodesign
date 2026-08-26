import { useCallback, useState } from 'react';
import { Sessions } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';

/**
 * 聊天+文件回滚（SDK rewindFiles + jsonl 截断）的共享逻辑。
 *
 * 两处入口共用：
 *   - Message.jsx 用户消息悬停「回到此处」（回滚到某条用户消息）
 *   - TimelineGroup 轮次级「回滚到此轮之前」（回滚到该轮起点的用户消息）
 *
 * 成功链路（与后端 emit 配合）：
 *   - 后端 rewind 成功 → run.file_changed 事件让画布 iframe 自动 reload
 *   - conversationTruncated=true → dispatch 'nd-conversation-rewound'，ProjectWorkspace
 *     监听后重拉消息列表（免传三层 props）
 *   - 兼容：onCanvasReload 兜底 bump（active query 路径同步返回时也调）
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canRewindMessage(message) {
  return !!(message?.id && UUID_RE.test(message.id));
}

export function useRewind({ projectId, sessionId, onCanvasReload }) {
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const [busy, setBusy] = useState(false);

  const rewind = useCallback(async (userMessageId, opts = {}) => {
    if (!projectId || !sessionId || busy || !userMessageId) return;
    const confirmText = opts.confirmText || '回到此处？这会丢弃后续所有文件改动。\n\n历史会话首次回滚需 3-5 秒（重启临时会话）；后续回滚瞬间完成。';
    if (!(await confirm({ title: opts.confirmTitle || '回到此处', message: confirmText, confirmLabel: '回滚', danger: true }))) return;
    setBusy(true);
    try {
      const result = await Sessions.rewind(projectId, sessionId, userMessageId);
      if (result?.canRewind === false) {
        showToast(result.error || '此处不支持回滚', 'warn');
      } else {
        const n = result?.filesChanged?.length || 0;
        // iframe reload 由后端 emit 的 run.file_changed event 自动触发
        // （ProjectWorkspace 已 case），onCanvasReload 是兜底兼容调用
        const talk = result?.conversationTruncated ? '，对话已截回该处' : '';
        showToast(n > 0 ? `已回滚 ${n} 个文件${talk}` : `已回滚${talk || '（无文件改动）'}`, 'success');
        if (onCanvasReload) onCanvasReload();
        // 对话层已被服务端截断 → 通知 ProjectWorkspace 重拉消息（免传三层 props）
        if (result?.conversationTruncated) {
          window.dispatchEvent(new CustomEvent('nd-conversation-rewound', { detail: { sessionId } }));
        }
      }
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes('REWIND_BUSY') || msg.includes('409')) {
        showToast('上一个回滚还在进行，稍候重试', 'warn');
      } else if (msg.includes('JSONL_MISSING') || msg.includes('404')) {
        showToast('会话历史已删，无法回滚', 'warn');
      } else if (msg.includes('REWIND_FAILED') || msg.includes('timeout')) {
        showToast('回滚超时，请重试（临时会话启动较慢时偶发）', 'error');
      } else {
        showToast(`回滚失败：${msg}`, 'error');
      }
    } finally {
      setBusy(false);
    }
  }, [projectId, sessionId, busy, showToast, confirm, onCanvasReload]);

  return { busy, rewind };
}
