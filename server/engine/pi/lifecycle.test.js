/**
 * lifecycle.test.js — sessionLaunch args/env 契约（C1/C2/C9）+ mcp-config 幂等
 *
 * 不真起 pi：sessionLaunch 只断言返回的 { binary, args, cwd, env }；
 * createSessionProcess 用 node 子进程验孤儿回收记账（不起 pi）。
 * env 断言全部在 process.env 快照/还原里做，不污染后续测试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolvePiBinary, sessionLaunch, createSessionProcess, _liveChildCount, spawnBarePiForRewind,
} from './lifecycle.js';
import { ensureProjectPiConfig } from './mcp-config.js';
import { sidToken } from './sidecar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, 'agent-dir');
const PROVIDERS_EXT = path.join(__dirname, 'extensions', 'providers.ts');
const ADAPTER_EXT = path.join(AGENT_DIR, 'npm', 'node_modules', 'pi-mcp-adapter', 'index.ts');
const ASK_USER_EXT = path.join(__dirname, 'extensions', 'ask-user.ts');
const GUARDS_EXT = path.join(__dirname, 'extensions', 'guards.ts');
const PROMPT_SUPPORT_EXT = path.join(__dirname, 'extensions', 'prompt-support.ts');
const INJECT_EXT = path.join(__dirname, 'extensions', 'inject.ts');
const TASK_TOOLS_EXT = path.join(__dirname, 'extensions', 'task-tools.ts');
const STANDALONE_JS = fileURLToPath(new URL('../mcp/standalone.js', import.meta.url));

/** process.env 快照/还原（黑名单与 UPSTREAM 断言要改真实 env）。 */
let envSnapshot;
beforeEach(() => { envSnapshot = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k];
  Object.assign(process.env, envSnapshot);
});

/** 每个 case 一个 tmp workspace/dataRoot。 */
function mkTmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e1-lifecycle-'));
  const workspaceDir = path.join(root, 'shared');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  return { root, workspaceDir, dataRoot };
}

const BASE_OPTS = {
  sid: 'sess-test-0001',
  projectId: 'proj_1',
  ownerId: 'u_42',
  port: 4001,
  directTools: ['read_board', 'web_search'],
};

describe('resolvePiBinary', () => {
  it('PI_BIN 存在则用', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e1-pibin-'));
    const fake = path.join(tmp, 'pi-fake');
    fs.writeFileSync(fake, '#!/bin/sh\n');
    process.env.PI_BIN = fake;
    expect(resolvePiBinary()).toBe(fake);
  });

  it('PI_BIN 指向不存在的文件 → 抛错带提示', () => {
    process.env.PI_BIN = '/nonexistent/nd-e1/pi-nope';
    expect(() => resolvePiBinary()).toThrow(/PI_BIN/);
  });

  it('无 PI_BIN → PATH 里找 pi；PATH 无 pi → 抛错带提示', () => {
    delete process.env.PI_BIN;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e1-path-'));
    const fakePi = path.join(tmp, 'pi');
    fs.writeFileSync(fakePi, '#!/bin/sh\n');
    fs.chmodSync(fakePi, 0o755);

    const origPath = process.env.PATH;
    try {
      process.env.PATH = tmp;
      expect(resolvePiBinary()).toBe(fakePi);
      process.env.PATH = path.join(tmp, 'empty-subdir'); // 不存在任何可执行
      expect(() => resolvePiBinary()).toThrow(/pi/);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe('sessionLaunch args（C2）', () => {
  it('全量参数：顺序与取值逐项断言', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    const launch = sessionLaunch({
      ...BASE_OPTS, workspaceDir, dataRoot,
      provider: 'gmi', model: 'MiniMaxAI/MiniMax-M3', presetId: 'nodesign-base', resume: true,
    });

    expect(launch.binary).toBeTruthy();
    expect(launch.cwd).toBe(workspaceDir);
    expect(launch.args).toEqual([
      '--mode', 'rpc',
      '--approve',
      '--provider', 'gmi',
      '--model', 'MiniMaxAI/MiniMax-M3',
      '--preset', 'nodesign-base',
      '--config-dir', '.pi',                                          // 相对值（绝对会拼坏）
      '--session-dir', path.join(dataRoot, 'pi-sessions', BASE_OPTS.sid), // 绝对直通
      '--system-prompt', '',
      '-e', PROVIDERS_EXT,                                            // providers 扩展
      '-e', ADAPTER_EXT,                                              // MCP adapter（消费 .pi/mcp.json）
      '-e', ASK_USER_EXT,                                             // AskUserQuestion（M2 方案 A）
      '-e', GUARDS_EXT,                                               // 安全闸（M2）
      '-e', PROMPT_SUPPORT_EXT,                                       // ndPolicy 宏（M2 preset 消费）
      '-e', INJECT_EXT,                                               // 懒注入 + 失败建议 + rate-limit（M2）
      '-e', TASK_TOOLS_EXT,                                           // 任务清单（todo 复刻）
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
      '--continue',
    ]);
    // 恰好七个 -e：providers + adapter + ask-user + guards + prompt-support + inject + task-tools
    expect(launch.args.filter((a) => a === '-e')).toHaveLength(7);
    // --session-dir 绝对
    expect(path.isAbsolute(launch.args[launch.args.indexOf('--session-dir') + 1])).toBe(true);
  });

  it('可选参数缺省不出现；resume=false 无 --continue', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    const launch = sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot });
    expect(launch.args).not.toContain('--provider');
    expect(launch.args).not.toContain('--model');
    expect(launch.args).not.toContain('--preset');
    expect(launch.args).not.toContain('--continue');
    expect(launch.args.slice(0, 3)).toEqual(['--mode', 'rpc', '--approve']);
  });

  it('spawn 前写 .pi/mcp.json（C9）', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot });
    const mcp = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.pi', 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.nodesign.directTools).toEqual(BASE_OPTS.directTools);
  });

  it('sid/workspaceDir/dataRoot 缺失 → 抛错', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    expect(() => sessionLaunch({ ...BASE_OPTS, sid: '', workspaceDir, dataRoot })).toThrow(/sid/);
    expect(() => sessionLaunch({ ...BASE_OPTS, workspaceDir: '', dataRoot })).toThrow(/workspaceDir/);
    expect(() => sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot: '' })).toThrow(/dataRoot/);
  });
});

