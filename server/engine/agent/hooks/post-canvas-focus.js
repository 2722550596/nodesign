/**
 * PostToolUse(Edit|Write canvas.html) handler — Canvas 焕新升级 S1d。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 *
 * focus_page：检测改动落在哪些 <section data-page="N"> + 改动里有没有
 *   data-anchor="..." 引用 → emit run.canvas_focus_page(pages, anchor?)
 *   → 前端 SlideNavigator 自动 scrollIntoView + 1.5s pulse 高亮
 *
 * 不返 hookSpecificOutput / 不阻塞 agent / 不注 additionalContext。
 *
 * 检测策略（Edit / Write 都要看）：
 *   - Edit：从 tool_input.new_string 找 data-page / data-anchor
 *     （保守 — 只看新增的，不重复扫旧 content）
 *   - Write：从 tool_input.content 找（整文件都是新内容）
 *   - 非 canvas.html 文件：跳过
 *   - file_path 是相对 cwd 的，没法判断到底是不是 canvas.html，按 basename 匹配
 *
 * 失败 fail-soft：emit fail / 解析炸都不抛，console.warn 一行。
 */
import { Events } from '../events.js';

export function makePostToolUseCanvasFocusPageHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const filePath = input?.tool_input?.file_path;
      if (!filePath || typeof filePath !== 'string') return {};
      // deck 现在叫 <名>.html（canvas.html 只是常用名）：名字兜底 + 读文件看 deck wrap 标记
      if (!/\.html?$/i.test(filePath)) return {};
      if (!/(?:^|[/\\])canvas\.html$/i.test(filePath)) {
        let isDeck = false;
        try {
          const { promises: fsp } = await import('node:fs');
          const head = (await fsp.readFile(filePath, 'utf8')).slice(0, 200_000);
          isDeck = head.includes('__nd-deck-wrap');
        } catch { /* 相对路径读不到 / 文件没了：不是 deck 就当 */ }
        if (!isDeck) return {};
      }

      // 取改动文本：Edit 看 new_string，Write 看 content
      const toolName = input?.tool_name;
      let changeText = '';
      if (toolName === 'Edit') {
        changeText = String(input?.tool_input?.new_string || '');
      } else if (toolName === 'Write') {
        changeText = String(input?.tool_input?.content || '');
      } else {
        return {};
      }
      if (!changeText) return {};

      // focus_page —— 找 <section ... data-page="N"> + 可选 data-anchor
      try {
        const pageMatches = [...changeText.matchAll(
          /<section\b[^>]*\bdata-page\s*=\s*['"]?(\d+)['"]?/gi
        )];
        const pages = [...new Set(pageMatches.map(m => parseInt(m[1], 10)))]
          .filter(n => Number.isFinite(n));

        // 找 data-anchor — 取第一个，前端用它精确定位元素
        const anchorMatch = changeText.match(/\bdata-anchor\s*=\s*['"]([^'"]+)['"]/i);
        const anchor = anchorMatch ? anchorMatch[1] : null;

        // Edit 改的是 page 内某段时不会包含 <section data-page>，要从 file path
        // 上推 ——但 hook 时 canvas.html 已写完，可以读出来定位。为避免 hook IO
        // 阻塞 agent，这次先只 emit 显式带 data-page 的改动；不带 page 但带 anchor
        // 也 emit（前端能找到 anchor 元素自己反推 page）。
        if (pages.length > 0 || anchor) {
          ctx.emit(Events.canvasFocusPage(pages, anchor));
        }
      } catch (err) {
        console.warn(`[hooks/canvas_focus_page] handler partial failure:`, err.message);
      }

      return {};
    } catch (err) {
      console.warn(`[hooks/canvas_focus_page] outer handler threw:`, err.message);
      return {};
    }
  };
}
