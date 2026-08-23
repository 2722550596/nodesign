/**
 * useBlackboardMode —— 黑板模式开关 + 镜头跟随（2026-08-23）
 *
 * 开关存项目级 ui-config.json（blackboard_mode），服务端 UserPromptSubmit 读同一份
 * 决定给 agent 注入「主体内容落画布」的硬规则。前端这边：
 *   - 工具栏按钮显示/切换
 *   - 开着时，agent 落一张草图（board.focus 事件）镜头飞过去框住它（maxZoom 1，
 *     不放大到超过 100%；小图也不会贴脸）。关着不动镜头 —— 不劫持。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionConfig } from '../../lib/api.js';
import { useViewpointReport } from './useViewpointReport.js';
import { eyeParams, useEyeMode } from './eye-mode.js';

export function useBlackboardMode({ projectId, focusRequest, camRef }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!projectId) return undefined;
    SessionConfig.read(projectId).then((r) => {
      if (alive && r?.config && typeof r.config.blackboard_mode === 'boolean') setOn(r.config.blackboard_mode);
    }).catch(() => {});
    return () => { alive = false; };
  }, [projectId]);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      SessionConfig.patch(projectId, { blackboard_mode: next }).catch(() => {});
      return next;
    });
  }, [projectId]);

  // 跟随：只认新的 focusRequest（按 at 去重），且只在开着时
  const seen = useRef(0);
  useEffect(() => {
    if (!on || !focusRequest?.rect || !focusRequest.at || focusRequest.at === seen.current) return;
    seen.current = focusRequest.at;
    const r = focusRequest.rect;
    camRef.current?.flyToBox?.({ x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 }, { force: true, maxZoom: 1 });
  }, [on, focusRequest, camRef]);

  return { blackboardMode: on, toggleBlackboard: toggle };
}

/**
 * 黑板三件一起挂（BoardCanvas 行数棘轮逼出来的收口，语义不变）：
 * 视点上报（眼睛模式不报）+ 眼睛模式 + 黑板模式开关/跟随。
 */
export function useBlackboardWiring({ projectId, cam, viewport, winDir, openWindow, selectedIds, camRef, positionedRef, focusRequest }) {
  const eye = eyeParams();
  useViewpointReport({
    projectId, cam, viewport, layer: winDir || '',
    openWindow: winDir ? `folder:${winDir}` : openWindow, selectedIds, enabled: !eye,
  });
  useEyeMode({ eye, camRef, positionedRef });
  return useBlackboardMode({ projectId, focusRequest, camRef });
}
