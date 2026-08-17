/**
 * exports/docx-pdf.js — docx → PDF 导出。
 *
 * 单开一个文件而不是往 exports.js 的 pdf 路由里塞 if：那条路由整段是
 * playwright + `<section data-page>` 的 deck 逻辑，docx 跟它一行代码都不共享
 * （LibreOffice 直接出 PDF，没有分页 section 这回事）。
 *
 * ⚠️ 这里出的 PDF 跟用户在 Word 里「另存为 PDF」**不是同一个东西** —— 域
 * （TOC）不更新、中文是替身字体。给用户下载时说清楚：要发出去的正式
 * PDF，请在 Word 里导；这份是快速预览用的。
 */

import { renderDocx, cleanupRender } from '../../lib/docx/render.js';

/**
 * @param {import('express').Response} res
 * @param {{absPath:string, relPath:string}} target
 */
export async function docxToPdfResponse(res, target) {
  let out;
  try {
    out = renderDocx(target.absPath, {});     // 只要 pdf，不出 png
  } catch (err) {
    return res.status(500).json({
      error: 'LibreOffice 转换失败',
      details: String(err.message || err).slice(0, 500),
    });
  }
  try {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(out.pdf);
    const stem = target.relPath.replace(/\.docx$/i, '').split('/').pop() || '文档';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${stem}.pdf`)}`,
    );
    res.setHeader('Content-Length', buf.length);
    // 让下载方知道这份 PDF 的成色，别拿它当正式稿发出去
    res.setHeader('X-Docx-Pdf-Note', 'toc-field-not-updated; substituted-cjk-fonts');
    res.end(buf);
  } finally {
    cleanupRender(out);
  }
  return undefined;
}
