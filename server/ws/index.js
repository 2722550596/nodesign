/**
 * server/ws/index.js — WebSocket 升级入口
 *
 * URL 模式：/ws/projects/:pid
 *
 * 流程：
 *   1. http server 'upgrade' 事件触发
 *   2. parse URL 取 pid
 *   3. validateProjectId + getProject 校验存在
 *   4. wss.handleUpgrade → 拿到 ws 对象
 *   5. 订阅该 project 的 EventBus，事件 JSON.stringify 推 ws.send
 *   6. ping/pong 30s 心跳
 *   7. ws close → unsubscribe + clearInterval
 */

import { WebSocketServer } from 'ws';
import { URL } from 'url';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { validateProjectId, getProject } from '../projects/store.js';
import { getSessionWorkspace, validateSessionId } from '../projects/workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';
import { platform } from '../runtime/platform.js';
import { getProjectBus } from './broker.js';
import { getCurrentTurnRunId } from '../engine/runs/active-runs.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HYDRATE_CHUNK_SIZE = 50;
const GLOBAL_CLAUDE_CONFIG_DIR = platform.claudeConfigDir;

export function setupWS(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://x');
    } catch {
      return socket.destroy();
    }

    const m = url.pathname.match(/^\/ws\/projects\/([^/]+)$/);
    if (!m) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }

    const pid = decodeURIComponent(m[1]);
    try {
      validateProjectId(pid);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }

    if (!getProject(pid)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }

    // ?since=N — 客户端最后看到的 EventBus seq；server 通过 buffer 回放 (since, _seq] 段
    // 第一次连不带 since → since=0 → 不 replay 直接 live。
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw != null ? Math.max(0, parseInt(sinceRaw, 10) || 0) : 0;

    // Phase A.4：?sid=<sessionId> — 客户端当前在哪个 session 上，server 在 first connect /
    // gap 时推 ws.hydrate.* 帧补完整 messages。无 sid 时（/work 路径）跳过 hydrate
    // 直接 replay+live。
    let sid = url.searchParams.get('sid');
    if (sid) {
      try { validateSessionId(sid); }
      catch { sid = null; }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleProjectWS(ws, pid, since, sid);
    });
  });

  return wss;
}

/**
 * Phase A.4：推 ws.hydrate.start/chunk/end 帧把 jsonl 历史 messages 同步给前端。
 * 必须在 subscribeFromSeq 之前发，确保前端先 hydrate 后 apply replay/live events。
 *
 * 失败 fail-soft：发 ws.hydrate.start 带 kind:'error'，让前端兜底用 HTTP Sessions.read。
 *
 * @returns {Promise<void>}
 */
async function sendHydrate(ws, pid, sid, asOfSeq) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    const sessionRoot = getSessionWorkspace(pid, sid);
    const messages = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
      getSessionMessages(sid, { dir: sessionRoot, includeSystemMessages: false }),
    );
    if (ws.readyState !== ws.OPEN) return;
    const total = messages.length;
    ws.send(JSON.stringify({
      type: 'ws.hydrate.start',
      sessionId: sid,
      total,
      asOfSeq,
      ts: new Date().toISOString(),
    }));
    for (let i = 0; i < total; i += HYDRATE_CHUNK_SIZE) {
      if (ws.readyState !== ws.OPEN) return;
      const chunk = messages.slice(i, i + HYDRATE_CHUNK_SIZE);
      ws.send(JSON.stringify({
        type: 'ws.hydrate.chunk',
        sessionId: sid,
        chunkIdx: Math.floor(i / HYDRATE_CHUNK_SIZE),
        messages: chunk,
      }));
    }
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      type: 'ws.hydrate.end',
      sessionId: sid,
      total,
    }));
  } catch (err) {
    console.warn(`[ws] hydrate failed for ${pid}/${sid}:`, err.message);
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'ws.hydrate.start',
          sessionId: sid,
          kind: 'error',
          error: err.message,
        }));
      } catch { /* ignore */ }
    }
  }
}

async function handleProjectWS(ws, pid, since = 0, sid = null) {
  const bus = getProjectBus(pid);

  // Phase A.4：先 hydrate（仅当 sid 给了 + (since=0 或 gap)）；后 subscribe replay+live。
  // since>0 且 buffer 完整覆盖时跳过 hydrate（当作 reconnect 续连，replay 即可）。
  // 这里先用 since===0 触发 hydrate；gap 情况由 subscribeFromSeq 后判断（见下面 if (sid && gap)）。
  const shouldHydrateFirst = !!sid && since === 0;
  if (shouldHydrateFirst) {
    await sendHydrate(ws, pid, sid, bus._seq || 0);
  }

  // subscribeFromSeq 同步先 replay buffer 里 seq > since 的，然后切 live。
  // listener 抛错被 EventBus 内部吞 + warn —— ws.send 失败也只是 warn 不抛，避免影响别人。
  const { unsubscribe, replayed, gap } = bus.subscribeFromSeq(since, (event) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(event));
      } catch (err) {
        console.warn(`[ws] send failed for ${pid}:`, err.message);
      }
    }
  });

  // Phase A.4：since>0 但 gap=true（buffer 挤掉 / server 重启）→ 补 hydrate
  // gap 时新 listener 已经 attach 了 live 事件流，但 buffer 中 seq > since 部分被挤掉，
  // 必须重新 hydrate 拿当前 messages 完整状态。hydrate 帧排在 ws.connected 之前。
  if (sid && !shouldHydrateFirst && gap) {
    await sendHydrate(ws, pid, sid, bus._seq || 0);
  }

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch { /* will close */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`[ws] error for ${pid}:`, err.message);
    cleanup();
  });

  // 确认 + replay 元信息（gap=true 客户端可决定全量 hydrate）。
  // 故意放在 replay 之后发：客户端看到 ws.connected 就知道 backlog 已 drain，可切回正常 live 状态。
  //
  // activeRunId：sid 上当前在跑的 turn runId（无则 null）。前端用它重连后恢复
  // isStreaming/currentRunId —— 否则 WS 抖动期间 run.start 已发完且 buffer 没新事件
  // 时，前端永远不知道 run 还活着（stop 按钮消失，UX 表现"流没了"）。
  const activeRunId = sid ? getCurrentTurnRunId(sid) : null;
  try {
    ws.send(JSON.stringify({
      type: 'ws.connected',
      projectId: pid,
      ts: new Date().toISOString(),
      since,
      replayed,
      gap,
      activeRunId,
    }));
  } catch { /* immediate close edge */ }
}
