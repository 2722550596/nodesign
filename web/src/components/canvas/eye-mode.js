/**
 * eye-mode —— agent 的眼睛（2026-08-23 黑板）
 *
 * look_at_board 工具在服务端用常驻 chromium 打开**这同一张画布页**截图（不另写
 * 渲染器 —— "同一件东西多个实例"是最贵的一课）。它靠 URL 参数告诉页面要看哪：
 *
 *   ?eye=1&view=x,y,w,h        框住一块世界矩形
 *   ?eye=1&tag=sk-xxx          框住带这个 #tag 的那一组
 *   ?eye=1                     全景（contentBox）
 *
 * 页面把相机摆好、等一拍渲染稳定，在 <html> 上打 data-eye-ready="1"，工具等这个
 * 属性再按快门。眼睛模式下不上报视点（那不是用户在看）。
 */
import { useEffect } from 'react';
import { sizeOf } from '../../lib/board-kinds.js';

export function eyeParams() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('eye') !== '1') return null;
    const view = (q.get('view') || '').split(',').map(Number);
    return {
      view: view.length === 4 && view.every(Number.isFinite) ? { x: view[0], y: view[1], w: view[2], h: view[3] } : null,
      tag: q.get('tag') || null,
    };
  } catch { return null; }
}

export function useEyeMode({ eye, camRef, positionedRef }) {
  useEffect(() => {
    if (!eye) return undefined;
    let cancelled = false;
    document.documentElement.dataset.eye = '1';
    // 等入座/数据到齐：轮询到有东西（或 4s 放弃，照样截全景）
    const t0 = Date.now();
    const tick = () => {
      if (cancelled) return;
      // ⚠️ 相机 API 走 ref 读**此刻**的：effect 只挂一次，闭包里的 camera 是首渲染
      // 那份（viewport 还是 0x0），拿它判就绪会永远等下去（首版真踩）。
      const camera = camRef.current;
      const positioned = positionedRef.current || [];
      const ready = positioned.length > 0 || Date.now() - t0 > 4000;
      if (!ready || !camera?.viewport?.w) { setTimeout(tick, 120); return; }
      let box = eye.view;
      if (!box && eye.tag) {
        const rects = positioned
          .filter(o => (o.tag || o.pos?.tag) === eye.tag)
          .map(o => { const sz = sizeOf(o); return { x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h }; });
        if (rects.length) {
          const x0 = Math.min(...rects.map(r => r.x)); const y0 = Math.min(...rects.map(r => r.y));
          const x1 = Math.max(...rects.map(r => r.x + r.w)); const y1 = Math.max(...rects.map(r => r.y + r.h));
          box = { x: x0 - 24, y: y0 - 24, w: x1 - x0 + 48, h: y1 - y0 + 48 };
        }
      }
      if (box) camera.flyToBox(box, { force: true, duration: 1, maxZoom: 2 });
      else camera.zoomToFit({ duration: 1 });
      // 给字体/iframe 缩略/动画一点时间，再宣布就绪；顺手把真实看到的世界矩形写出来
      setTimeout(() => {
        if (cancelled) return;
        const c = camRef.current?.cam; const vp = camRef.current?.viewport;
        if (c && vp?.w) {
          const z = c.z || 1;
          document.documentElement.dataset.eyeView = `(${Math.round(-c.x)},${Math.round(-c.y)}) ${Math.round(vp.w / z)}x${Math.round(vp.h / z)} zoom ${z.toFixed(2)}`;
        }
        document.documentElement.dataset.eyeReady = '1';
      }, 900);
    };
    tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!eye]);
}