describe('sessionLaunch env（C1）', () => {
  it('注入项：PI_CODING_AGENT_DIR 绝对、身份、sidecar URL、TOKEN 非空且与 sidToken 一致', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    const { env } = sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot });

    expect(path.isAbsolute(env.PI_CODING_AGENT_DIR)).toBe(true);
    expect(env.PI_CODING_AGENT_DIR).toBe(AGENT_DIR);
    expect(env.PI_TELEMETRY).toBe('0');
    expect(env.NODESIGN_SID).toBe(BASE_OPTS.sid);
    expect(env.NODESIGN_UID).toBe(BASE_OPTS.ownerId);
    expect(env.NODESIGN_PROJECT).toBe(BASE_OPTS.projectId);
    expect(env.NODESIGN_WORKSPACE).toBe(workspaceDir);
    expect(env.NODESIGN_DATA_ROOT).toBe(dataRoot);
    expect(env.NODESIGN_MAIN_URL).toBe('http://127.0.0.1:4001/__nd-sidecar');
    expect(env.NODESIGN_TOKEN).toBeTruthy();
    expect(env.NODESIGN_TOKEN).toBe(sidToken(BASE_OPTS.sid));
  });

  it('黑名单剔除：存在时删、缺失时不炸', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    process.env.NODE_ENV = 'production';
    process.env.npm_config_production = 'true';
    process.env.npm_config_omit = 'dev';
    process.env.OLDPWD = '/tmp';
    process.env.NODESIGN_MCP_SERVERS = '{"x":1}';
    const withAll = sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot }).env;
    for (const k of ['NODE_ENV', 'npm_config_production', 'npm_config_omit', 'OLDPWD', 'NODESIGN_MCP_SERVERS']) {
      expect(withAll[k]).toBeUndefined();
    }
    // 缺失场景（快照还原后全部 delete）
    for (const k of ['NODE_ENV', 'npm_config_production', 'npm_config_omit', 'OLDPWD', 'NODESIGN_MCP_SERVERS']) {
      delete process.env[k];
    }
    const withNone = sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot }).env;
    expect(withNone.NODESIGN_SID).toBe(BASE_OPTS.sid); // 正常产出
  });

  it('NODESIGN_UPSTREAM_* 过滤注入：匹配进、不匹配/空值不进', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    process.env.NODESIGN_UPSTREAM_GMI_KEY = 'sk-test-123';
    process.env.NODESIGN_UPSTREAM_LAMENT_KEY = 'sk-test-456';
    process.env.NODESIGN_UPSTREAM_EMPTY = '';          // 空值不注入
    process.env.NODESIGN_MODEL = 'stale-model';        // 前缀不匹配
    const { env } = sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot });
    expect(env.NODESIGN_UPSTREAM_GMI_KEY).toBe('sk-test-123');
    expect(env.NODESIGN_UPSTREAM_LAMENT_KEY).toBe('sk-test-456');
    expect(env.NODESIGN_UPSTREAM_EMPTY).toBeUndefined();
    expect(env.NODESIGN_MODEL).toBe('stale-model');    // 非 UPSTREAM 前缀，继承不干预
  });

  it('DB_PATH：env 有则 resolve 透传；无则默认 server/db/nodesign.db 绝对', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    process.env.DB_PATH = 'relative/test.db';
    const withEnv = sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot }).env;
    expect(withEnv.DB_PATH).toBe(path.resolve('relative/test.db'));

    delete process.env.DB_PATH;
    const withoutEnv = sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot }).env;
    expect(withoutEnv.DB_PATH).toBe(path.resolve(__dirname, '../../db/nodesign.db'));
  });

  it('政策节 env：NODESIGN_ADULT_LEVEL 透传；NODESIGN_UNCENSORED_MODELS 是 wire-key 集合（逗号 join，缺省空串）', () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    const withPolicy = sessionLaunch({
      ...BASE_OPTS, workspaceDir, dataRoot,
      adultLevel: 'strict',
      uncensoredModels: ['qwenLocal/qwen3.8-27b', 'custom/other'],
    }).env;
    expect(withPolicy.NODESIGN_ADULT_LEVEL).toBe('strict');
    expect(withPolicy.NODESIGN_UNCENSORED_MODELS).toBe('qwenLocal/qwen3.8-27b,custom/other');

    const defaults = sessionLaunch({ ...BASE_OPTS, workspaceDir, dataRoot }).env;
    expect(defaults.NODESIGN_ADULT_LEVEL).toBe('loose');
    expect(defaults.NODESIGN_UNCENSORED_MODELS).toBe('');
  });
});

