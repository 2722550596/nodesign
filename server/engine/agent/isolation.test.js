// 隔离配置与 bwrap 垫片（2026-08-15）
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { sandboxShimEnv } from './isolation.js';
import { platform } from '../../runtime/platform.js';

describe('bwrap 垫片的 env', () => {
  it('沙盒没开就不插 PATH（垫片只为沙盒服务）', () => {
    if (platform.sandboxEnabled) return;
    expect(sandboxShimEnv({ baseEnv: { PATH: '/usr/bin' } })).toEqual({});
  });
  it('沙盒开着时把垫片目录插在 PATH 最前面，原 PATH 原样跟在后面', () => {
    if (!platform.sandboxEnabled) return;
    const out = sandboxShimEnv({ baseEnv: { PATH: '/usr/bin' }, dataRoot: '/data' });
    expect(out.PATH.startsWith(path.join(platform.repoRoot, 'server', 'ops', 'sandbox-shim')))
      .toBe(true);
    expect(out.PATH.endsWith('/usr/bin')).toBe(true);
    expect(out.NODESIGN_SHIM_LOG).toBe('/data/.sandbox-shim.log');
  });
});
