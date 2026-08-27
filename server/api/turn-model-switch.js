import { guardProject, guardRunInProject, modelUserFor } from './_guard.js';
import { getSessionIdByRunId, getQuerySession } from '../engine/runs/active-runs.js';
import { getSessionMetaDir } from '../projects/workspace.js';
import { resolveSessionModel, defaultModel, writeSessionModelOverride } from '../engine/agent/session-model.js';
import { allowedModelsFor, isModelLockedFor, modelSwitchRejection, isSubscriptionLaneModel } from '../engine/agent/model-context.js';
import { piProviderModelFor, isEnvBundleModel } from '../engine/pi/model-map.js';

/**
 * server/api/turn-model-switch.js — 运行中热切模型（08-25 从 turn.js 拆出）。
 *
 * M1.5（2026-08-27）：pi-rp 有 `set_model` RPC（rpc-mode.ts:629，改 agent.state.model，
 * 下次 LLM 调用生效；pi 自己落 session JSONL model_change 条目）。热切恢复：
 *   1. 白名单 + 通路闸（原有，非法输入仍 403/400/409）
 *   2. 订阅行 403（三层防御口径，与 turn.js 一致）
 *   3. piProviderModelFor 反查 appModel → {provider, modelId}（wire 名）
 *   4. query.setModel(provider, modelId) —— 经 session-loop attach 的 shim 直通 rpc-client
 *   5. writeSessionModelOverride 落 .nd/<sid> 配置 —— pi 进程重启后 spawn 用新模型
 *
 * model-context.test.js 的 lint 用例钉着：本文件必须经 modelSwitchRejection 判断，
 * 不许自己直调两条底层闸。
 *
 * POST /api/projects/:pid/runs/:runId/model
 * Body: { model: string | null }  - null = 清掉覆盖回到全局默认
 */
export async function hotSwitchModelHandler(req, res, next) {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { model } = req.body || {};
    if (model !== null && model !== undefined && typeof model !== 'string') {
      return res.status(400).json({ error: 'model must be string or null' });
    }

    const wanted = typeof model === 'string' ? model.trim() : '';
    const target = wanted || defaultModel();

    // 白名单（与 PUT /sessions/:sid/model 同口径）
    if (wanted) {
      const modelUser = modelUserFor(req, project);   // 资格按项目 owner 算（_guard.js）
      if (isModelLockedFor(modelUser, wanted)) {
        return res.status(403).json({ error: '这个模型仅限 Pro 档，暂未对外开放', code: 'MODEL_LOCKED', model: wanted });
      }
      if (!isEnvBundleModel(wanted) && !allowedModelsFor(modelUser).some((m) => m.id === wanted)) {
        return res.status(400).json({ error: `unknown model: ${model}`, code: 'UNKNOWN_MODEL' });
      }
    }

    // 订阅行 403（与 turn.js 第一层同口径）：目标落在订阅行一律拒
    if (isSubscriptionLaneModel(target)) {
      return res.status(403).json({
        error: '订阅通道 M1 起禁用（引擎已换 pi-rp）',
        code: 'SUBSCRIPTION_LANE_M1_DISABLED',
        model: target,
      });
    }

    const sid = getSessionIdByRunId(runId);
    if (sid) {
      const cur = await resolveSessionModel(getSessionMetaDir(project.id, sid));
      // running:true = 除了协议闸还要过通路闸。会话必然跑过（能查到活的 run），hasHistory 默认 true
      const why = modelSwitchRejection({ from: cur.model, to: target, running: true });
      if (why) return res.status(409).json({ error: why, code: 'LANE_SWITCH' });
    }

    // 活会话 + RPC 直通。run 查得到 sid 但 session 没 attach（race / 已关）→ 404
    const qRec = sid ? getQuerySession(sid) : null;
    const query = qRec?.query;
    if (!query || typeof query.setModel !== 'function') {
      return res.status(404).json({ error: '没有活跃会话可热切（run 不在飞行中或会话已关）', code: 'RUN_NOT_ACTIVE' });
    }

    // appModel → pi wire 映射。白名单过了但清单没映射 = 配置缺口，fail-loud
    const wire = piProviderModelFor(target);
    if (!wire) {
      return res.status(502).json({ error: `模型 ${target} 没有 pi 上游路由（providers-models.json 缺映射）`, code: 'NO_UPSTREAM_ROUTE' });
    }

    const rpcRes = await query.setModel(wire.provider, wire.model);
    if (!rpcRes?.success) {
      return res.status(502).json({ error: `pi set_model 失败: ${rpcRes?.error ?? 'unknown'}`, code: 'PI_SET_MODEL_FAILED' });
    }

    // Nodesign 侧持久化：pi 进程重启后 spawn 从 .nd/<sid> 配置读模型。
    // wanted 为空（重置）→ 写 null 清覆盖，回落到 defaultModel()。
    // 不走 applySessionModel：它会 close 空闲 query，热切场景 run 在飞不需要这个副作用。
    try {
      await writeSessionModelOverride(getSessionMetaDir(project.id, sid), wanted || null);
    } catch (err) {
      // pi 侧已切成功，配置落盘失败只影响重启后的模型 —— 降级 warn，不 500
      console.warn(`[turn-model-switch] sid=${sid.slice(0, 8)} 模型配置落盘失败（pi 侧已切）:`, err.message);
    }

    return res.json({ ok: true, model: target, wire });
  } catch (err) { next(err); }
}
