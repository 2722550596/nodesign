/**
 * server/engine/agent/models-json.js — models.json 加载器（M3a：模型层唯一真相源）。
 *
 * 08-28 起内置模型表与上游注册表住在同目录 models.json（手编辑，无生成链）。
 * 本模块把它读成三个导出：
 *   UPSTREAMS_BUILTIN / MODELS_BUILTIN / BRANDS
 *
 * 加载期做两件 model-table.js 时代由 JS 表达式做的事：
 *  1. baseUrl env 覆盖：upstream 条目带 baseUrlEnv 时，process.env[baseUrlEnv] 有值就
 *     覆盖 baseUrl（旧表里 `process.env.X || 'default'` 的等价物；只给探针用，生产不设）。
 *  2. deepFreeze：旧表是 Object.freeze 的，消费方（model-context.js 的合并/断言）依赖
 *     冻结语义，这里补上。
 *
 * 同步读（readFileSync）：进程级静态配置，<20KB，每进程读一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_JSON_PATH = path.join(__dirname, 'models.json');

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    Object.values(obj).forEach(deepFreeze);
  }
  return obj;
}

const raw = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));

// baseUrl env 覆盖（见文件头）：baseUrlEnv 声明且 env 有值 → 用 env 值，否则用表内默认。
const UPSTREAMS_BUILTIN = deepFreeze(Object.fromEntries(
  Object.entries(raw.upstreams).map(([key, up]) => [key, {
    ...up,
    baseUrl: (up.baseUrlEnv && process.env[up.baseUrlEnv]) || up.baseUrl,
  }])
));

const MODELS_BUILTIN = deepFreeze(raw.models);
const BRANDS = deepFreeze(raw.brands);

export { UPSTREAMS_BUILTIN, MODELS_BUILTIN, BRANDS };
