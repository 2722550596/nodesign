import { guardProject, guardRunInProject, modelUserFor } from './_guard.js';
import { getSessionIdByRunId } from '../engine/runs/active-runs.js';
import { getSessionMetaDir } from '../projects/workspace.js';
import { resolveSessionModel, defaultModel } from '../engine/agent/session-model.js';
import { allowedModelsFor, isModelLockedFor, modelSwitchRejection } from '../engine/agent/model-context.js';

/**
 * server/api/turn-model-switch.js — 运行中热切模型（08-25 从 turn.js 拆出）。
 *
 * M1 换源后**整体 501**：热切靠的是 SDK query.setModel，pi-rp RPC 没有对应命令
 * （set_preset 是另一回事，M2 再评）。路由骨架（白名单 + 协议/通路闸）保留 ——
 * 非法输入仍按原契约回 403/400/409，合法输入才落到 501，前端能分清"模型不对"
 * 和"功能暂不可用"。model-context.test.js 的 lint 用例钉着：本文件必须经
 * modelSwitchRejection 判断，不许自己直调两条底层闸。
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

    // 白名单（与 PUT /sessions/:sid/model 同口径）—— 非法名不该拿到 501
    if (wanted) {
      const modelUser = modelUserFor(req, project);   // 资格按项目 owner 算（_guard.js）
      if (isModelLockedFor(modelUser, wanted)) {
        return res.status(403).json({ error: '这个模型仅限 Pro 档，暂未对外开放', code: 'MODEL_LOCKED', model: wanted });
      }
      if (!allowedModelsFor(modelUser).some((m) => m.id === wanted)) {
        return res.status(400).json({ error: `unknown model: ${model}`, code: 'UNKNOWN_MODEL' });
      }
    }
    const sidForLane = getSessionIdByRunId(runId);
    if (sidForLane) {
      const cur = await resolveSessionModel(getSessionMetaDir(project.id, sidForLane));
      // running:true = 除了协议闸还要过通路闸。会话必然跑过（能查到活的 run），hasHistory 默认 true
      const why = modelSwitchRejection({ from: cur.model, to: target, running: true });
      if (why) return res.status(409).json({ error: why, code: 'LANE_SWITCH' });
    }

    // M1：pi-rp 没有运行中换模型的 RPC（SDK query.setModel 的对应物不存在）
    return res.status(501).json({
      error: '运行中热切模型 M1 暂不支持（引擎已换 pi-rp）。等这轮跑完，在模型选择器里换',
      code: 'M1_NOT_SUPPORTED',
    });
  } catch (err) { next(err); }
}
