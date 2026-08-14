/**
 * web/src/lib/paths.js — 工作区相对路径的唯一拼接口（2026-08-14）
 *
 * 铁律：**空串是合法路径**。扁平化之后站点/世界住在工作区根上，它们的
 * base / task / root 就是 ''。硬拼 `${base}/${entry}` 会造出 `/index.html`
 * （前导斜杠 → 服务端按绝对路径判越界 403）或 `tasks//x`（空段 → 404）——
 * 2026-08-14「根站空串病族」一次抓出五处，全是这一个写法的变体。
 *
 * 所以：凡是把 base/root/dir 跟下级路径拼起来，一律走 joinRel，不许手写
 * `${a}/${b}`。这条由 path-compose.lint.test.js 静态扫描钉住（随 vitest 跑，
 * 逃逸口是行内 `path-compose-ok` 标记）。
 */

/** 拼工作区相对路径：空段（'' / null / undefined）自动跳过，绝不产出前导/双斜杠 */
export const joinRel = (...segs) => segs.filter(Boolean).join('/');