describe('ensureProjectPiConfig（C9 幂等）', () => {
  it('首写 written:true，形状逐项；重复写 written:false 且 mtime 不变', () => {
    const { workspaceDir } = mkTmpDirs();
    const r1 = ensureProjectPiConfig(workspaceDir, { directTools: ['read_board'] });
    expect(r1).toEqual({ written: true });

    const mcpPath = path.join(workspaceDir, '.pi', 'mcp.json');
    const raw = fs.readFileSync(mcpPath, 'utf8');
    const mcp = JSON.parse(raw);
    expect(mcp).toEqual({
      mcpServers: {
        nodesign: {
          command: 'node',
          args: [STANDALONE_JS],
          directTools: ['read_board'],
          lifecycle: 'lazy',
          requestTimeoutMs: 60000,
        },
      },
      settings: { toolPrefix: 'none' },
    });
    expect(path.isAbsolute(mcp.mcpServers.nodesign.args[0])).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);          // 尾换行
    expect(raw).toContain('\n  "mcpServers"');      // 2 空格缩进

    const mtime1 = fs.statSync(mcpPath).mtimeMs;
    const r2 = ensureProjectPiConfig(workspaceDir, { directTools: ['read_board'] });
    expect(r2).toEqual({ written: false });
    expect(fs.statSync(mcpPath).mtimeMs).toBe(mtime1); // 跳过不碰文件
  });

  it('directTools 变化 / 坏 JSON → 覆盖写', () => {
    const { workspaceDir } = mkTmpDirs();
    ensureProjectPiConfig(workspaceDir, { directTools: ['a'] });
    const r = ensureProjectPiConfig(workspaceDir, { directTools: ['a', 'b'] });
    expect(r).toEqual({ written: true });
    const mcp = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.pi', 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.nodesign.directTools).toEqual(['a', 'b']);

    fs.writeFileSync(path.join(workspaceDir, '.pi', 'mcp.json'), '{ broken');
    const r2 = ensureProjectPiConfig(workspaceDir, { directTools: ['a', 'b'] });
    expect(r2).toEqual({ written: true });
  });

  it('.pi 目录不存在自动创建', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e1-mcp-'));
    const shared = path.join(root, 'deep', 'shared');
    fs.mkdirSync(shared, { recursive: true });
    expect(ensureProjectPiConfig(shared, { directTools: [] })).toEqual({ written: true });
    expect(fs.existsSync(path.join(shared, '.pi', 'mcp.json'))).toBe(true);
  });
});

describe('createSessionProcess 孤儿回收记账', () => {
  it('spawn 记账，exit 销账（用 node 子进程，不起 pi）', async () => {
    const before = _liveChildCount();
    const launch = {
      binary: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: os.tmpdir(),
      env: process.env,
    };
    const child = createSessionProcess(launch);
    expect(_liveChildCount()).toBe(before + 1);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect(_liveChildCount()).toBe(before);
  });
});

// ── spawnBarePiForRewind（M3c C6）─────────────────────────────────────────────
// 不起真 pi：fake pi 脚本（node + shebang）走真 spawn + 真 RPC 帧，记录 argv/cwd/env
// 供断言，回应 get_state / navigate_tree，abort 即退（kill 链快速收敛）。

