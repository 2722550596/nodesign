/**
 * 遗留形状 lint（2026-08-14 可维护性行动 A 刀）。
 *
 * 十二批的口诀：**兼容字段喂下游之后，判它真值的分支全变死路且不报错**。
 * 那天一口气挖出四窝（exports 死分支 / record_decision 悬空引用 / noteTask
 * 恒 null / detectArtifact 死代码），全是 `tasks/` 时代的形状残留。这里把
 * "代码里再出现任务模型的路径形状"钉死 —— 注释里讲历史随便讲，**代码**里
 * 再写就是在造下一窝。
 *
 * 刻意保留的兼容点加行内 `legacy-ok` 标记放行（目前仅 noteTask 兼容老数据
 * 一处）；迁移器本体（workspace-flatten.js，M3b 从 workspace.js 搬出）整文件豁免 —— 它的工作就是消化旧形状。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const EXEMPT_FILES = new Set([
  'server/projects/workspace-flatten.js',   // tasks/→扁平迁移器：消化旧形状是它的本职（M3b 从 workspace.js 搬出）
]);

/**
 * 剥掉注释（块注释 + 行注释）。粗剥即可 —— 宁可漏报不误报。
 *
 * ⚠️ **必须保住行号**（2026-08-17 修）：原来块注释是整段删掉的，连换行一起没了，
 * 剥完的数组比原文短（实测一个 98 行的文件短 10 行）。于是命中 `stripped[i]` 之后
 * 去查 `rawLines[i]` 查的是**另一行** —— `legacy-ok` 豁免机制从来没生效过，
 * 报出来的行号也是错的，之前"通过"是错位撞的运气。
 * 现在块注释按原换行数替换成空行，两个数组逐行对齐。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) || []).length))
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { sourceFiles(p, out); continue; }
    if (!/\.(js|jsx|mjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
    if (/^_.*-check\.mjs$/.test(e.name)) continue;   // 自检脚本：合成旧形状当 fixture 是它的本职
    out.push(p);
  }
  return out;
}

describe('遗留形状不进代码', () => {
  it("代码里不再出现 'tasks/' 路径形状（注释与迁移器除外，legacy-ok 放行）", () => {
    const hits = [];
    const files = [
      ...sourceFiles(path.join(REPO, 'web/src')),
      ...sourceFiles(path.join(REPO, 'server')),
    ];
    for (const f of files) {
      const rel = path.relative(REPO, f).split(path.sep).join('/');
      if (EXEMPT_FILES.has(rel)) continue;
      const raw = fs.readFileSync(f, 'utf8');
      const rawLines = raw.split('\n');
      const stripped = stripComments(raw).split('\n');
      stripped.forEach((line, i) => {
        if (!/['"`]tasks\//.test(line)) return;
        if ((rawLines[i] || '').includes('legacy-ok')) return;
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    expect(hits, `任务模型的路径形状回魂了：\n${hits.join('\n')}`).toEqual([]);
  });
});
