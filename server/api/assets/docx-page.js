/**
 * assets/docx-page.js — `GET /:pid/docx-page` 的处理器。
 *
 * 画布上的缩略图和产物窗里的翻页吃的是同一份缓存：一次 LibreOffice 出整份，
 * 翻页零成本（详见 lib/docx-pages.js）。给 `w` 就缩到那个宽度出 webp，
 * 缩略图走这条 —— 不为小一号再起一次 soffice。
 *
 * 单开一个文件是因为它跟 assets.js 其余路由一行代码都不共享，而 assets.js
 * 已经压在行数棘轮的上限上。（依赖用注入的，不去 import assets.js 的内部件 ——
 * 那会绕成一个环。）
 *
 * ⚠️ 冷启第一次会真跑渲染（几百毫秒到两秒），前端要能等 —— **别在这条路上加
 * 超时重试**，重试只会把同一份文档排进闸门两次。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pageImage } from '../../lib/docx-pages.js';

/** 缩略图宽度上限：再大就不是缩略图了，纯粹是让服务端白干 */
const MAX_WIDTH = 2000;

export function makeDocxPageHandler({ getSharedDir, guardProject }) {
  return async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const rel = String(req.query.path || '').replace(/\\/g, '/');
      if (!rel || !/\.docx$/i.test(rel)) return res.status(400).json({ error: 'path 得是一个 .docx' });

      const root = getSharedDir(req.params.pid);
      const abs = path.resolve(root, rel);
      const within = path.relative(root, abs);
      if (within.startsWith('..') || path.isAbsolute(within)) {
        return res.status(403).json({ error: 'path escapes workspace' });
      }

      let stat;
      try { stat = await fs.stat(abs); } catch { return res.status(404).json({ error: '找不到这份文档' }); }

      // ETag 带 mtime + size：agent 一 rebuild 就换 key，浏览器自然重取
      const w = Math.min(Math.max(0, Number(req.query.w) || 0), MAX_WIDTH);
      const pageNo = Math.max(1, Number(req.query.page) || 1);
      const etag = `"${stat.mtimeMs}-${stat.size}-${pageNo}-${w}"`;
      if (req.headers['if-none-match'] === etag) return res.status(304).end();

      let out;
      try {
        out = await pageImage(abs, pageNo, w ? { width: w } : {});
      } catch (err) {
        console.warn('[docx-page] render failed:', err.message);
        return res.status(err.status || 500).json({
          error: '渲染失败',
          details: String(err.message || err).slice(0, 300),
        });
      }
      res.set('ETag', etag);
      res.set('Cache-Control', 'private, max-age=60');
      // 页数给前端画翻页控件，省一次单独的请求
      res.set('X-Docx-Pages', String(out.count));
      res.type(out.mime).send(out.buf);
    } catch (err) { next(err); }
  };
}
