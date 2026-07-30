/**
 * web/src/lib/ws-client.js — WebSocket 客户端，含指数退避重连 + replay-on-reconnect
 *
 * 用法：
 *   const ws = openProjectWS({ projectId, onEvent, onClose? });
 *   ws.close();   // 停止重连 + 关闭连接
 *
 * 行为：
 *   - 自动连 ws://<host>/ws/projects/:pid（重连时拼 ?since=<lastSeq>）
 *   - 收到 message → JSON.parse → onEvent(evt)；event.seq 单调递增 → 更新 lastSeq
 *   - close → 等 backoff 重连（1s → 2s → ... → 30s 上限）
 *   - 4xx/服务认为不该重连的 close code → 停止
 *   - 调用方 close() → 立即停止 + 不再重连
 *
 * 恢复协议（2026-07-27 重构：快照 + 尾随）：
 *   每次连接（含重连）server 都全量重建：ws.hydrate.*（已完成 turn 的 jsonl 历史）
 *   → ws.live_turn（进行中 turn 的物化快照）→ 实时流。客户端不再维护 ?since=
 *   游标 —— 老的 ring-buffer 回放对 token 级 streaming 几秒断线就 gap，靠不住。
 */

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

// WebSocket close codes 不应该重连的（真错误，不是网络断）
const FATAL_CLOSE_CODES = new Set([
  1008, // policy violation（含 server 主动拒）
  1011, // server error
  4401, // 自定义：未登录 / 项目不属于你（2026-07-30 多用户；server 握手后主动关）
  4404, // 自定义：project not found（如果将来 server 用 4xxx 段）
]);

export function openProjectWS({ projectId, onEvent, onClose, onStatusChange, getSid }) {
  let ws = null;
  let reconnectTimer = null;
  let backoff = MIN_BACKOFF_MS;
  let stopped = false;
  /** 是否成功连过一次 —— 只影响 UI 状态文案（connecting vs reconnecting） */
  let hasConnected = false;

  /** 'connecting' | 'open' | 'reconnecting' — 给 UI 显示连接状态 */
  function emitStatus(status) {
    try { onStatusChange?.(status); } catch { /* ignore */ }
  }

  function buildUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const base = `${proto}://${window.location.host}/ws/projects/${encodeURIComponent(projectId)}`;
    // 拼 sid 让 server 知道当前 session，连上后推 hydrate + live_turn 快照。
    // getSid 是 callback 让重连时能拿到最新 sid（避开闭包陈旧）。
    let sid = null;
    if (typeof getSid === 'function') {
      try { sid = getSid(); } catch { sid = null; }
    }
    return sid ? `${base}?sid=${encodeURIComponent(sid)}` : base;
  }

  /**
   * 关掉一条连接并**摘干净 handler**。
   *
   * 不摘会出幽灵连接（2026-07-28 真机复现的"正文重复"根因之一）：老 socket 的
   * onclose 是异步的，等它触发时 connect() 早就把新 socket 挂上了 —— 老 handler
   * 里那句 `ws = null` 清掉的是新 socket 的引用，紧接着 scheduleReconnect() 又开
   * 第三条。第二条没人引用但还开着，两条连接各推一份事件，前端就把同一段正文
   * 收两遍。每次切 session 都会踩一次。
   */
  function teardown(socket) {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch { /* ignore */ }
  }

  function connect() {
    if (stopped) return;

    emitStatus(hasConnected ? 'reconnecting' : 'connecting');
    let socket;
    try {
      socket = new WebSocket(buildUrl());
    } catch (err) {
      console.warn('[ws] WebSocket ctor threw:', err.message);
      scheduleReconnect();
      return;
    }
    ws = socket;

    // 所有 handler 先认领身份：socket !== ws 说明这条已经被换掉了，闭嘴
    // （teardown 摘 handler 之外的第二道保险，覆盖 close 事件已在队列里的情况）。
    socket.onopen = () => {
      if (socket !== ws) return;
      backoff = MIN_BACKOFF_MS;
      hasConnected = true;
      emitStatus('open');
    };

    socket.onmessage = (evt) => {
      if (socket !== ws) return;
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }
      try {
        onEvent?.(data);
      } catch (err) {
        console.warn('[ws] onEvent threw:', err);
      }
    };

    socket.onclose = (e) => {
      if (socket !== ws) return;
      ws = null;
      try { onClose?.(e); } catch { /* ignore */ }
      if (stopped) return;
      if (FATAL_CLOSE_CODES.has(e.code)) {
        // 永久错误 — 不重连
        stopped = true;
        emitStatus('closed');
        // 4401 = 身份失效/项目不属于你 → 广播给 AuthGate 切回登录页
        if (e.code === 4401) {
          try { window.dispatchEvent(new Event('nd:unauthorized')); } catch { /* */ }
        }
        return;
      }
      emitStatus('reconnecting');
      scheduleReconnect();
    };

    socket.onerror = (err) => {
      // onclose 会跟进；这里不重复重连
      console.warn('[ws] error:', err?.message || 'unknown');
    };
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      connect();
    }, backoff);
  }

  connect();

  return {
    close() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const old = ws;
      ws = null;
      teardown(old);
    },
    /**
     * session 切换时重连 WS（让 server 用新 sid 推 hydrate + live_turn 快照）。
     */
    reconnectForSession() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const old = ws;
      ws = null;
      teardown(old);
      backoff = MIN_BACKOFF_MS;
      connect();
    },
  };
}
