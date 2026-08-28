/**
 * appModel → pi-rp 扩展 (provider, model) 映射（M1 换源 §5.4；M3a 改读 models.json）。
 *
 * 数据源：server/engine/agent/models.json —— 模型层唯一真相源（M3a 起无生成链，
 * 手编辑）。本模块遍历其中带 .api 的行，直接建 appModel → { provider, model } 索引：
 *   - provider = row.api.upstream（pi-rp 扩展名，如 gmi / lament / nvidia；
 *     与 extensions/providers.ts 的 registerProvider 名同源）
 *   - model    = row.api.wireModel（wire 模型名，如 MiniMaxAI/MiniMax-M3）
 * 同一 wireModel 的多行（ox-alpha 三行）各自按 id 进索引，不再需要旧 manifest 的
 * _appModels 倒排。外部插槽（config.json）的行也并进索引（M3a A7，见 loadIndex）。
 * 文件缺失 / 损坏 → 空索引（调用方拿到 null 走兜底），不抛。
 *
 * 注意：nvidia / zenGo 等上游的 openai-completions 映射是 best-effort（providers.ts
 * mapApi 的 _unverified 备注）。本模块不做过滤 —— 反查命中照常返回，是否可用由
 * 调用方运行时发现（M1 已知缺口：无 wire 模型健康探测）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from '../../runtime/local-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_JSON_PATH = path.join(__dirname, '..', 'agent', 'models.json');

/** appModel → { provider, model }；懒加载 + 缓存（进程生命周期内不变） */
let appModelIndex = null;

function loadIndex() {
  if (appModelIndex) return appModelIndex;
  appModelIndex = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    for (const row of data?.models ?? []) {
      if (!row?.api) continue;   // 订阅行无 .api，不进 pi provider
      const appModel = row.id;
      const provider = row.api.upstream;
      const wireModel = row.api.wireModel;
      if (!appModel || !provider || !wireModel) continue;
      if (!appModelIndex.has(appModel)) {
        appModelIndex.set(appModel, { provider, model: wireModel });
      }
    }
    // 外部插槽（M3a A7）：config.json 的行也要能反查 —— providers.ts 把外部 provider
    // 注册成 provider 名 = upstream key（见其外部插槽段），服务端反查必须同口径命中，
    // 否则 session-loop init 仍抛「没有 pi-rp 扩展映射」（M1 起 INIT_FAILED 回归的另一半）。
    // hosted profile 下 loadLocalConfig 返空配置，循环 no-op。
    const ext = loadLocalConfig();
    for (const m of ext.models) {
      if (m?.id && m?.upstream && m?.wireModel && !appModelIndex.has(m.id)) {
        appModelIndex.set(m.id, { provider: m.upstream, model: m.wireModel });
      }
    }
  } catch {
    // 文件缺失 / JSON 损坏 → 空索引；piProviderModelFor 全部返回 null
  }
  return appModelIndex;
}

/**
 * appModel → pi-rp 扩展模型映射。
 * @param {string} appModel - app 侧模型 id（如 'minimax-m3'）
 * @returns {{provider: string, model: string} | null} 无映射返回 null
 *   （订阅模型查不到 → 调用方抛错；M1 订阅通道禁用，见 model-context.js）
 *
 * M1.5 env 全家桶 fallback：models.json 没命中且 appModel === NODESIGN_MODEL 且
 * NODESIGN_BASE_URL + NODESIGN_KEY 都配了 → 返回 custom provider 映射。
 * 与 extensions/providers.ts 的 custom provider 注册同口径（provider='custom'，
 * wireModel = NODESIGN_MODEL 原值）。
 */
export function piProviderModelFor(appModel) {
  if (typeof appModel !== 'string' || !appModel) return null;
  const hit = loadIndex().get(appModel);
  if (hit) return hit;
  // env 全家桶 fallback（清单优先，没匹配才走这里）
  const customModel = process.env.NODESIGN_MODEL?.trim();
  if (customModel && appModel === customModel
      && process.env.NODESIGN_BASE_URL && process.env.NODESIGN_KEY) {
    return { provider: 'custom', model: customModel };
  }
  return null;
}

/**
 * 这个 appModel 是不是「env 全家桶 fallback」模型（M1.5）。
 * 判据与 piProviderModelFor 的 fallback 分支完全同口径：NODESIGN_MODEL 命中、
 * BASE_URL + KEY 都配了、且 models.json 没覆盖。turn.js 的白名单闸用它放行，
 * 避免自定义上游模型被 allowedModelsFor 403 掉。
 * @param {string} appModel
 * @returns {boolean}
 */
export function isEnvBundleModel(appModel) {
  if (typeof appModel !== 'string' || !appModel) return false;
  const customModel = process.env.NODESIGN_MODEL?.trim();
  return !!customModel && appModel === customModel
    && !!process.env.NODESIGN_BASE_URL && !!process.env.NODESIGN_KEY
    && !loadIndex().has(appModel);
}

/** 测试钩子：清缓存强制重读文件 */
export function _resetModelMapCache() {
  appModelIndex = null;
}
