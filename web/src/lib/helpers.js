/** 通用工具函数 */

export function classNames(...args) {
  return args.filter(Boolean).join(' ');
}

export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 时间戳 → Date。SQLite 的 `datetime('now')` 落的是 **UTC 但不带时区标记**的
 * "YYYY-MM-DD HH:MM:SS"，JS 按规范会把这种格式当**本地时间**解析——东八区就凭空
 * 差 8 小时（实测项目卡片上 6 小时前的东西显示成"14 小时前"，新建的东西因为落在
 * 未来一直显示"刚刚"）。这里显式补 'Z' 按 UTC 解。带 T / 带时区的 ISO 串原样走。
 */
function parseStamp(value) {
  if (!value) return null;
  const s = String(value);
  const naiveSqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s);
  const d = new Date(naiveSqlite ? `${s.replace(' ', 'T')}Z` : s);
  return isNaN(d.getTime()) ? null : d;
}

/** ISO → "YYYY-MM-DD" */
export function formatDate(iso) {
  const d = parseStamp(iso);
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "刚刚" / "X 分钟前" / "X 小时前" / "X 天前" */
export function timeAgo(iso) {
  const at = parseStamp(iso);
  if (!at) return '';
  const ms = Date.now() - at.getTime();
  if (isNaN(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatDate(iso);
}

/** 安全 JSON parse，失败返回 fallback */
export function safeJsonParse(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/** 文件大小人话：123 → "123 B" / "1.2 KB" / "3.4 MB" */
export function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
