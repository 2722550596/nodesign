/**
 * server/ws/browse-channel.js — 浏览器画面/输入的专用 WS 通道（2026-08-18）
 *
 * 路径 `/ws/projects/:pid/browser`。**跟现有 `/ws/projects/:pid` 刻意分开**，
 * 理由是那条通道的性质完全不同：
 *
 * - 现有通道是**纯下行**（服务端没有任何 `ws.on('message')`）、走 per-project
 *   EventBus 广播、**带 2000 条重放缓冲 + hydrate 分片**。
 *   高频画面帧灌进去会**冲爆重放缓冲**、混进 hydrate 回放。
 * - 而且那条通道是 JSON 文本帧 + perMessageDeflate：base64 一张 JPEG 先胖 33%，
 *   再让 zlib 白压一遍（JPEG 压不动）。
 *
 * 这条通道：**二进制帧下行**（无 base64、`compress:false`）、per-connection 直发
 * （只发给开着窗的那条 socket）、**上行**收订阅控制与人接手的输入。
 *
 * 低频信号（agent 求助、窗该开了）仍然走**现有** EventBus —— 它天生适合那种
 * switch-case 路由。像素和输入才走这里。
 */

import { WebSocketServer } from 'ws';
import { requestUser } from '../auth/session.js';
import { userOwnsProject } from '../api/_guard.js';
import { getProject, validateProjectId } from '../projects/store.js';
import { peek } from '../engine/browse/registry.js';
import { subscribe, unsubscribe, frameMeta } from '../engine/browse/screencast.js';
import { releaseHelp } from '../engine/browse/handover.js';

export const BROWSE_WS_RE = /^\/ws\/projects\/([^/]+)\/browser$/;

/** 接手时人的输入 → CDP。坐标从"canvas 上的比例"换算成设备像素。 */
async function dispatchInput(page, projectId, msg) {
  const cdp = await page.context().newCDPSession(page);
  const meta = frameMeta(projectId);
  // 前端发的是 0..1 的比例（它比谁都清楚自己那块 canvas 多大），服务端换算成
  // 页面像素 —— 这样缩放、DPR、窗口大小变化都不用两边对齐
  const w = meta?.deviceWidth || 1024;
  const h = meta?.deviceHeight || 700;
  const x = Math.round((msg.rx ?? 0) * w);
  const y = Math.round((msg.ry ?? 0) * h);

  if (msg.kind === 'click') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return;
  }
  if (msg.kind === 'move') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return;
  }
  if (msg.kind === 'wheel') {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: msg.dx || 0, deltaY: msg.dy || 0,
    });
    return;
  }
  if (msg.kind === 'key') {
    // ⚠️ Phase 1 只支持可打印字符与几个功能键。中文输入法要按 composer 那套
    // isIme 判定处理（chat-composer-fixes 的教训），留 Phase 2 —— 现在人要输中文
    // 请直接在自己浏览器里操作，别指望这条通道。
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (text) {
      await cdp.send('Input.insertText', { text });
      return;
    }
    const key = msg.key;
    if (!key) return;
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, windowsVirtualKeyCode: msg.code || 0 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: msg.code || 0 });
  }
}

function handleConn(ws, pid) {
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* */ } };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const live = peek(pid);

    try {
      if (msg.type === 'subscribe') {
        if (!live) return send({ type: 'idle', reason: 'agent 还没开始浏览（没有常驻浏览器）' });
        const r = await subscribe(pid, ws, live.page);
        return send(r.ok ? { type: 'subscribed', url: live.page.url() } : { type: 'error', reason: r.reason });
      }
      if (msg.type === 'unsubscribe') return void unsubscribe(pid, ws);
      if (msg.type === 'input') {
        if (!live) return send({ type: 'idle', reason: '浏览器已经关了' });
        await dispatchInput(live.page, pid, msg);
        return;
      }
      if (msg.type === 'nav') {
        // 人接手时的后退/刷新。⚠️ **不提供"输入地址"** —— 那等于给人开一条绕过
        // 出网闸的入口的错觉（其实闸在网络层照样拦，但不如不提供这个入口）。
        if (!live) return send({ type: 'idle', reason: '浏览器已经关了' });
        if (msg.action === 'back') await live.page.goBack({ timeout: 15000 }).catch(() => {});
        if (msg.action === 'reload') await live.page.reload({ timeout: 20000 }).catch(() => {});
        return send({ type: 'url', url: live.page.url() });
      }
      if (msg.type === 'release') {
        // 人点了「好了继续」→ 把等着的 agent 放走
        releaseHelp(pid, { url: live ? live.page.url() : null, by: 'human' });
        return send({ type: 'released' });
      }
    } catch (err) {
      send({ type: 'error', reason: err?.message || String(err) });
    }
  });

  const bye = () => { unsubscribe(pid, ws).catch(() => {}); };
  ws.on('close', bye);
  ws.on('error', bye);
  send({ type: 'hello', hasBrowser: !!peek(pid) });
}

/**
 * 挂在现有 httpServer 的 upgrade 分支上。
 * ⚠️ 现有 upgrade handler 对不匹配的路径**直接 404**，所以这条分支必须排在它前面。
 * @returns {{ matches: (pathname: string) => RegExpMatchArray|null, accept: Function }}
 */
export function createBrowseWS() {
  const wss = new WebSocketServer({ noServer: true });

  return {
    matches: (pathname) => pathname.match(BROWSE_WS_RE),
    accept(req, socket, head, m) {
      const pid = decodeURIComponent(m[1]);
      try { validateProjectId(pid); } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        return socket.destroy();
      }
      // 鉴权跟主通道同一套，也同一个 4401（外人不该分得清"没登录"和"不是你的项目"）
      const user = requestUser(req);
      const project = getProject(pid);
      if (!user || !userOwnsProject(user, project)) {
        return wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'unauthorized'));
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.binaryType = 'nodebuffer';
        handleConn(ws, pid);
      });
    },
  };
}
