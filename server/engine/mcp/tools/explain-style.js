/**
 * mcp/tools/explain-style.js — explain_style（2026-08-18）
 *
 * ## 这个洞是什么
 *
 * `get_computed_styles` 告诉你**结果**（marginBottom: 0px），不告诉你**为什么**。
 * 浏览器 devtools 的 Styles 面板会把败下阵的声明划掉，一眼就看得出是谁赢了 ——
 * agent 手里恰恰没有 devtools。
 *
 * 真实案例：用户圈出"这里太挤了、很贴底边"。真因是 `.wrap { margin: 0 auto }`
 * 这条**简写** —— 类选择器优先级高于 `main > section { margin-bottom: 108px }`，
 * 把所有带 .wrap 的节的下边距清成了 0，全站每一节都在吃这个亏。
 * 定位过程：computed 报 0px（对的，但只告诉结果）→ 怀疑外边距塌陷 → 怀疑媒体
 * 查询 → 怀疑变量没解析 → grep 整个 CSS → 都排除后才想到是简写覆盖。
 * **五六轮工具调用，而 devtools 里这是一眼的事。**
 *
 * 这类 bug 在"一份手写 CSS + 后加的工具类"的站点上非常常见 —— 也就是这个平台上
 * 绝大多数站点。
 *
 * ## 实现
 *
 * 走 CDP 的 `CSS.getMatchedStylesForNode`：它按级联次序返回命中该元素的全部规则，
 * 我们从里面挑出跟目标属性有关的声明（**含简写展开**），标出谁赢、谁被压掉、
 * 各自来自哪条规则。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveCanvasTarget, CANVAS_PATH_DESC, requireBrowsable } from '../../../lib/artifact-target.js';
import { openArtifactPage, FIDELITY_LAUNCH_ARGS, degradedNote } from './helpers/perception-page.js';

/** 简写 → 它能设置的长手属性（只列常踩的那些，够覆盖真实事故） */
const SHORTHAND_OF = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  border: ['border-width', 'border-style', 'border-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  background: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat'],
  font: ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: ['animation-name', 'animation-duration', 'animation-timing-function'],
  'grid-template': ['grid-template-rows', 'grid-template-columns'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
};

/** 一条声明是否影响目标属性：直接同名，或者是能设置它的简写 */
function affects(declName, prop) {
  if (declName === prop) return { hit: true, viaShorthand: null };
  const longhands = SHORTHAND_OF[declName];
  if (longhands && longhands.includes(prop)) return { hit: true, viaShorthand: declName };
  return { hit: false };
}

