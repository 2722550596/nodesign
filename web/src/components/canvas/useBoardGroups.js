/**
 * useBoardGroups —— 黑板组的三个用户动作（2026-08-23）：整组选 / 落定草稿 / 整组擦
 *
 * 「组」不是容器，是 #tag（agent 一张草图一个 tag；read_board 也按它读）。
 * 选：把同 tag 的物件全部放进 selectedIds（批量菜单随之可用）。
 * 落定：POST /board/commit —— staging 半透明变实。
 * 擦：POST /board/erase —— 只删画布原生物件与线，产物卡只摘标签（服务端 removeByTag）。
 */
import { useCallback } from 'react';
import { Assets } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

const tagOf = (o) => o?.tag || o?.pos?.tag || null;

export function useBoardGroups({ projectId, positionedRef, setSelectedIds, reload }) {
  const selectGroup = useCallback((tag) => {
    const ids = (positionedRef.current || []).filter(o => tagOf(o) === tag).map(o => o.id);
    if (ids.length) setSelectedIds(ids);
  }, [positionedRef, setSelectedIds]);

  const commitGroup = useCallback(async (tag) => {
    try { await Assets.commitBoard(projectId, tag); } catch { /* 落定失败：刷新后还是草稿，看得见 */ }
    reload?.();
  }, [projectId, reload]);

  const eraseGroup = useCallback(async (tag) => {
    const n = (positionedRef.current || []).filter(o => tagOf(o) === tag).length;
    const ok = await useGlobalStore.getState().confirm({
      title: '擦掉整组',
      message: `擦掉 #${tag} 这一组（${n} 件）？手写字、涂鸦和线会删掉，产物卡只摘掉标签不删。`,
      confirmLabel: '擦掉',
      danger: true,
    });
    if (!ok) return;
    try { await Assets.eraseBoardTag(projectId, tag); } catch { /* 同上 */ }
    setSelectedIds([]);
    reload?.();
  }, [projectId, positionedRef, setSelectedIds, reload]);

  /** 连接图导出：直接打开下载地址（服务端带附件头），不经 blob */
  const exportGraph = useCallback((format, tag = null) => {
    const q = new URLSearchParams({ format, download: '1' });
    if (tag) q.set('tag', tag);
    const a = document.createElement('a');
    a.href = `/api/projects/${encodeURIComponent(projectId)}/board/graph?${q}`;
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  }, [projectId]);

  return { selectGroup, commitGroup, eraseGroup, exportGraph };
}
