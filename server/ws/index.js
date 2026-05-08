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
import {
  getCurrentTurnRunId,
  hasActiveQuerySession,
  closeQuerySession,
  markSessionActivity,
} from '../engine/runs/active-runs.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HYDRATE_CHUNK_SIZE = 50;
const GLOBAL_CLAUDE_CONFIG_DIR = platform.claudeConfigDir;

/**
 * WS 全部断开后再 N ms 仍无重连 → closeQuerySession 让 SDK subprocess 退出，
 * 防止用户关 tab / 刷新后服务器孤儿 SDK process 永久占内存（每个 ~250MB RSS）。
 *
 * 默认 60s 给前端 ws-client.js exponential backoff（1s→2s→...→30s）足够重连窗口。
 * env NODESIGN_WS_GRACE_MS 可调（生产可拉到 5min 给移动端弱网）。
 */
const WS_GRACE_MS = Number(process.env.NODESIGN_WS_GRACE_MS) || 60_000;

/**
 * sid → { count: 当前活跃 WS 连接数, graceTimer: 0 引用时启动的关闭定时器 }
 *
 * 每条带 sid 的 WS 连接 ref++，close 时 ref--；归零启 grace timer，N ms 内有新 WS
 * 进同 sid 立即清 timer 续命；timer 到期再确认 0 ref 后 closeQuerySession。
 *
 * /work 路径（无 sid）的 WS 不进 sessionRefs（无 session 可绑）。
 */
const sessionRefs = new Map();

function refSession(sid) {
  if (!sid) return;
  let entry = sessionRefs.get(sid);
  if (!entry) {
    entry = { count: 0, graceTimer: null };
    sessionRefs.set(sid, entry);
  }
  entry.count += 1;
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  // WS 连上算一次活跃信号（idle scan 不会立即把刚连的 session 当僵尸关掉）
  markSessionActivity(sid);
}

function unrefSession(sid) {
  if (!sid) return;
  const entry = sessionRefs.get(sid);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  if (entry.count > 0) return;
  // 0 ref → 启 grace timer。若 grace 期内有新 WS 进同 sid，refSession 会清掉 timer
  if (entry.graceTimer) clearTimeout(entry.graceTimer);
  entry.graceTimer = setTimeout(() => {
    const cur = sessionRefs.get(sid);
    if (!cur || cur.count > 0) return;  // 期间有新连上，不关
    sessionRefs.delete(sid);
    if (hasActiveQuerySession(sid)) {
      console.info(`[ws] grace expired for sid=${sid.slice(0, 8)}, closing session (no_active_subscriber)`);
      closeQuerySession(sid, 'no_active_subscriber');
    }
  }, WS_GRACE_MS);
  entry.graceTimer.unref?.();
}

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
  const t0 = Date.now();
  try {
    const sessionRoot = getSessionWorkspace(pid, sid);
    const messages = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
      getSessionMessages(sid, { dir: sessionRoot, includeSystemMessages: false }),
    );
    if (ws.readyState !== ws.OPEN) return;
    const total = messages.length;
    console.info(`[ws] hydrate sid=${sid.slice(0, 8)} loaded ${total} messages in ${Date.now() - t0}ms`);
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

  // 诊断 log：用户重启服务器后报"前端收不到事件"——这条 log 让 pm2 logs 一眼看出
  // WS 是不是真连上 + 客户端传的 sid 跟 server 端 active session 状态对不对。
  console.info(
    `[ws] connect pid=${pid} sid=${sid ? sid.slice(0, 8) : 'none'} `
    + `hasActiveSession=${sid ? hasActiveQuerySession(sid) : 'n/a'} since=${since}`,
  );

  // sid lifecycle ref：带 sid 的 WS 连上即 ref++，close/error 时 unref。0 ref 触发
  // grace timer N ms 后 closeQuerySession 让 SDK subprocess 自然退出。
  refSession(sid);

  // hydrate 起点 seq：sendHydrate 是 await 异步（拉 jsonl + chunk send，100~500ms），
  // 期间若 agent 推 run.delta.* 进 bus，listener 还没 attach → 事件丢失（jsonl 是
  // turn 边界 flush，hydrate 拍到的不含中间 deltas）。用起点 seq 作为 subscribeFromSeq
  // 的 since 让它 replay hydrate 期间产生的 live event，覆盖时间差漏洞。
  const seqAtHydrateStart = bus._seq || 0;
  const shouldHydrateFirst = !!sid && since === 0;
  if (shouldHydrateFirst) {
    await sendHydrate(ws, pid, sid, seqAtHydrateStart);
  }

  // subscribeFromSeq 同步先 replay buffer 里 seq > since 的，然后切 live。
  // listener 抛错被 EventBus 内部吞 + warn —— ws.send 失败也只是 warn 不抛，避免影响别人。
  //
  // since=0 + hydrate 路径走 hydrate 起点 seq；其他场景沿用 client 传的 since。
  // hydrate 拿 jsonl 快照 + replay 拿 hydrate 期间中间 deltas，两者无重叠不重复推送。
  //
  // sid 过滤：projectBuses 是 per-project 共享，多 session 同时跑时 bus 上有跨 session
  // 事件交错。带 sid 的 WS 只推 event.sessionId === sid 的事件 + event.sessionId 缺失
  // 的"全局事件"（兼容老事件 / ws.* 控制帧）。无 sid 的 WS（/work 路径）保持原样收全部。
  const subscribeSince = shouldHydrateFirst ? seqAtHydrateStart : since;
  const { unsubscribe, replayed, gap } = bus.subscribeFromSeq(subscribeSince, (event) => {
    if (sid && event.sessionId && event.sessionId !== sid) return;
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

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    unsubscribe();
    unrefSession(sid);
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
