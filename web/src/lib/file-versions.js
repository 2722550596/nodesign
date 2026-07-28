/**
 * file-versions.js — 按文件的刷新版本号（2026-07-28）
 *
 * 原来只有一个全局 `reloadToken`：agent 每写一笔就 +1，所有 iframe 的 `?v=` 一起变。
 * 后果有三个，用户三条都碰上了：
 *   ① 一个任务里有多份 deck 时，改其中一份会让**全部** iframe 同时重载 → 整屏闪
 *   ② 每次工具调用完都重拉一遍产物清单，agent 一轮几十笔，白刷几十次
 *   ③ 重载风暴里只要有一次请求失败，`reload()` 的 `.catch(() => ({artifacts: []}))`
 *      就把画布清空 —— 用户看到的是"所有内容消失，必须刷新整页"
 *
 * 改成按文件记版本：谁被改了只有谁的 `?v=` 变。粒度按**渲染单位**取：
 *   - deck 卡渲染一个文件 → 用那个文件自己的版本
 *   - 站点卡渲染整个目录（改 style.css 也要重渲页面）→ 取该任务下所有文件的版本和
 *
 * 这样"只在有实际内容更新时才刷新"是自然结果，不需要额外判断。
 */

/**
 * agent 给的 file_path（绝对路径或相对 cwd）→ workspace 相对路径。
 * 认不出来的返回 null（不参与版本记账）。
 */
export function workspaceRelOf(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const p = filePath.replace(/\\/g, '/');
  const m = p.match(/(?:^|\/)((?:tasks|assets|agent-memory)\/.+)$/);
  if (m) return m[1];
  // 旧式会话：产物就在 cwd 根（canvas.html / spec.json …）
  const base = p.slice(p.lastIndexOf('/') + 1);
  return base && !base.includes('/') ? base : null;
}

/** 单个文件的版本号 */
export function versionOfFile(versions, rel) {
  if (!versions || !rel) return 0;
  return versions[rel] || 0;
}

/**
 * 一个任务目录整体的版本号（该目录下所有文件版本之和）。
 * 站点用它：改 `style.css` 或任意子页，整站预览都该重渲。
 */
export function versionOfTask(versions, task) {
  if (!versions || !task) return 0;
  const prefix = `tasks/${task}/`;
  let sum = 0;
  for (const [k, v] of Object.entries(versions)) {
    if (k.startsWith(prefix)) sum += v;
  }
  return sum;
}

/**
 * 记一笔改动。返回新的 versions 对象；路径认不出来时返回原对象（引用不变，
 * 不触发 React 重渲）。
 */
export function bumpFileVersion(versions, filePath) {
  const rel = workspaceRelOf(filePath);
  if (!rel) return versions;
  return { ...versions, [rel]: (versions[rel] || 0) + 1 };
}
