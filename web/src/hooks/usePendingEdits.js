/**
 * usePendingEdits — 画布拖移工具的 pending edits 状态管理
 *
 * 用户拖动 / nudge / 复制 / 删除时往本 hook push 一条 edit；hook 自动：
 *   - 维护前端列表（驱动 PendingEditsBar 计数 + DragOverlay 还原视觉）
 *   - 同步推后端 PendingChanges.push（落 <sessionRoot>/pending-changes.json）
 *   - 暴露 undo/redo / clearAll / applyAndClear
 *
 * 跟 comments state 一样，前端 state 不持久化（切 session / 刷新会丢）；后端
 * buffer 持久化（刷新后再起 session 还能拉回）—— 切 session 时调 syncFromServer
 * 把后端 items 拉回来 rebuild 一遍前端 state。
 *
 * undo/redo：本地操作历史栈，切 session / clear 后清空。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PendingChanges } from '../lib/api.js';
import { newId } from '../lib/helpers.js';

export function usePendingEdits({ projectId, sessionId }) {
  const [edits, setEdits] = useState([]);
  // 用 state 而不是 ref 持 undo/redo 栈 —— canUndo / canRedo 派生自栈深度，
  // 必须能驱动 re-render 让 PendingEditsBar 的按钮 enable/disable 实时跟新。
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  // 前端运行时还原器：editId → () => void。push 时 stash，undo 时 invoke 还原 iframe DOM。
  // 不进 React state（DOM element 引用 + 非序列化闭包），ref 持有即可。
  const revertersRef = useRef(new Map());

  // 切 session：clear 本地 state，下面 syncFromServer 会拉回（如果有）
  useEffect(() => {
    setEdits([]);
    setUndoStack([]);
    setRedoStack([]);
    revertersRef.current.clear();
    if (!projectId || !sessionId) return;
    let cancelled = false;
    PendingChanges.list(projectId, sessionId).then(({ items = [] }) => {
      if (cancelled) return;
      // 只回填 pending-* kind（edit/comment 由别处管）
      const ours = items.filter(it => typeof it.kind === 'string' && it.kind.startsWith('pending-'));
      setEdits(ours);
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [projectId, sessionId]);

  /**
   * Push 一条新 pending edit。
   * payload 应该包含 kind / anchor + 该 kind 要求的额外字段（详见 server/api/pending-changes.js）。
   * 内部分配 id + 落本地 state + 异步推后端。
   */
  /**
   * push 一条 pending edit。
   *
   * **去重合并语义**：同 anchor + 同 kind 的连续 push 视为"用户在反复调整同一处"。
   * 只保留最后一条到 buffer（agent 只关心最终态）；但 undo 仍能整体退回到**最最初**
   * 的状态（继承首次 push 时的 revert function，因为只有它记录了原始 parent/sibling）。
   *
   * UI 计数：用户看到的"N 处调整"= 去重后的元素数，跟"调过 N 个元素"心智一致。
   *
   * @param payload  序列化进后端 buffer 的 item（不含 DOM refs）
   * @param revertFn 可选；undo 时调用此函数把 iframe 内 DOM 还原到 apply 前状态
   */
  const push = useCallback(async (payload, revertFn) => {
    if (!payload || !payload.kind || !payload.anchor) return null;
    const sourceKey = payload.anchor.dataId || payload.anchor.path;

    // 找同 anchor + 同 kind 的旧 edit（合并目标）
    let oldEdit = null;
    if (sourceKey) {
      for (const e of edits) {
        if (e.kind !== payload.kind) continue;
        const k = e.anchor?.dataId || e.anchor?.path;
        if (k && k === sourceKey) { oldEdit = e; break; }
      }
    }

    // 继承旧 revert（它记录了 source 最最初的位置；新 revertFn 记的是"上次拖完后"
    // 那个中间态，对用户撤销没意义）。同时移除旧 revert 引用避免泄漏。
    let inheritedRevert = revertFn;
    if (oldEdit) {
      const oldRevert = revertersRef.current.get(oldEdit.id);
      if (oldRevert) inheritedRevert = oldRevert;
      revertersRef.current.delete(oldEdit.id);
      // 后端 buffer 也要清掉旧 id（避免 agent 看到两条同 anchor 的 edit）
      if (projectId && sessionId) {
        try { await PendingChanges.clear(projectId, sessionId, [oldEdit.id]); } catch { /* */ }
      }
    }

    const id = newId('pe');
    const item = {
      id,
      ts: new Date().toISOString(),
      ...payload,
    };
    setEdits(prev => {
      if (oldEdit) {
        return prev.map(e => e.id === oldEdit.id ? item : e);
      }
      return [...prev, item];
    });
    // undo 栈：合并时**移除旧 op**（避免连按 Undo 第二次时 pop 出 stale op；那条
    // 的 revert 已在合并时 delete 掉，pop 出来视觉上"没反应"）。
    // 合并语义下：撤销 = "撤销该元素的所有调整"，栈里同元素只该有 1 条 op。
    setUndoStack(prev => {
      const filtered = oldEdit
        ? prev.filter(op => !(Array.isArray(op.items) && op.items.some(it => it.id === oldEdit.id)))
        : prev;
      return [...filtered, { type: 'push', items: [item], merged: !!oldEdit }];
    });
    setRedoStack([]);
    if (typeof inheritedRevert === 'function') {
      revertersRef.current.set(id, inheritedRevert);
    }

    if (projectId && sessionId) {
      try {
        await PendingChanges.push(projectId, sessionId, item);
      } catch (err) {
        console.warn('[pending-edits] push failed:', err.message);
      }
    }
    return item;
  }, [edits, projectId, sessionId]);

  /** 调用 + 清理一组 editId 的 reverters */
  const invokeReverters = useCallback((ids) => {
    for (const id of ids) {
      const fn = revertersRef.current.get(id);
      if (fn) {
        try { fn(); } catch (err) { console.warn('[pending-edits] revert failed:', err.message); }
        revertersRef.current.delete(id);
      }
    }
  }, []);

  /** 撤销最后一次操作 */
  const undo = useCallback(async () => {
    if (undoStack.length === 0) return false;
    const op = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));
    if (op.type === 'push') {
      const ids = op.items.map(it => it.id);
      const idSet = new Set(ids);
      // 关键：还原 iframe 里的 DOM 视觉（移回原 parent / 撤销 inline style）
      invokeReverters(ids);
      setEdits(prev => prev.filter(e => !idSet.has(e.id)));
      setRedoStack(prev => [...prev, { type: 'restore', items: op.items }]);
      if (projectId && sessionId) {
        try { await PendingChanges.clear(projectId, sessionId, ids); } catch { /* */ }
      }
    } else if (op.type === 'clear') {
      // 注：clear 已经 invoke 过 reverters 还原 DOM；这里只重建前端 + 后端 buffer。
      // 视觉还原不能"redo 上一次 clear" —— 那要求 iframe reload（agent run 后视觉跟代码一致）
      setEdits(prev => [...prev, ...op.items]);
      setRedoStack(prev => [...prev, { type: 'clear-redo', items: op.items }]);
      if (projectId && sessionId) {
        for (const it of op.items) {
          try { await PendingChanges.push(projectId, sessionId, it); } catch { /* */ }
        }
      }
    }
    return true;
  }, [undoStack, projectId, sessionId, invokeReverters]);

  /** 重做 */
  const redo = useCallback(async () => {
    if (redoStack.length === 0) return false;
    const op = redoStack[redoStack.length - 1];
    setRedoStack(prev => prev.slice(0, -1));
    if (op.type === 'restore') {
      setEdits(prev => [...prev, ...op.items]);
      setUndoStack(prev => [...prev, { type: 'push', items: op.items }]);
      if (projectId && sessionId) {
        for (const it of op.items) {
          try { await PendingChanges.push(projectId, sessionId, it); } catch { /* */ }
        }
      }
    } else if (op.type === 'clear-redo') {
      const ids = op.items.map(it => it.id);
      const idSet = new Set(ids);
      setEdits(prev => prev.filter(e => !idSet.has(e.id)));
      setUndoStack(prev => [...prev, { type: 'clear', items: op.items }]);
      if (projectId && sessionId) {
        try { await PendingChanges.clear(projectId, sessionId, ids); } catch { /* */ }
      }
    }
    return true;
  }, [redoStack, projectId, sessionId]);

  /** 全清（用户点"全部撤销"）—— 同时调全部 reverters 还原 iframe DOM */
  const clearAll = useCallback(async () => {
    const snapshot = edits;
    if (snapshot.length === 0) return;
    // 按 push 反序还原，保证一连串 move 能"层层退回"
    const ids = [...snapshot].reverse().map(it => it.id);
    invokeReverters(ids);
    setEdits([]);
    setUndoStack(prev => [...prev, { type: 'clear', items: snapshot }]);
    setRedoStack([]);
    if (projectId && sessionId) {
      try { await PendingChanges.clear(projectId, sessionId, snapshot.map(it => it.id)); } catch { /* */ }
    }
  }, [edits, projectId, sessionId, invokeReverters]);

  /**
   * Apply 完成回调（应用按钮 → 触发 chat message → agent run → agent 调
   * clear_pending_changes → run.pending_changes_cleared 事件回到前端）。
   *
   * 不主动 clear（agent 那边会清后端），只清前端 state + undo 栈。
   * ProjectWorkspace 在 run.pending_changes_cleared 事件 handler 里调一次。
   */
  /**
   * agent run 完成 / 调 clear_pending_changes 后由外层调一次。视觉还原
   * **不调 reverters** —— 因为 agent 已经把改动落到源代码，iframe reload 后
   * 视觉跟源代码一致。这里只清前端 state + 把 reverter map 释放掉。
   */
  const onAppliedExternally = useCallback((clearedIds) => {
    if (!Array.isArray(clearedIds) || clearedIds.length === 0) return;
    const set = new Set(clearedIds);
    for (const id of clearedIds) revertersRef.current.delete(id);
    setEdits(prev => prev.filter(e => !set.has(e.id)));
    setUndoStack(prev => prev.filter(op => {
      if (!Array.isArray(op.items)) return true;
      return !op.items.some(it => set.has(it.id));
    }));
    setRedoStack([]);
  }, []);

  return {
    edits,
    push,
    undo,
    redo,
    clearAll,
    onAppliedExternally,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}
