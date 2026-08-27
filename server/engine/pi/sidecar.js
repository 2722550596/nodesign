/**
 * server/engine/pi/sidecar.js — pi 引擎 MCP 子进程 → 主进程的桥（doc §5.3，M1 波次2 E2）。
 *
 * pi 引擎下工具跑在 standalone MCP 子进程里（server/engine/mcp/standalone.js），
 * 但三样东西只有主进程有权威副本：
 *   1. per-project EventBus（WS 推流）—— 工具 emit 的事件要进 bus；
 *   2. tier/quota 闸（真 DB + active-runs + rate-window，见 mcp/tools/tier-gate.js）；
 *   3. per-turn 计费（ctx.addToolCharge，context.js:292，折进本回合 modelUsage）。
 * 所以 standalone 的 ctx stub / gate 都走 HTTP 回主进程，挂 /__nd-sidecar。
 *
 * 鉴权（C3）：
 *   - secret：env NODESIGN_SIDECAR_SECRET 覆盖；缺则 per-boot 随机 32 字节（首次取用 warn 一次）。
 *   - sidToken(sid) = HMAC-SHA256(secret, sid).hex；lifecycle 把 token 经 NODESIGN_TOKEN
 *     注入子进程 env（C1），每请求 Authorization: Bearer <token> 与 body/query 的 sid 比对。
 *   - 只认 loopback 来源（子进程与主进程同机）；非 loopback 一律 403。
 *
 * 端点（JSON body，前缀由 server/index.js 挂载时给）：
 *   POST /emit       {sid, pid, event}      → getBus(pid).publish（富化对齐 AgentContext.emit）
 *   POST /tool-gate  {sid, pid, capability, toolName} → 主进程权威 tier/quota 判定（C8）
 *   POST /charge     {sid, name, usd}       → 活跃 turn 的 ctx.addToolCharge
 *   POST /ask        {sid, pid, questions}   → AskUserQuestion 长轮询（M2 方案 A）：
 *                                               登记挂起 + emit run.ask_user_question，
 *                                               阻塞到 /answer（turn.js）resolve 才返回
 */
import crypto from 'node:crypto';
import express from 'express';
import { getProjectBus } from '../../ws/broker.js';
import { getCurrentTurnRunId, getRun } from '../runs/active-runs.js';
import { tierDenial, ownerOfProject } from '../mcp/tools/tier-gate.js';
import { checkQuota } from '../../lib/quota.js';
import { DENIAL } from '../../auth/tier.js';
import { registerAsk, cancelAskById } from './ask-registry.js';

// ── secret / token ──

let secret = null;
let warnedRandom = false;

/** sidecar 共享密钥：env 覆盖优先；否则 per-boot 随机（生产应显式配，首次调用 warn 一次）。 */
export function getSidecarSecret() {
  const fromEnv = process.env.NODESIGN_SIDECAR_SECRET;
  if (fromEnv) return fromEnv;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    if (!warnedRandom) {
      warnedRandom = true;
      console.warn('[sidecar] NODESIGN_SIDECAR_SECRET 未设置 — 使用 per-boot 随机密钥（重启后子进程旧 token 全部失效；生产应显式配置）。');
    }
  }
  return secret;
}

/** sid → 子进程持有的 token（HMAC-SHA256 hex）。lifecycle spawn 时注入 NODESIGN_TOKEN。 */
export function sidToken(sid) {
  return crypto.createHmac('sha256', getSidecarSecret()).update(String(sid)).digest('hex');
}

/** 常量时间比对 token 与 sid 是否匹配。 */
export function verifySidToken(sid, token) {
  if (!sid || !token || typeof token !== 'string') return false;
  const expected = sidToken(sid);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── 公共闸 ──

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 所有端点共用的前置校验：loopback 来源 + Bearer token 与 sid 匹配。通过返 null，否则返 [status, body]。 */
function gate(req) {
  if (!LOOPBACK.has(req.socket.localAddress)) {
    return [403, { error: 'forbidden: loopback only' }];
  }
  const sid = req.body?.sid ?? req.query?.sid;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!sid || !verifySidToken(sid, token)) {
    return [401, { error: 'unauthorized' }];
  }
  return null;
}

// ── router ──

/**
 * 建 sidecar Router。getBus(pid) → EventBus，默认注入 ws/broker.js 的 getProjectBus；
 * 测试可注 stub 收集 publish。
 */
