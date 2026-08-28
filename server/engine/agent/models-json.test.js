/**
 * models.json + models-json.js 加载器钉子（M3a：模型层唯一真相源）。
 *
 * 这张表写错一个字的历史下场是"两处静默降级没人报错"（model-context.js 文件头原话）。
 * 派生断言（brand/upstream/alias 撞车）在 model-context.js 加载时炸；这里钉的是
 * models.json 自身的形状与加载器的 env 覆盖语义。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAMS_BUILTIN, MODELS_BUILTIN, BRANDS } from './models-json.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(here, 'models.json'), 'utf8'));

describe('models.json 形状', () => {
  it('加载成功 + schemaVersion === 1', () => {
    expect(raw.schemaVersion).toBe(1);
    expect(Array.isArray(raw.models)).toBe(true);
    expect(raw.models.length).toBeGreaterThan(0);
    expect(typeof raw.upstreams).toBe('object');
    expect(Array.isArray(raw.brands)).toBe(true);
  });

  it('每个 model 的 brand ∈ brands（声明不推断，拼错加载时炸）', () => {
    for (const m of raw.models) {
      expect(raw.brands, `${m.id} 的 brand '${m.brand}' 不在 brands 里`).toContain(m.brand);
    }
  });

  it('每个有 api 的 model 的 upstream ∈ upstreams', () => {
    for (const m of raw.models) {
      if (!m.api) continue;
      expect(Object.keys(raw.upstreams), `${m.id} 指向不存在的 upstream '${m.api.upstream}'`).toContain(m.api.upstream);
    }
  });

  it('select.default 至多一行（全员默认模型只能有一个）', () => {
    const defaults = raw.models.filter((m) => m.select?.default);
    expect(defaults.length).toBeLessThanOrEqual(1);
  });

  it('M3b 订阅通道删除：没有 sharedSdkAlias 字段，也没有无 api 的订阅行', () => {
    expect(raw.sharedSdkAlias).toBeUndefined();
    for (const m of raw.models) {
      expect(m.api, `${m.id} 缺 api —— 订阅行应已删光`).toBeDefined();
    }
  });
});

describe('models-json.js 加载器', () => {
  it('导出与旧 model-table.js 同名同值（消费方只改 import 路径；SHARED_SDK_ALIAS 随 M3b 退役）', () => {
    expect(MODELS_BUILTIN.length).toBe(raw.models.length);
    expect(Object.keys(UPSTREAMS_BUILTIN)).toEqual(Object.keys(raw.upstreams));
    expect(BRANDS).toEqual(raw.brands);
    // 冻结语义保留（旧表是 Object.freeze 的）
    expect(Object.isFrozen(MODELS_BUILTIN)).toBe(true);
    expect(Object.isFrozen(UPSTREAMS_BUILTIN)).toBe(true);
    expect(Object.isFrozen(MODELS_BUILTIN[0])).toBe(true);
  });

  it('baseUrlEnv 覆盖生效：env 有值 → baseUrl 用 env；没值 → 用表内默认', async () => {
    // 挑一个带 baseUrlEnv 的上游做样本
    const [key, up] = Object.entries(raw.upstreams).find(([, u]) => u.baseUrlEnv);
    expect(key, '表里该有带 baseUrlEnv 的上游').toBeTruthy();

    // env 有值 → 覆盖
    vi.resetModules();
    process.env[up.baseUrlEnv] = 'http://127.0.0.1:9999';
    try {
      const mod = await import('./models-json.js');
      expect(mod.UPSTREAMS_BUILTIN[key].baseUrl).toBe('http://127.0.0.1:9999');
    } finally {
      delete process.env[up.baseUrlEnv];
      vi.resetModules();
    }

    // env 没值 → 表内默认
    const mod2 = await import('./models-json.js');
    expect(mod2.UPSTREAMS_BUILTIN[key].baseUrl).toBe(up.baseUrl);
  });
});
