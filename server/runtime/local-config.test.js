/**
 * runtime/local-config.js 的校验钉子（纯函数 validateLocalConfig）+ 合并进模型表后的会话优先路由
 * （子进程：model-context 在 import 时读配置，得用 NODESIGN_MODELS_CONFIG 指一份临时文件）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLocalConfig, MAX_RETRY_BUDGET_MS } from './local-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const GOOD = {
  upstreams: {
    relay: { baseUrl: 'https://api.example.com/', protocol: 'openai-chat', key: 'sk-test' },
    anth: { baseUrl: 'https://relay2.example.com', keyEnv: 'MY_RELAY_KEY' },
  },
  models: [
    { id: 'kimi-k2', label: 'Kimi K2', window: 262144, upstream: 'relay', wireModel: 'kimi-k2-0905', reasoningEffort: 'high', prices: { input: 0.6, output: 2.5 }, failStreakMax: 20 },
    { id: 'glm-5', label: 'GLM 5', desc: '便宜', window: 1_000_000, upstream: 'anth', wireModel: 'glm-5', fastModel: 'kimi-k2' },
  ],
};

describe('validateLocalConfig', () => {
  it('好配置：归一化成 UPSTREAMS 条目形状，authStyle 按协议补默认，baseUrl 去尾斜杠', () => {
    const v = validateLocalConfig(GOOD);
    expect(v.errors).toEqual([]);
    expect(v.upstreams.relay).toMatchObject({ label: 'relay', baseUrl: 'https://api.example.com', protocol: 'openai-chat', authStyle: 'bearer', key: 'sk-test', keyEnv: null, countTokens: false, external: true });
    expect(v.upstreams.anth).toMatchObject({ authStyle: 'x-api-key', key: null, keyEnv: 'MY_RELAY_KEY', protocol: 'anthropic' });
    expect(v.models.map((m) => m.id)).toEqual(['kimi-k2', 'glm-5']);
    expect(v.models[0]).toMatchObject({ thinking: 'strip', brand: 'custom', desc: '', liftImages: false });
  });

  it('一条坏了不连坐：坏行被丢、记进 errors、好行照常', () => {
    const v = validateLocalConfig({
      upstreams: { ...GOOD.upstreams, zenGo: { baseUrl: 'https://x.example.com', key: 'k' }, nokey: { baseUrl: 'https://y.example.com' } },
      models: [...GOOD.models,
        { id: 'ox-alpha', label: '撞内置名', window: 100000, upstream: 'relay', wireModel: 'x' },
        { id: 'orphan', label: '指向不存在的上游', window: 100000, upstream: 'ghost', wireModel: 'x' },
        { id: 'badfast', label: 'fast 指错', window: 100000, upstream: 'relay', wireModel: 'x', fastModel: 'nope' },
        { id: 'toolong', label: '预算超线', window: 100000, upstream: 'relay', wireModel: 'x', emptyRetries: 3, retryBudgetMs: MAX_RETRY_BUDGET_MS + 1 },
        { id: 'extra', label: '多了字段', window: 100000, upstream: 'relay', wireModel: 'x', sdkAlias: 'claude-opus-5[1m]' },
        { id: 'streak', label: '止损超线', window: 100000, upstream: 'relay', wireModel: 'x', failStreakMax: 51 },
      ],
    });
    expect(Object.keys(v.upstreams).sort()).toEqual(['anth', 'relay']);
    expect(v.models.map((m) => m.id)).toEqual(['kimi-k2', 'glm-5']);
    const text = v.errors.map((e) => `${e.where} ${e.message}`).join('\n');
    expect(text).toMatch(/upstreams\.zenGo .*内置上游名/);
    expect(text).toMatch(/upstreams\.nokey .*key 或 keyEnv/);
    expect(text).toMatch(/ox-alpha.*内置模型名/);
    expect(text).toMatch(/orphan.*upstream 'ghost' 不存在/);
    expect(text).toMatch(/badfast.*fastModel 'nope'/);
    expect(text).toMatch(/toolong.*retryBudgetMs/);
    expect(text).toMatch(/extra.*sdkAlias/);   // strict：不认识的字段报出来，别静默吞（sdkAlias 是自动分配的，不许手填）
    expect(text).toMatch(/streak.*failStreakMax/);   // 行内止损上限超线（>50）报出来
  });

  it('根不是对象 / 坏 JSON 形状 → 一条错、空配置', () => {
    expect(validateLocalConfig([]).errors[0].message).toMatch(/必须是一个对象/);
    expect(validateLocalConfig({ upstreams: [], models: {} }).errors.length).toBeGreaterThan(0);
  });
});

describe('外部插槽进表 + picker 钥匙过滤（子进程）', () => {

  it('local profile：外部行进 picker 靠条目上的 key（不是 env）；keyEnv 没设的行藏掉（08-22 smoke 抓到的洞）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-cfg-'));
    const cfg = path.join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify(GOOD));
    const code = `
      import { selectableModelsFor } from '../engine/agent/model-context.js';
      console.log(JSON.stringify(selectableModelsFor({ id: '_anon', role: 'admin' }).map((m) => m.id)));`;
    const base = { ...process.env }; delete base.VITEST; delete base.MY_RELAY_KEY;
    const run = (extra) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: here, env: { ...base, NODESIGN_PROFILE: 'local', NODESIGN_DATA_DIR: dir, NODESIGN_MODELS_CONFIG: cfg, ...extra }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const without = run({});
    expect(without).toContain('kimi-k2');        // key 内联
    expect(without).not.toContain('glm-5');      // keyEnv MY_RELAY_KEY 没设
    expect(without).not.toContain('ox-alpha');   // 内置行钥匙没配
    expect(run({ MY_RELAY_KEY: 'x' })).toContain('glm-5');
  });
});
