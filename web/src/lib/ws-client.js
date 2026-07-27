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

  function connect() {
    if (stopped) return;

    emitStatus(hasConnected ? 'reconnecting' : 'connecting');
    try {
      ws = new WebSocket(buildUrl());
    } catch (err) {
      console.warn('[ws] WebSocket ctor threw:', err.message);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoff = MIN_BACKOFF_MS;
      hasConnected = true;
      emitStatus('open');
    };

    ws.onmessage = (evt) => {
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

    ws.onclose = (e) => {
      ws = null;
      try { onClose?.(e); } catch { /* ignore */ }
      if (stopped) return;
      if (FATAL_CLOSE_CODES.has(e.code)) {
        // 永久错误 — 不重连
        stopped = true;
        emitStatus('closed');
        return;
      }
      emitStatus('reconnecting');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
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
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    },
    /**
     * session 切换时重连 WS（让 server 用新 sid 推 hydrate + live_turn 快照）。
     */
    reconnectForSession() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
      backoff = MIN_BACKOFF_MS;
      connect();
    },
  };
}
