/**
 * 注册两条路（08-21）：带邀请码 → 订阅资格；不带 → 开放注册开着才放行、只免费模型。
 * 库走 vitest.server.config 里的 DB_PATH（临时库），不碰生产。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerUser, createInvite, getUserById, updateUser, openRegistrationEnabled } from './users-store.js';

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
  it('开放注册开着：没邀请码建号，allowSubscription=false', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const u = registerUser({ username: uniq('pub'), password: 'password123', inviteCode: '' });
    expect(u.allowSubscription).toBe(false);
    expect(u.inviteCode).toBeNull();
    expect(getUserById(u.id).allowSubscription).toBe(false);
  });
  it('带邀请码：消耗码、allowSubscription=true、终身额度照抄；admin 能手动收回', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const inv = createInvite({ maxUses: 1, grantLifetimeUsd: 3 });
    const u = registerUser({ username: uniq('inv'), password: 'password123', inviteCode: inv.code });
    expect(u.allowSubscription).toBe(true);
    expect(u.lifetimeCostLimitUsd).toBe(3);
    expect(() => registerUser({ username: uniq('inv2'), password: 'password123', inviteCode: inv.code })).toThrow(/已用完/);
    updateUser(u.id, { allowSubscription: false });
    expect(getUserById(u.id).allowSubscription).toBe(false);
  });
});