export function makeExplainStyleTool({ workspaceRoot, projectId, sessionId }) {
  return tool(
    'explain_style',
    `Explain WHY one CSS property has the value it has: every declaration that
matched the element, in cascade order, with the winner marked and the losers
listed — including declarations that came from a SHORTHAND.

get_computed_styles gives you the result; this gives you the reason. Reach for it
the moment a value is not what your CSS says it should be, instead of guessing
through margin collapse / media queries / unresolved variables one at a time.

The case this was built for: a section's margin-bottom computed to 0px even
though the stylesheet said 108px. Cause was ".wrap { margin: 0 auto }" — a
shorthand on a class selector, higher specificity than "main > section", zeroing
the bottom margin of every .wrap section on the site. Five or six tool calls to
find by elimination; one call here.

Note it reports the FIRST element matching the selector.`,
    {
      selector: z.string().min(1)
        .describe('CSS selector — the first match is explained. Plain CSS only (no :has-text, >>, nth=).'),
      property: z.string().min(1)
        .describe('The CSS property to explain, e.g. "margin-bottom", "color", "display". Use the longhand name when you can — asking about "margin" tells you less than asking about "margin-bottom".'),
      path: z.string().optional().describe(CANVAS_PATH_DESC),
      device: z.enum(['desktop', 'tablet', 'mobile']).optional()
        .describe('Viewport width, so media queries resolve the way they do at that breakpoint (default desktop 1440).'),
    },
    async ({ selector, property, path: relPath, device }) => {
      const asText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
      const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
      if (!target) return asText('No page found.', true);
      const guard = requireBrowsable(target);
      if (guard) return asText(guard, true);

      const W = { desktop: 1440, tablet: 834, mobile: 390 }[device || 'desktop'];
      const prop = property.trim().toLowerCase();

      let browser;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true, args: FIDELITY_LAUNCH_ARGS });
        const opened = await openArtifactPage(browser, {
          projectId, workspaceRoot, absPath: target.absPath, viewport: { width: W, height: 900 },
        });
        await opened.goto();
        const page = opened.page;

        const computed = await page.evaluate(([sel, p]) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          return getComputedStyle(el).getPropertyValue(p);
        }, [selector, prop]);
        if (computed === null) return asText(`Selector matched no elements: ${selector}`, true);

        const cdp = await page.context().newCDPSession(page);
        // styleSheetId → 文件名。同一个 selector 出现在两个文件里时（reset + 组件，
        // 最常见的那种），光打 `.card` 两行人分不出谁是谁。**必须在 CSS.enable
        // 之前挂监听** —— 已有的样式表是在 enable 的那一刻补发的。
        const sheetName = new Map();
        cdp.on('CSS.styleSheetAdded', (ev) => {
          // ⚠️ `isInline` 要**先**判：`<style>` 块的 sourceURL 是文档自己的地址，
          // 按 URL 取名会打出 `page.html?nd=raw` 这种（连我们内部的 raw 参数都漏给
          // agent 看），而它其实是"页面里那段 <style>"
          const url = ev?.header?.sourceURL || '';
          const name = ev?.header?.isInline ? '<style> 内联'
            : (url ? decodeURIComponent((url.split('?')[0] || url).split('/').pop() || url) : '');
          if (ev?.header?.styleSheetId) sheetName.set(ev.header.styleSheetId, name);
        });
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) return asText(`Selector matched no elements: ${selector}`, true);
        const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });

        // 收集：CDP 的 matchedCSSRules 按**优先级递增**排（最后一条最强）
        const rows = [];
        const push = (where, style, extra = {}) => {
          for (const d of style?.cssProperties ?? []) {
            if (d.disabled) continue;
            const a = affects(String(d.name).toLowerCase(), prop);
            if (!a.hit) continue;
            // ⚠️ CDP 这一版的 `d.value` **本身就带着** `!important`，再拼一次会打出
            // `color: red !important !important` —— 看起来像源码里真写了两遍
            const val = String(d.value).replace(/\s*!\s*important\s*$/i, '');
            rows.push({
              where,
              decl: `${d.name}: ${val}${d.important ? ' !important' : ''}`,
              important: !!d.important,
              viaShorthand: a.viaShorthand,
              ...extra,
            });
          }
        };

        let ruleIdx = 0;
        for (const m of matched.matchedCSSRules ?? []) {
          const sel = m.rule?.selectorList?.text ?? '?';
          const sheet = m.rule?.origin === 'user-agent' ? 'browser default'
            : (matched.cssKeyframesRules ? null : null);
          const media = (m.rule?.media ?? []).map(x => x.text).filter(Boolean).join(' and ');
          const from = sheet || sheetName.get(m.rule?.styleSheetId) || '';
          push(`${sel}${media ? ` @media ${media}` : ''}${from ? ` [${from}]` : ''}`, m.rule?.style, {
            origin: m.rule?.origin,
            ruleIdx: ruleIdx++,   // ⭐ 合并键，见下面那段注释
          });
        }
        if (matched.inlineStyle) push('element inline style="…"', matched.inlineStyle, { inline: true, ruleIdx: 'inline' });

        // 合并同一条规则里的重复条目。CDP 会把简写和它展开出来的长手**都**列一遍
        // （`.wrap { margin: 0 auto }` 出两条：`margin: 0 auto` + `margin-bottom: 0px`），
        // 直接打印就是四行里两行是同一件事。留长手那条（它给的是真正生效的值），
        // 把"来自哪个简写"作为标注挂上去。
        //
        // ⛔ 合并键必须是**规则本身**（ruleIdx），不能是 selector 文本。审查实测：
        // `reset.css` 里 `.card{color:red!important}` 加 `component.css` 里
        // `.card{color:blue}` —— 两条不同规则碰巧同 selector，按文本合并会折成一条，
        // `same.decl = r.decl` 留下后者的值（蓝）、`same.important ||=` 又把 red 的
        // important 标志过继给它，于是工具报「蓝赢」而浏览器画的是红，**真正的赢家
        // 一行都没出现**。正好命中它的目标人群：手写 CSS 上面又叠了 reset/工具类。
        const merged = [];
        for (const r of rows) {
          const same = merged.find(x => x.ruleIdx === r.ruleIdx);
          if (!same) { merged.push({ ...r }); continue; }
          const rIsLonghand = !r.viaShorthand;
          if (rIsLonghand) {
            same.decl = r.decl;                      // 长手的值才是生效值
            same.important = same.important || r.important;
          } else if (!same.viaShorthand) {
            same.viaShorthand = r.viaShorthand;      // 把简写来历补到长手那条上
          }
          if (r.viaShorthand) same.viaShorthand = r.viaShorthand;
        }
        rows.length = 0;
        rows.push(...merged);

        if (!rows.length) {
          return asText([
            `${selector} → ${prop} computes to "${computed}"`,
            '',
            'No declaration anywhere sets this property (directly or via a shorthand).',
            'So the value is inherited or the property\'s initial value — if that surprises you,',
            'the property you wrote is probably not the one you think controls this.',
          ].join('\n'));
        }

        // 赢家：!important 的最后一条 > 普通的最后一条（inline 已经排在最后）
        const importants = rows.filter(r => r.important);
        const winner = importants.length ? importants[importants.length - 1] : rows[rows.length - 1];

        const degraded = degradedNote(opened);   // 契约：note 非空必须写进返回文本
        const lines = [
          ...(degraded ? [degraded, ''] : []),
          `${selector} → ${prop} computes to "${computed}"  (viewport ${W}px)`,
          '',
          'Declarations that matched, weakest first:',
        ];
        for (const r of rows) {
          const mark = r === winner ? '✅ WINS  ' : '   lost  ';
          const via = r.viaShorthand
            ? `   ⭐ via the "${r.viaShorthand}" SHORTHAND — it sets ${prop} even though it does not name it`
            : '';
          lines.push(`${mark}${r.decl}\n         from  ${r.where}${via}`);
        }
        if (winner.viaShorthand) {
          lines.push('', `⭐ The winning declaration is a shorthand ("${winner.viaShorthand}"). This is the`
            + ' single most missable cause of "my CSS says X but the page shows Y": a shorthand on a'
            + ' higher-specificity selector silently resets longhands you set elsewhere. Fix by using'
            + ` the longhand there, or by setting ${prop} again after it.`);
        }
        return asText(lines.join('\n'));
      } catch (err) {
        return asText(`explain_style failed: ${err?.message || String(err)}`, true);
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  );
}
