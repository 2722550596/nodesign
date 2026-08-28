/**
 * 注册两条路（08-21）：带邀请码 → pro 档；不带 → 开放注册开着才放行、落 basic。
 * M3b（08-28）订阅通道删除：能力表 subscription 键改名 performance（演出模式资格）。
 * 库走 vitest.server.config 里的 DB_PATH（临时库），不碰生产。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { registerUser, createInvite, getUserById, updateUser, openRegistrationEnabled, defaultInviteDailyUsd } from './users-store.js';
import { tierOf, can } from './tier.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const uniq = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
let savedFlag;
beforeAll(() => { savedFlag = process.env.NODESIGN_OPEN_REGISTRATION; });
afterAll(() => { if (savedFlag === undefined) delete process.env.NODESIGN_OPEN_REGISTRATION; else process.env.NODESIGN_OPEN_REGISTRATION = savedFlag; });

describe('registerUser', () => {
  it('开放注册关着：没邀请码拒（BAD_INVITE）', () => {
    delete process.env.NODESIGN_OPEN_REGISTRATION;
    expect(openRegistrationEnabled()).toBe(false);
    expect(() => registerUser({ username: uniq('u'), password: 'password123', inviteCode: '' })).toThrow(/邀请码无效/);
  });
  it('开放注册开着：没邀请码建号，落 basic 档（无演出/发布资格；生图 08-21 深夜起开放、按张计价）', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const u = registerUser({ username: uniq('pub'), password: 'password123', inviteCode: '' });
    expect(u.plan).toBe('basic');
    expect(tierOf(u)).toBe('basic');
    expect(can(u, 'performance')).toBe(false);
    expect(can(u, 'imageGen')).toBe(true);
    expect(can(u, 'publishSite')).toBe(false);
    expect(can(u, 'webSearch')).toBe(true);
    expect(u.inviteCode).toBeNull();
    expect(getUserById(u.id).plan).toBe('basic');
  });
  it('带邀请码：消耗码、落 pro 档、终身额度照抄（花费上限，不是档位）；admin 能手动降档', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const inv = createInvite({ maxUses: 1, grantLifetimeUsd: 3 });
    const u = registerUser({ username: uniq('inv'), password: 'password123', inviteCode: inv.code });
    expect(u.plan).toBe('pro');
    expect(can(u, 'performance')).toBe(true);
    expect(can(u, 'publishSite')).toBe(true);     // 试用码（带终身额度）也是 pro：08-21 前这里被 lifetimeCostLimitUsd 当成试用号挡住
    expect(u.lifetimeCostLimitUsd).toBe(3);
    expect(() => registerUser({ username: uniq('inv2'), password: 'password123', inviteCode: inv.code })).toThrow(/已用完/);
    updateUser(u.id, { plan: 'basic' });
    expect(getUserById(u.id).plan).toBe('basic');
    expect(can(getUserById(u.id), 'performance')).toBe(false);
    expect(() => updateUser(u.id, { plan: 'vip' })).toThrow(/plan/);
  });
  it('带邀请码：默认每日 $20（08-21 晚）；终身额度只在码上写了才有；env 可调，0 = 不写走全局默认', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const saved = process.env.NODESIGN_INVITE_DEFAULT_DAILY_USD;
    try {
      delete process.env.NODESIGN_INVITE_DEFAULT_DAILY_USD;
      expect(defaultInviteDailyUsd({})).toBe(20);
      expect(defaultInviteDailyUsd({ NODESIGN_INVITE_DEFAULT_DAILY_USD: '35' })).toBe(35);
      expect(defaultInviteDailyUsd({ NODESIGN_INVITE_DEFAULT_DAILY_USD: '0' })).toBeNull();
      const inv = createInvite({ maxUses: 1 });
      const u = registerUser({ username: uniq('inv20'), password: 'password123', inviteCode: inv.code });
      expect(u.dailyCostLimitUsd).toBe(20);
      expect(u.lifetimeCostLimitUsd).toBeNull();
      expect(u.plan).toBe('pro');
      // 公开注册号（basic）：每天 $5 总额度（08-21 深夜：Go 付费行 + 生图按张计价都记这本账；Ox 免费行另按轮次闸）
      const pub = registerUser({ username: uniq('pub20'), password: 'password123', inviteCode: '' });
      expect(pub.dailyCostLimitUsd).toBe(5);
    } finally {
      if (saved === undefined) delete process.env.NODESIGN_INVITE_DEFAULT_DAILY_USD; else process.env.NODESIGN_INVITE_DEFAULT_DAILY_USD = saved;
    }
  });
});

describe('M3b 合并迁移：moderation_level（订阅旋钮）→ moderation_level_api 单旋钮', () => {
  it('订阅旋钮有值、api 旋钮 NULL 的存量行，启动迁移后值并进 api；api 已有显式值的不动', () => {
    // 造一个「迁移前」形态的库：两列都在，订阅旋钮显式设过、api 旋钮空
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-m3b-mig-')), 'mig.db');
    const prep = new Database(dbFile);
    prep.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', daily_token_limit INTEGER,
      disabled INTEGER NOT NULL DEFAULT 0, invite_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      moderation_level TEXT, moderation_level_api TEXT)`);
    prep.prepare(`INSERT INTO users (id, username, password_hash, moderation_level, moderation_level_api) VALUES ('u_legacy', 'legacy', 'x', 'loose', NULL)`).run();
    prep.prepare(`INSERT INTO users (id, username, password_hash, moderation_level, moderation_level_api) VALUES ('u_both', 'both', 'x', 'strict', 'off')`).run();
    prep.close();
    // 子进程 import 触发模块加载期的迁移块（与生产启动同一条路）
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import('./auth/users-store.js').then(() => console.log('ok'))`],
    { cwd: SERVER_ROOT, env: { ...process.env, DB_PATH: dbFile }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const check = new Database(dbFile);
    // 合并规则：api 显式 ?? 订阅显式 ?? 默认 —— legacy 行从订阅旋钮复制过来
    expect(check.prepare('SELECT moderation_level_api FROM users WHERE id = ?').get('u_legacy').moderation_level_api).toBe('loose');
    // api 已有显式值 → 不被覆盖
    expect(check.prepare('SELECT moderation_level_api FROM users WHERE id = ?').get('u_both').moderation_level_api).toBe('off');
    check.close();
  });

  it('rowToUser 不再暴露 moderationLevel（订阅旋钮退役），只有 moderationLevelApi', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const u = registerUser({ username: uniq('knob'), password: 'password123', inviteCode: '' });
    expect(u.moderationLevelApi).toBeNull();
    expect('moderationLevel' in u).toBe(false);
    // updateUser 只认 moderationLevelApi
    updateUser(u.id, { moderationLevelApi: 'off' });
    expect(getUserById(u.id).moderationLevelApi).toBe('off');
  });
});