export function createSidecarRouter({ getBus = getProjectBus } = {}) {
  const router = express.Router();

  // POST /emit —— 工具事件进项目 bus。富化顺序对齐 AgentContext.emit（context.js:132）：
  // { runId, sessionId, ts, ...event } —— event 显式字段最后展开不被覆盖
  //（board.updated 会显式传 sessionId:null，必须保留）。
  router.post('/emit', (req, res) => {
    try {
      const denied = gate(req);
      if (denied) return res.status(denied[0]).json(denied[1]);
      const { sid, pid, event } = req.body || {};
      if (!event || typeof event !== 'object' || !event.type) {
        return res.status(400).json({ error: 'event.type required' });
      }
      const enriched = {
        runId: getCurrentTurnRunId(sid),
        sessionId: sid,
        ts: new Date().toISOString(),
        ...event,
      };
      getBus(pid).publish(enriched);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // POST /tool-gate —— 主进程权威闸（C8）：真 tierDenial（DB + can）+ imageGen 额外 checkQuota。
  // 逻辑照 withTierGate（tier-gate.js:71）；异常 fail-closed。
  router.post('/tool-gate', (req, res) => {
    try {
      const denied = gate(req);
      if (denied) return res.status(denied[0]).json(denied[1]);
      const { pid, capability, toolName } = req.body || {};
      try {
        const denial = tierDenial(pid, capability, toolName);
        if (denial) {
          return res.json({ allowed: false, denial: denial.content?.[0]?.text || `${toolName} denied` });
        }
        if (capability === 'imageGen') {
          const q = checkQuota(ownerOfProject(pid));
          if (!q.ok) {
            return res.json({ allowed: false, denial: `${toolName} denied: ${DENIAL.imageQuota}` });
          }
        }
        return res.json({ allowed: true });
      } catch {
        // fail-closed：档位校验自身炸了宁可拦，不放行花钱/越权的工具
        return res.json({ allowed: false, denial: `${toolName} denied: 档位校验失败，稍后再试。` });
      }
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // POST /charge —— 按件计费折进本回合账（context.js addToolCharge）。
  // 无活跃 run 不报错（计费丢失可接受，工具本身已成功）。
  router.post('/charge', (req, res) => {
    try {
      const denied = gate(req);
      if (denied) return res.status(denied[0]).json(denied[1]);
      const { sid, name, usd } = req.body || {};
      const runId = getCurrentTurnRunId(sid);
      const ctx = runId ? getRun(runId)?.ctx : null;
      if (!ctx?.addToolCharge) {
        return res.json({ ok: false, reason: 'no_active_run' });
      }
      ctx.addToolCharge(name, usd);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // POST /ask —— AskUserQuestion 长轮询（doc §5.3 方案 A）。pi 扩展 ask-user.ts 的
  // registerTool execute 里调：登记挂起 Promise → emit run.ask_user_question 给前端
  // → 阻塞等 answerAsk（turn.js /answer 路由）resolve。pi 工具 execute 无限阻塞合法
  //（agent-loop 裸 await 无超时），turn abort 经 cancelAsksForSession reject 收尾。
  router.post('/ask', async (req, res) => {
    try {
      const denied = gate(req);
      if (denied) return res.status(denied[0]).json(denied[1]);
      const { sid, pid, questions } = req.body || {};
      if (!questions || typeof questions !== 'object') {
        return res.status(400).json({ error: 'questions required' });
      }
      const runId = getCurrentTurnRunId(sid);
      const entry = registerAsk({ sid, runId, questions });
      if (!entry) {
        // 串行 turn 下理论不会并发 ask；真撞了说明状态机漏了，fail-loud 让模型重试
        return res.status(409).json({ error: 'an ask is already pending for this session' });
      }
      // HTTP 连接断（pi 进程被杀 / abort 链）→ 清挂起态，别留永远没人答的 ask。
      // 挂 res 而非 req：express.json 已消费完 body，req 的 'close' 早就发过了；
      // res 'close' 在连接终止（正常结束或提前断）时发。
      // （reject 的 unhandled 防护在 ask-registry 建 Promise 时已挂 noop catch）
      res.on('close', () => cancelAskById(entry.askId, 'ask_connection_closed'));
      try {
        getBus(pid).publish({
          type: 'run.ask_user_question',
          runId, sessionId: sid, askId: entry.askId, questions,
          ts: new Date().toISOString(),
        });
      } catch { /* bus 异常不弄死 ask：前端看不到问题会超时，好过静默挂死 */ }
      const answers = await entry.promise;   // reject → 走 catch 返 503
      return res.json({ ok: true, answers });
    } catch (err) {
      // 挂起被 cancel（run 取消 / session 关闭）→ 503，pi 侧 execute 抛错收尾
      return res.status(503).json({ error: String(err?.message || err) });
    }
  });

  // 其余路径 404
  router.use((_req, res) => res.status(404).json({ error: 'not found' }));

  return router;
}
