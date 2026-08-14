/**
 * canvas-id —— agent 侧画布 id 归一化（2026-08-14，摆位批）
 *
 * id = kind 前缀 + 工作区相对路径（board 的铁律）。agent 传进来的写法五花八门
 * （反斜杠 / ./ 前缀 / 裸 .html），read_board / arrange_on_board / create_on_board
 * 共用这一份归一。跟 pin_to_board 内联的那段同源同规则 —— 收敛计划里它也该
 * 迁过来（现在没动它：改稳定工具要单独一刀）。
 */

export function normalizeCanvasId(raw) {
  let id = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  if (!id || id.includes('..')) return null;
  if (id.endsWith('agent-memory/brand/memory.md')) return 'doc:brand';
  if (id.endsWith('agent-memory/memory.md')) return 'doc:_root';
  if (!/^(deck|site|doc|text|scribble):/.test(id) && /\.html?$/i.test(id)) return `deck:${id}`;
  return id;
}

/**
 * 它住在哪一层（服务端近似版）：显式 zone 字段优先，其次沿路径往上找第一个
 * 已知文件夹。已知集 = board.zones 的 key —— 比前端少了"服务端扫出来的任务
 * 目录"这一路，没摆过的深层目录会归到根。read_board 的输出里写明这是近似。
 */
export function layerOf(id, entry, knownFolders) {
  if (entry && typeof entry.zone === 'string') return entry.zone;
  const s = String(id);
  if (s.startsWith('doc:')) return '';
  const c = s.indexOf(':');
  const p = (c > 0 && /^[a-z]+$/.test(s.slice(0, c))) ? s.slice(c + 1) : s;
  let d = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  while (d && !knownFolders.has(d)) {
    const i = d.lastIndexOf('/');
    d = i > 0 ? d.slice(0, i) : '';
  }
  return d;
}
