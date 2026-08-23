/**
 * useViewpointReport —— 把「用户此刻在看哪」告诉服务端（2026-08-23 黑板）
 *
 * 服务端在这之前对相机、开着的窗、选中集一无所知，agent 只能猜「这个」指什么。
 * 这个 hook 把视口的世界矩形 + 缩放 + 当前文件夹层 + 开着的窗 + 选中集按节流
 * POST 上去（只在变化时发，最快 1.2s 一次）。fire-and-forget：失败不打扰用户。
 *
 * 相机模型：屏幕 = (世界 + cam.xy) * cam.z，所以可见世界矩形左上 = (-cam.x, -cam.y)，
 * 宽高 = 视口 / z。
 *
 * 眼睛模式（?eye=1，agent 的 look_at_board 开的那一页）**不上报**：那不是用户在看。
 */
import { useEffect, useRef } from 'react';
import { Assets } from '../../lib/api.js';

const MIN_INTERVAL_MS = 1200;

export function useViewpointReport({ projectId, cam, viewport, layer = '', openWindow = null, selectedIds = [], enabled = true }) {
  const lastRef = useRef({ key: '', at: 0, timer: null });
  useEffect(() => {
    if (!enabled || !projectId || !viewport?.w || !viewport?.h || !cam) return undefined;
    const z = cam.z || 1;
    const camera = {
      x: Math.round(-cam.x), y: Math.round(-cam.y),
      w: Math.round(viewport.w / z), h: Math.round(viewport.h / z),
    };
    const payload = {
      camera, zoom: Math.round(z * 100) / 100, layer: layer || '',
      openWindow: openWindow || null,
      selected: (selectedIds || []).slice(0, 24),
    };
    // 变化判据：相机挪超过 1/8 视口、缩放变、窗/选中变
    const key = `${Math.round(camera.x / Math.max(1, camera.w / 8))}:${Math.round(camera.y / Math.max(1, camera.h / 8))}:${payload.zoom}:${payload.layer}:${payload.openWindow}:${payload.selected.join(',')}`;
    const st = lastRef.current;
    if (key === st.key) return undefined;
    const send = () => {
      st.key = key; st.at = Date.now(); st.timer = null;
      Assets.reportViewpoint(projectId, payload).catch(() => { /* 视点丢一拍无所谓 */ });
    };
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - st.at));
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(send, wait);
    return () => { if (st.timer) { clearTimeout(st.timer); st.timer = null; } };
  }, [enabled, projectId, cam?.x, cam?.y, cam?.z, viewport?.w, viewport?.h, layer, openWindow, selectedIds]);
}
