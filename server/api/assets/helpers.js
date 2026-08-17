/**
 * assets/helpers.js — assets 这一族路由共用的小纯函数。
 *
 * 为什么单独一个文件：2026-08-17 把便签路由拆出去时，这两个函数一个被落下、
 * 一个被误带走 —— `node --check` 不报、vite build 不报、单测也不报，只有
 * `no-undef.lint` 抓到了。给它们一个**双方都 import 的家**，这一类事故就
 * 不会再随下一次拆分复发（谁也不用记得"这个函数该跟着谁走"）。
 */

/** 单层路径片段：不含分隔符、不含 `..`、不以点开头、长度可控 */
export function safeSegment(s) {
  return typeof s === 'string' && !!s && s.length <= 200
    && !s.includes('/') && !s.includes('\\') && !s.includes('..') && !s.startsWith('.');
}

/** 便签 frontmatter：只认最简单的 `---\nsession: xxx\n---` 头，其余原样当正文 */
export function parseNoteFrontmatter(raw) {
  const m = /^---\n([\s\S]{0,500}?)\n---\n?/.exec(raw);
  if (!m) return { body: raw, sessionId: null };
  const sm = /(?:^|\n)session:\s*([A-Za-z0-9-]{8,64})\s*(?:\n|$)/.exec(m[1]);
  return { body: raw.slice(m[0].length).replace(/^\n+/, ''), sessionId: sm ? sm[1] : null };
}
