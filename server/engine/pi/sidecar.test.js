/**
 * sidecar（pi MCP 子进程 → 主进程桥）回归：
 *   - sidToken/verifySidToken：同 sid 稳定、异 sid / 空 / 错 token 不通过
 *   - HTTP 层（真 express + fetch 打 loopback）：无 token / 错 token → 401
 *   - /emit：富化顺序对齐 AgentContext.emit —— {runId, sessionId, ts, ...event}，
 *     event 显式字段不被覆盖（board.updated 的 sessionId:null 保留）；无活跃 turn runId=null；
 *     有活跃 turn 时 runId=getCurrentTurnRunId；event.type 缺失 → 400
 *   - /tool-gate：不存在的 pid → getProject null → owner null → can(null)=false → deny（fail-closed 形状）
 *   - /charge：无活跃 run → {ok:false, reason:'no_active_run'}；有活跃 run → ctx.addToolCharge 收到
 *   - 未知路径 404
 *   - sidecar-client：emit/charge 失败不抛；toolGate 失败 fail-closed
 * 不碰生产库：tier-gate 用例 pid 用不存在的 id；DB_PATH 由 vitest.server.config.js 指 tmp。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createSidecarRouter, sidToken, verifySidToken } from './sidecar.js';
import { createSidecarClient } from './sidecar-client.js';
import {
  registerQuerySession, unregisterQuerySession, setCurrentTurnRunId,
  registerRun, unregisterRun,
} from '../runs/active-runs.js';

// 固定 secret：走 env 覆盖分支，测试确定性（也顺带覆盖 env 优先逻辑）
process.env.NODESIGN_SIDECAR_SECRET = 'test-sidecar-secret';

const SID = 'sess_sidecar_t1';
const PID = 'proj_nonexistent_xyz';
const TOKEN = sidToken(SID);

// ── 起真 express 挂 router；stub getBus 收集 publish ──
const published = [];
const stubBus = { publish: (e) => published.push(e) };
const app = express();
app.use(express.json());
app.use('/__nd-sidecar', createSidecarRouter({ getBus: () => stubBus }));

let server;
let base;

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/__nd-sidecar`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function post(pathname, body, { token = TOKEN, sid = SID } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST', headers, body: JSON.stringify({ sid, pid: PID, ...body }),
  });
  return { status: res.status, data: await res.json() };
}

// ── token 单元 ──

describe('sidToken / verifySidToken', () => {
  it('同 sid 稳定', () => {
    expect(sidToken(SID)).toBe(sidToken(SID));
    expect(sidToken(SID)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('异 sid 不通过', () => {
    expect(verifySidToken('sess_other', sidToken(SID))).toBe(false);
  });
  it('空 / 错 token 不通过', () => {
    expect(verifySidToken(SID, '')).toBe(false);
    expect(verifySidToken(SID, null)).toBe(false);
    expect(verifySidToken(SID, 'f'.repeat(64))).toBe(false);
  });
  it('正确 token 通过', () => {
    expect(verifySidToken(SID, TOKEN)).toBe(true);
  });
});

// ── 鉴权闸 ──

describe('鉴权', () => {
  it('无 token → 401', async () => {
    const { status } = await post('/emit', { event: { type: 'x' } }, { token: null });
    expect(status).toBe(401);
  });
  it('错 token → 401', async () => {
    const { status } = await post('/emit', { event: { type: 'x' } }, { token: 'bad' });
    expect(status).toBe(401);
  });
  it('token 与 sid 不匹配 → 401', async () => {
    const { status } = await post('/emit', { event: { type: 'x' } }, { sid: 'sess_other', token: TOKEN });
    expect(status).toBe(401);
  });
});

// ── /emit ──

describe('POST /emit', () => {
  it('富化顺序对齐 AgentContext.emit：runId=null（无活跃 turn）、sessionId、ts、显式字段不被覆盖', async () => {
    const { status, data } = await post('/emit', {
      event: { type: 'board.updated', boardId: 'b1', sessionId: null },
    });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });

    const e = published.at(-1);
    expect(e.type).toBe('board.updated');
    expect(e.runId).toBeNull();          // 无活跃 turn
    expect(e.sessionId).toBeNull();      // ⭐ 显式 sessionId:null 保留（...event 最后展开）
    expect(e.boardId).toBe('b1');
    expect(typeof e.ts).toBe('string');
    expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
  });

  it('有活跃 turn 时 runId = getCurrentTurnRunId', async () => {
    const token = registerQuerySession(SID, { abortController: new AbortController(), inputQueue: { close() {} } });
    expect(token).not.toBe(false);
    setCurrentTurnRunId(SID, 'run_sidecar_1');
    try {
      const { status } = await post('/emit', { event: { type: 'tool.ping' } });
      expect(status).toBe(200);
      const e = published.at(-1);
      expect(e.runId).toBe('run_sidecar_1');
      expect(e.sessionId).toBe(SID);     // 未显式覆盖 → enrich 值
    } finally {
      unregisterQuerySession(SID);
    }
  });

  it('event.type 缺失 → 400', async () => {
    const { status } = await post('/emit', { event: { foo: 1 } });
    expect(status).toBe(400);
  });
});

// ── /tool-gate ──

describe('POST /tool-gate', () => {
  it('不存在的 pid → owner null → can(null)=false → deny（fail-closed 形状）', async () => {
    const { status, data } = await post('/tool-gate', { capability: 'webSearch', toolName: 'web_search' });
    expect(status).toBe(200);
    expect(data.allowed).toBe(false);
    expect(typeof data.denial).toBe('string');
    expect(data.denial).toContain('web_search denied');
  });

  it('imageGen 同路径 deny（项目不存在，tier 先拦）', async () => {
    const { data } = await post('/tool-gate', { capability: 'imageGen', toolName: 'generate_image' });
    expect(data.allowed).toBe(false);
    expect(data.denial).toContain('generate_image denied');
  });
});

// ── /charge ──

describe('POST /charge', () => {
  it('无活跃 run → {ok:false, reason:"no_active_run"}（不报错）', async () => {
    const { status, data } = await post('/charge', { name: 'generate_image', usd: 0.2 });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: false, reason: 'no_active_run' });
  });

  it('有活跃 run → ctx.addToolCharge 收到 name/usd', async () => {
    const charges = [];
    const fakeCtx = { addToolCharge: (name, usd) => charges.push([name, usd]) };
    registerQuerySession(SID, { abortController: new AbortController(), inputQueue: { close() {} } });
    setCurrentTurnRunId(SID, 'run_sidecar_charge');
    registerRun('run_sidecar_charge', { abortController: new AbortController(), ctx: fakeCtx });
    try {
      const { status, data } = await post('/charge', { name: 'generate_image', usd: 0.2 });
      expect(status).toBe(200);
      expect(data).toEqual({ ok: true });
      expect(charges).toEqual([['generate_image', 0.2]]);
    } finally {
      unregisterRun('run_sidecar_charge');
      unregisterQuerySession(SID);
    }
  });
});

// ── 404 ──

describe('未知路径', () => {
  it('404', async () => {
    const res = await fetch(`${base}/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sid: SID }),
    });
    expect(res.status).toBe(404);
  });
});

// ── sidecar-client ──

describe('sidecar-client', () => {
  it('正常路径：emit/toolGate/charge 打真 router', async () => {
    const client = createSidecarClient({ baseUrl: base, token: TOKEN, sid: SID, pid: PID });
    await client.emit({ type: 'client.ping', n: 7 });
    expect(published.at(-1)).toMatchObject({ type: 'client.ping', n: 7, sessionId: SID });

    const gate = await client.toolGate('webSearch', 'web_search');
    expect(gate.allowed).toBe(false);   // 项目不存在 → deny
    expect(typeof gate.denial).toBe('string');

    const chargeRes = await client.charge('generate_image', 0.2);
    expect(chargeRes).toBeUndefined();  // 无活跃 run 也不抛
  });

  it('server 不可达：emit/charge 不抛；toolGate fail-closed', async () => {
    const dead = createSidecarClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, sid: SID, pid: PID });
    await expect(dead.emit({ type: 'x' })).resolves.toBeUndefined();
    await expect(dead.charge('x', 1)).resolves.toBeUndefined();
    const gate = await dead.toolGate('imageGen', 'generate_image');
    expect(gate.allowed).toBe(false);
    expect(gate.denial).toContain('sidecar 不可用');
  });
});
