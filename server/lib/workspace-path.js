import path from 'node:path';

/**
 * 工具入参里的 `file_path` → **工作区相对路径**。
 *
 * ## 为什么这件事必须在服务端做
 *
 * 画布上的物件 id 就是工作区相对路径（2026-08-08：`deck:鉴赏页/主稿.html`、
 * `site:伊蕾娜手账研究站`、文件夹就是路径本身）。而 agent 的工具入参给的多半是
 * **绝对路径**（Write / Edit 要求绝对），只有服务端知道工作区根在哪。
 *
 * 扁平化之前前端能自己抠：绝对路径里有 `tasks/<任务>/` 这个特征段，正则一锚就
 * 拿到相对部分。`tasks/` 那层拆掉之后，绝对路径里**再没有任何可锚定的标志** ——
 * 工作区根就是项目目录本身，名字是随机 id。前端猜不出来，也不该猜。
 *
 * 所以凡是要发给前端当"物件寻址依据"的路径，一律在 emit 之前过这一道。
 * 漏掉的症状是**不报错**的：舞台卡认不出目标 → 静静地掉进屏幕底部的 dock，
 * 看起来只是"agent 干活时画布没反应"。
 *
 * @param {string} filePath      绝对路径或相对 cwd 的路径
 * @param {string} workspaceRoot 工作区根（agent 的 cwd）
 * @returns {string} 工作区相对路径；不在工作区里的原样返回
 */
export function toWorkspaceRel(filePath, workspaceRoot) {
  if (typeof filePath !== 'string' || !filePath) return '';
  const p = filePath.replace(/\\/g, '/');
  if (!workspaceRoot) return p;
  const root = path.resolve(workspaceRoot);
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  // 工作区根自己 → 空串（"就是这张桌面"）；根之外的路径原样退回，让调用方决定
  if (abs === root) return '';
  return abs.startsWith(root + path.sep) ? abs.slice(root.length + 1) : p;
}
