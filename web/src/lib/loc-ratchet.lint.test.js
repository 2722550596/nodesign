/**
 * 行数棘轮（2026-08-14 可维护性行动 A 刀）。
 *
 * 规则：源文件 ≤ 600 行；已经超标的老户按**现状冻结上限**（下表），只许降
 * 不许升 —— 想给胖文件加功能，先拆出去一块再写。文件瘦下来之后把表里的
 * 数字**手动调低**（棘轮只进不退，这一步是刻意要人做的：降表=宣告胖子在
 * 减肥中，别人别再往里塞）。
 *
 * 为什么是测试不是 CI 规则：这仓库没有 CI，vitest 就是部署链的闸门 ——
 * 跟 path-compose.lint 同一个存在方式。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LIMIT = 600;

/** 老户冻结上限（= 2026-08-14 现状）。只许调低。 */
const GRANDFATHERED = {
  'web/src/components/canvas/BoardCanvas.jsx': 2752,   // B1 入座 → B2 搬家 → B3 菜单表 → B5 浮层族迁出后
  'web/src/routes/ProjectWorkspace.jsx': 2427,
  // server/engine/agent/hooks.js 2026-08-14 拆完出表（1975 → 组装层 ~330，走 600 通用上限）
  'web/src/components/chat/Message.jsx': 1871,   // 正文渲染迁去 MarkdownText.jsx 后
  'server/engine/agent/session-loop.js': 1192,
  'server/projects/workspace.js': 1124,
  'server/api/turn.js': 1075,
  'server/api/assets.js': 1017,
  'server/api/exports/build-standalone.js': 980,
  'web/src/routes/Home.jsx': 710,               // 样式表迁去 home-styles.js 后
  'web/src/components/canvas/DragOverlay.jsx': 927,
  'server/api/exports.js': 926,
  'server/engine/runs/active-runs.js': 912,
  'server/engine/mcp/tools/generate-image.js': 843,
  'web/src/components/canvas/SiteWindow.jsx': 841,
  'web/src/routes/AdminConsole.jsx': 830,
  'web/src/lib/drag-intent.js': 819,
  'web/src/components/canvas/StageLayer.jsx': 726,
  'server/lib/plugin-validator.js': 721,
  'web/src/components/AuthGate.jsx': 684,
  'server/lib/binary-fixup-proxy.js': 651,
  'server/engine/agent/agent-shared.js': 650,
  'server/projects/board-store.js': 640,
  'server/engine/mcp/tools/web-search.js': 622,
};

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { sourceFiles(p, out); continue; }
    if (!/\.(js|jsx|mjs)$/.test(e.name)) continue;
    if (/\.(test|lint\.test)\./.test(e.name)) continue;
    out.push(p);
  }
  return out;
}

describe('行数棘轮', () => {
  const files = [
    ...sourceFiles(path.join(REPO, 'web/src')),
    ...sourceFiles(path.join(REPO, 'server')),
  ];

  it('源文件 ≤ 600 行（老户按冻结上限，只降不升）', () => {
    const overs = [];
    for (const f of files) {
      const rel = path.relative(REPO, f).split(path.sep).join('/');
      const src = fs.readFileSync(f, 'utf8');
      const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);   // 与 wc -l 同口径
      const ceiling = GRANDFATHERED[rel] ?? LIMIT;
      if (lines > ceiling) overs.push(`${rel}: ${lines} > ${ceiling}`);
    }
    expect(overs, `超标（胖了就拆，别抬上限）:\n${overs.join('\n')}`).toEqual([]);
  });

  it('冻结表不养幽灵：表里的文件都真实存在（拆完/删掉的从表里摘）', () => {
    const ghosts = Object.keys(GRANDFATHERED)
      .filter(rel => !fs.existsSync(path.join(REPO, rel)));
    expect(ghosts).toEqual([]);
  });
});
