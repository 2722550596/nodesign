// auto 模式分类器规则（2026-08-15）
import { describe, it, expect } from 'vitest';
import { autoModeSettings, ENVIRONMENT, HARD_DENY, DEFAULT_HARD_DENY } from './auto-mode-rules.js';

describe('喂给分类器的形状', () => {
  const s = autoModeSettings();
  it('⚠️ 只覆盖 environment / hard_deny 两节 —— autoMode 是按节替换的，写了 allow 就把出厂 17 条顶没了', () => {
    expect(Object.keys(s).sort()).toEqual(['environment', 'hard_deny']);
  });
  it('hard_deny 第一条必须是出厂那条，我们的追加在后面', () => {
    expect(s.hard_deny[0]).toBe(DEFAULT_HARD_DENY);
    expect(s.hard_deny.length).toBe(1 + HARD_DENY.length);
  });
  it('每条规则都是「名字: 说明」，名字短、说明够长（分类器读的是散文不是关键词）', () => {
    for (const r of [...HARD_DENY, ...ENVIRONMENT]) {
      expect(r.length).toBeGreaterThan(80);
      const 名 = r.split(':')[0];
      expect(名.length).toBeGreaterThan(3);
      expect(名.length).toBeLessThan(80);
    }
  });
  it('环境事实要点名这台机器的真实处境，别写成通用套话', () => {
    const 全 = ENVIRONMENT.join('\n');
    for (const 词 of ['multi-tenan', 'beta creator', 'publish_site', '编排.yaml', 'bubblewrap']) {
      expect(全.toLowerCase()).toContain(词.toLowerCase());
    }
  });
  it('硬拦四件事都在：别的租户 / 宿主控制面 / 平台自身 / 闸门本身', () => {
    const 名 = HARD_DENY.map(r => r.split(':')[0]);
    expect(名).toEqual(expect.arrayContaining([
      'Other Tenants', 'Host Control Plane', 'Platform Internals', 'Guardrail Tampering',
      'Ad-hoc Upload',
    ]));
  });
  it('⭐ 传出去要拦，拿进来不拦 —— GET 素材是正常活', () => {
    const 传 = HARD_DENY.find(r => r.startsWith('Ad-hoc Upload'));
    expect(传).toMatch(/publish_site/);
    expect(传).toMatch(/Fetching assets INTO the workspace \(GET\) is normal work/);
  });
  it('⭐ 重试不能被当成绕闸 —— 沙盒有已知偶发，原样重跑是正常操作', () => {
    const 篡改 = HARD_DENY.find(r => r.startsWith('Guardrail Tampering'));
    expect(篡改).toMatch(/Retrying a transient sandbox failure with the identical command is fine/);
  });
});

// 「出厂快照有没有漂移」那条对活 claude CLI 的测试 M1 删了：SDK 移除后没有捆绑的
// claude 可执行，PATH 里的 claude 是用户全局装的（WSL interop 还会卡在欢迎横幅），
// execFileSync 60s 超时 > vitest 5s 测试超时 → 必挂。快照本身（auto-mode-default-hard-deny.txt）
// 留着当历史参考，不再做活对账。
