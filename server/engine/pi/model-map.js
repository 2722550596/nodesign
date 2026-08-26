/**
 * appModel → pi-rp 扩展 (provider, model) 映射（M1 换源 §5.4）。
 *
 * 数据源：server/engine/pi/extensions/providers-models.json —— 由
 * scripts/sync-pi-providers.mjs 从 providers.json + models.json 生成。
 * 形状：{ generatedAt, generatedFrom, providers: [...] }，providers 是**数组**，
 * 每个 provider 条目 { provider, name, baseUrl, keyEnv, authStyle, api, models: [...] }
 * （⚠️ 上游 key 在 `provider` 字段不是 `id`）；model 条目 { id(=wireModel), ...,
 * _appModels: [...] }。本模块把它倒排成 appModel → { provider, model } 索引：
 *   - provider = provider 条目的 `provider` 字段（pi-rp 扩展名，如 gmi / lament / nvidia）
 *   - model    = model 条目的 `id` 字段（wire 模型名，如 MiniMaxAI/MiniMax-M3）
 *
 * 同步读（readFileSync）：映射是进程级静态配置，每 session 启动读一次，文件 < 20KB；
 * ESM 顶层没有 __dirname，readFileSync 比 import assertions 省事。
 * 文件缺失 / 损坏 → 空索引（调用方拿到 null 走兜底），不抛。
 *
 * 注意：nvidia / zenGo 等 provider 条目带 `_unverified: true`（sync 脚本未做连通性
 * 验证，openai-completions best-effort）。本模块不做过滤 —— 反查命中照常返回，
 * 是否可用由调用方运行时发现（M1 已知缺口：无 wire 模型健康探测）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_MODELS_PATH = path.join(__dirname, 'extensions', 'providers-models.json');

/** appModel → { provider, model }；懒加载 + 缓存（进程生命周期内不变） */
let appModelIndex = null;

function loadIndex() {
  if (appModelIndex) return appModelIndex;
  appModelIndex = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(PROVIDERS_MODELS_PATH, 'utf8'));
    for (const prov of data?.providers ?? []) {
      const provider = prov?.provider;
      if (!provider) continue;
      for (const model of prov?.models ?? []) {
        const wireModel = model?.id;
        if (!wireModel) continue;
        for (const appModel of model?._appModels ?? []) {
          if (typeof appModel === 'string' && appModel && !appModelIndex.has(appModel)) {
            appModelIndex.set(appModel, { provider, model: wireModel });
          }
        }
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
 */
export function piProviderModelFor(appModel) {
  if (typeof appModel !== 'string' || !appModel) return null;
  return loadIndex().get(appModel) ?? null;
}

/** 测试钩子：清缓存强制重读文件 */
export function _resetModelMapCache() {
  appModelIndex = null;
}