const FAKE_PI_SRC = `#!/usr/bin/env node
import fs from 'node:fs';
const rec = process.env.FAKE_PI_RECORD;
fs.writeFileSync(rec, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_TELEMETRY: process.env.PI_TELEMETRY,
    upstream: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith('NODESIGN_UPSTREAM_')),
    ),
  },
}));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    const respond = (obj) => process.stdout.write(
      JSON.stringify({ type: 'response', id: cmd.id, ...obj }) + '\\n');
    if (cmd.type === 'get_state') respond({ success: true, data: {} });
    else if (cmd.type === 'navigate_tree') {
      fs.appendFileSync(rec + '.nav', JSON.stringify(cmd) + '\\n');
      if (process.env.FAKE_PI_FAIL_NAV) respond({ success: false, error: 'simulated' });
      else respond({ success: true, data: { cancelled: false } });
    } else if (cmd.type === 'abort') {
      process.exit(0);
    }
  }
});
`;

/** 写 fake pi 可执行脚本并 pin 到 PI_BIN；返回记录文件路径。 */
function mkFakePi() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-c6-fakepi-'));
  const bin = path.join(tmp, 'pi-fake.mjs');
  fs.writeFileSync(bin, FAKE_PI_SRC);
  fs.chmodSync(bin, 0o755);
  process.env.PI_BIN = bin;
  const record = path.join(tmp, 'record.json');
  process.env.FAKE_PI_RECORD = record;
  return record;
}

describe('spawnBarePiForRewind（M3c C6）', () => {
  it('args/env 组装 + navigate_tree 发出（label 默认 rewind）+ 进程回收', async () => {
    const record = mkFakePi();
    const { workspaceDir, dataRoot } = mkTmpDirs();
    process.env.NODESIGN_UPSTREAM_GMI_KEY = 'sk-test-123';
    process.env.NODESIGN_UPSTREAM_EMPTY = '';   // 空值不进子进程
    const before = _liveChildCount();

    await spawnBarePiForRewind({
      sid: 'sess-rewind-01', dataRoot, workspaceDir, targetId: 'abcd1234',
    });

    const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
    // args：裸配置——nd-probe preset、原 session-dir、--continue、唯一扩展 providers.ts
    expect(rec.argv).toEqual([
      '--mode', 'rpc', '--approve',
      '--preset', 'nd-probe',
      '--config-dir', '.pi',
      '--session-dir', path.join(dataRoot, 'pi-sessions', 'sess-rewind-01'),
      '--continue',
      '--system-prompt', '',
      '-e', PROVIDERS_EXT,
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    ]);
    expect(rec.argv.filter((a) => a === '-e')).toHaveLength(1); // 不挂 nodesign 工具面七个 -e
    expect(rec.cwd).toBe(workspaceDir);                          // .pi/ 在 cwd 下
    // env：AGENT_DIR（找 nd-probe preset）+ 关遥测 + 上游 key 过滤注入
    expect(rec.env.PI_CODING_AGENT_DIR).toBe(AGENT_DIR);
    expect(rec.env.PI_TELEMETRY).toBe('0');
    expect(rec.env.upstream).toEqual({ NODESIGN_UPSTREAM_GMI_KEY: 'sk-test-123' });
    // navigate_tree：targetId 透传 + label 'rewind'（落盘 leaf，pi-rp C0）
    const nav = JSON.parse(fs.readFileSync(record + '.nav', 'utf8').trim());
    expect(nav).toMatchObject({ type: 'navigate_tree', targetId: 'abcd1234', label: 'rewind' });
    // kill 链收敛后孤儿记账归零
    expect(_liveChildCount()).toBe(before);
  });

  it('navigate_tree 失败 → 抛错且 finally 仍 kill（进程不泄漏）', async () => {
    const record = mkFakePi();
    const { workspaceDir, dataRoot } = mkTmpDirs();
    process.env.FAKE_PI_FAIL_NAV = '1';
    const before = _liveChildCount();

    await expect(spawnBarePiForRewind({
      sid: 'sess-rewind-02', dataRoot, workspaceDir, targetId: 'deadbeef',
    })).rejects.toThrow(/navigate_tree/);

    expect(fs.existsSync(record)).toBe(true);      // 进程确实起来了
    expect(_liveChildCount()).toBe(before);        // finally kill 生效
  });

  it('sid/dataRoot/workspaceDir/targetId 缺失 → 抛错（不 spawn）', async () => {
    const { workspaceDir, dataRoot } = mkTmpDirs();
    const base = { sid: 's', dataRoot, workspaceDir, targetId: 'aaaaaaaa' };
    const before = _liveChildCount();
    for (const key of ['sid', 'dataRoot', 'workspaceDir', 'targetId']) {
      await expect(spawnBarePiForRewind({ ...base, [key]: '' })).rejects.toThrow(new RegExp(key));
    }
    expect(_liveChildCount()).toBe(before);
  });
});
