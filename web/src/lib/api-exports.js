/**
 * web/src/lib/api-exports.js — 导出族的 REST 包装（2026-08-19 从 api.js 拆出）
 *
 * 拆的理由是行数棘轮（api.js 顶到 600 上限，"胖了就拆，别抬上限"）。挑这一族
 * 走是因为它跟 api.js 其余部分不是一类东西：别的方法收 JSON，这一族收 **blob +
 * Content-Disposition 里的文件名**，各自带一段 res.ok 手写分支和自己的头解析，
 * 从来用不上 jsonRequest 的统一错误通道。`parseFilenameFromDisposition` 只服务
 * 这一族，跟着一起搬。
 *
 * 调用方无感：api.js 仍旧 `export { Exports }`，import 路径不用改。
 */

import { jsonRequest } from './api.js';

// ── Exports（H3：session-scoped）──
export const Exports = {
  /** 当前任务里可以单独导出的东西（deck / 图 / 其它产物）*/
  items: (pid) => jsonRequest('GET', `/api/projects/${pid}/exports/items`),

  /** 挑几样下载：单个原样、多个打 zip。返回 { blob, filename } */
  pick: async (pid, paths, filename) => {
    const res = await fetch(`/api/projects/${pid}/exports/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, filename }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    return { blob: await res.blob(), filename: parseFilenameFromDisposition(res.headers.get('content-disposition')) };
  },

  /**
   * 烘焙类导出（html / pdf / pptx）。relPath 点名导哪一份产物 —— 不传就走寻址层
   * 的默认目标。这几种要跑 playwright / esbuild，跟按卡打包不是一条管线。
   */
  download: async (pid, format, relPath) => {
    const q = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
    const res = await fetch(`/api/projects/${pid}/exports/${format}${q}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    const blob = await res.blob();
    const filename = parseFilenameFromDisposition(res.headers.get('content-disposition'));
    return { blob, filename };
  },

  /**
   * 按**产物卡**导出（2026-08-17 重做）。cardIds 就是画布上的卡 id。
   * 一张卡也走这条，「导出全部图片」就是多传几个 id。
   * 收不到的卡不拖累整批 —— 从 X-Export-Skipped 头里取回来，调用方要提示出去，
   * 静默少东西是导出最贵的失败方式。
   */
  cards: async (pid, cardIds, format) => {
    const res = await fetch(`/api/projects/${pid}/exports/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardIds, format }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // 全军覆没时具体原因在 body 的 skipped 里，只报 error 的话用户只看到
      // 「一张都没收到」，不知道是哪张、为什么
      const detail = data.skipped?.[0]?.reason;
      throw Object.assign(new Error(detail || data.error || res.statusText), { status: res.status });
    }
    let skipped = { total: 0, items: [] };
    const raw = res.headers.get('x-export-skipped');
    if (raw) { try { skipped = JSON.parse(decodeURIComponent(raw)); } catch { /* 头坏了不该拖垮下载 */ } }
    return {
      blob: await res.blob(),
      filename: parseFilenameFromDisposition(res.headers.get('content-disposition')),
      skipped,
    };
  },

  list: (pid) => jsonRequest('GET', `/api/projects/${pid}/exports`),

  downloadFile: async (pid, filename) => {
    const res = await fetch(`/api/projects/${pid}/exports/file/${encodeURIComponent(filename)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    const blob = await res.blob();
    return { blob, filename };
  },
};

function parseFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  if (m) return decodeURIComponent(m[1].replace(/^"|"$/g, ''));
  const m2 = /filename="([^"]+)"/.exec(disposition);
  return m2 ? m2[1] : null;
}
