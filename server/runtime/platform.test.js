// 隔离两道闸的配置层（2026-08-15）：黑名单 / env 洗白 / 结构化工具 deny 规则
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { platform } from './platform.js';

const repoRoot = platform.repoRoot;

describe('凭据黑名单', () => {
  const list = platform.credentialBlacklist();
  it('⭐ .env 必须在里面 —— 中转站 key / CF token / admin 密码都在那一个文件', () => {
    expect(list).toContain(path.join(repoRoot, '.env'));
  });
  it('家目录里的凭据窝一个都不能漏', () => {
    for (const tail of ['.ssh', '.aws', 'apikey', '.codex', '.wrangler', '.claude.json']) {
      expect(list.some(p => p.endsWith(tail))).toBe(true);
    }
  });
  it('⭐ 同机兄弟仓的 .env 也要拦 —— 只拦本仓的话，exp 会话能 cat 生产的 .env（真跑抓到过）', () => {
    const parent = path.dirname(repoRoot);
    expect(list).toContain(path.join(parent, 'Nodesign', '.env'));
    expect(list.filter(p => p.endsWith('/.env')).length).toBeGreaterThan(1);
  });
  it('.env.example 不拦（示例没秘密，挡着反而碍事）', () => {
    expect(list.some(p => p.endsWith('.env.example'))).toBe(false);
  });
  it('NODESIGN_DENY_READ_EXTRA 是逃生舱：不改代码也能加拦截目标', () => {
    const old = process.env.NODESIGN_DENY_READ_EXTRA;
    process.env.NODESIGN_DENY_READ_EXTRA = '/a/b : /c/d';
    try {
      expect(platform.credentialBlacklist()).toEqual(expect.arrayContaining(['/a/b', '/c/d']));
    } finally {
      if (old === undefined) delete process.env.NODESIGN_DENY_READ_EXTRA;
      else process.env.NODESIGN_DENY_READ_EXTRA = old;
    }
  });
});

describe('沙盒内要抹掉的环境变量', () => {
  it('按命名规律抓，不靠写死清单（以后加新 key 自动被盖住）', () => {
    const names = platform.secretEnvVarNames({
      CHATAI_API_KEY: 'x', CLOUDFLARE_API_TOKEN: 'x', NODESIGN_AUTH_SECRET: 'x',
      NODESIGN_AUTH_PASSWORD: 'x', ANTHROPIC_API_KEY: 'x',
      PORT: '1', NODESIGN_MODEL: 'y', HOME: '/h',
    });
    expect(names.sort()).toEqual([
      'ANTHROPIC_API_KEY', 'CHATAI_API_KEY', 'CLOUDFLARE_API_TOKEN',
      'NODESIGN_AUTH_PASSWORD', 'NODESIGN_AUTH_SECRET',
    ]);
  });
});

describe('结构化工具 deny 规则', () => {
  it('⚠️ 路径必须是双斜杠绝对形式 —— 单斜杠静默失效，实测过', () => {
    const rules = platform.protectedPathRules({ dataRoot: '/var/nodesign-data' });
    const envRule = rules.find(r => r.startsWith('Read(') && r.includes('/.env'));
    expect(envRule).toBe(`Read(/${path.join(repoRoot, '.env')})`);
    expect(envRule.startsWith('Read(//')).toBe(true);
  });

  it('三种工具都要盖：Read 防看，Write/Edit 防改', () => {
    const rules = platform.protectedPathRules({ dataRoot: '/var/nodesign-data' });
    const env = `/${path.join(repoRoot, '.env')}`;
    expect(rules).toContain(`Read(${env})`);
    expect(rules).toContain(`Write(${env})`);
    expect(rules).toContain(`Edit(${env})`);
  });

  it('数据根在仓库外 → 整个仓库禁写', () => {
    const rules = platform.protectedPathRules({ dataRoot: '/home/x/nodesign-exp-data/projects-data' });
    expect(rules).toContain(`Write(/${repoRoot}/**)`);
  });

  it('⭐ 数据根在仓库里（生产就是 server/projects-data）→ 不许把 agent 自己的工作区封死', () => {
    const rules = platform.protectedPathRules({ dataRoot: path.join(repoRoot, 'server', 'projects-data') });
    expect(rules).not.toContain(`Write(/${repoRoot}/**)`);
    expect(rules).not.toContain(`Write(/${path.join(repoRoot, 'server')}/**)`);
    // 别的顶层目录照封
    expect(rules).toContain(`Write(/${path.join(repoRoot, 'web')}/**)`);
  });
});
