/**
 * 路径拼接纪律扫描（2026-08-14「根站空串病族」的钉子）
 *
 * 铁律见 lib/paths.js：空串是合法路径（根站/根世界的 base 就是 ''），
 * 硬拼 `${base}/${x}` 会造出前导斜杠（403）或空段（404）。
 *
 * 这份测试静态扫 web/src 全部 js/jsx：
 *   1. 路径味变量的插值后面直接跟 `/`（`${base}/…`）→ 该用 joinRel
 *   2. 重新拼 `tasks/${…}` 旧前缀 → 扁平化后是错路径
 *
 * 确认某处安全（例如带三元守卫的前缀构造），行内标 `path-compose-ok` 放行。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinRel } from './paths.js';

describe('joinRel', () => {
  it('空段跳过，绝不产出前导/双斜杠', () => {
    expect(joinRel('', 'index.html')).toBe('index.html');
    expect(joinRel(null, 'index.html')).toBe('index.html');
    expect(joinRel('posts', 'a.html')).toBe('posts/a.html');
    expect(joinRel('', '', 'x')).toBe('x');
    expect(joinRel()).toBe('');
  });
});

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATHY_INTERP = /\$\{[^}]*\b(base|baseRel|root|srcRoot|toDir|relPath|bookPath|deckRelPath)\b[^}]*\}\//;
const LEGACY_TASKS = /`[^`]*tasks\/\$\{/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) yield p;
  }
}

describe('路径拼接纪律', () => {
  it('src 里没有硬拼路径的模板串（该用 joinRel；确认安全标 path-compose-ok）', () => {
    const hits = [];
    for (const file of walk(SRC_ROOT)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (line.includes('path-compose-ok')) return;
        if (PATHY_INTERP.test(line) || LEGACY_TASKS.test(line)) {
          hits.push(`${path.relative(SRC_ROOT, file)}:${i + 1}  ${t.slice(0, 100)}`);
        }
      });
    }
    expect(hits, `硬拼路径（根站空串病族），改用 lib/paths.js 的 joinRel：\n${hits.join('\n')}`).toEqual([]);
  });
});
