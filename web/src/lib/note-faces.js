/**
 * note-faces — 便利贴分面约定（2026-07-30）
 *
 * 一张便利贴 = 一个 .md；`\n---\n` 分面（record_decision / hooks 注入的面数
 * 统计用同一分隔符，改这里要三处一起改）。每面首行 `# 标题` 可选。
 */

/** 把便签正文拆成面数组（去空面；至少返回一面）*/
export function splitNoteFaces(text) {
  const faces = String(text || '').replace(/\r\n/g, '\n')
    .split(/\n---\n/)
    .map(s => s.trim())
    .filter(Boolean);
  return faces.length ? faces : [''];
}

/** 抽一面的标题（首行 `# 标题`）和剩余正文 */
export function faceParts(face) {
  const m = /^#[ \t]+(.+)(?:\n|$)/.exec(face || '');
  if (!m) return { title: null, body: (face || '').trim() };
  return { title: m[1].trim(), body: face.slice(m[0].length).trim() };
}
