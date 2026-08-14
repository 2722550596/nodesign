// server 侧测试配置（2026-08-14 可维护性行动 D 刀：服务端从 0 测试起步）。
// 跑法：`npm run test:server`（node 环境，不进 web 的 happy-dom 配置）。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.js'],
    environment: 'node',
  },
});
