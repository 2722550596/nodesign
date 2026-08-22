/**
 * server/api/local.js — 本地分发版专用接口（只在 NODESIGN_PROFILE=local 下挂载，见 index.js）。
 *
 *   GET  /api/local/status    profile / 数据目录 / 配置文件路径 / 插槽配置错误 / 版本
 *   GET  /api/local/config    原始配置 + 校验结果 + 表单要的枚举（配置页用）
 *   PUT  /api/local/config    保存（先校验；有错也存——用户可能在存半成品——但把 errors 回给页面标红）。
 *                             模型表是加载时冻结的，改动要 POST /restart 才生效，响应里 needsRestart 说这件事
 *   POST /api/local/restart   优雅退出并以 RESTART_EXIT_CODE 退，bin/nodesign.js 的 supervisor 拉起新进程
 *
 * 请求者恒为 LOCAL_OWNER（admin）；这里不再做权限判断——hosted 下整组路由不存在。
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { platform } from '../runtime/platform.js';
import { loadLocalConfig, saveLocalConfig, CONFIG_ENUMS } from '../runtime/local-config.js';
import { MODEL_CONFIG_ERRORS, EXTERNAL_SDK_ALIAS, UPSTREAMS } from '../engine/agent/model-context.js';
import { UPSTREAMS_BUILTIN } from '../engine/agent/model-table.js';

export const RESTART_EXIT_CODE = 75;

const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'));

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({
    profile: platform.profile,
    version: pkg.version,
    pid: process.pid,
    dataRoot: platform.dataRoot,
    configPath: loadLocalConfig().path,
    // 进程里**正在生效**的那份表报的错（文件现在可能已经改好但没重启）
    modelConfigErrors: MODEL_CONFIG_ERRORS,
    externalSdkAlias: EXTERNAL_SDK_ALIAS,
    // 内置上游（只报名字和是否配了钥匙，不报钥匙）：配置页提示「这些名字被占了」
    builtinUpstreams: Object.fromEntries(Object.entries(UPSTREAMS_BUILTIN).map(([id, u]) => [id, { label: u.label, keyPresent: u.authStyle === 'none' || !!(u.keyEnv && process.env[u.keyEnv]) }])),
  });
});

router.get('/config', (_req, res) => {
  const cfg = loadLocalConfig();
  res.json({ path: cfg.path, exists: cfg.exists, raw: cfg.raw || { upstreams: {}, models: [] }, errors: cfg.errors, enums: CONFIG_ENUMS,
    // 这份文件里的行此刻有没有在跑：与 MODELS 表对不上说明还没重启
    activeExternalModels: Object.keys(UPSTREAMS).filter((id) => UPSTREAMS[id].external) });
});

router.put('/config', (req, res) => {
  const raw = req.body;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: '配置必须是一个对象 { upstreams, models }' });
  }
  try {
    const v = saveLocalConfig(raw);
    res.json({ ok: true, path: v.path, errors: v.errors, needsRestart: true });
  } catch (err) {
    res.status(500).json({ error: `写配置失败：${err.message}` });
  }
});

router.post('/restart', (_req, res) => {
  res.json({ ok: true, note: '正在重启，几秒后刷新页面' });
  // 先把响应发出去再退
  setTimeout(() => process.emit('nodesign:restart'), 150);
});

export default router;
