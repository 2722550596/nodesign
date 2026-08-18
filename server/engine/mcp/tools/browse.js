/**
 * mcp/tools/browse.js — agent 真的会用浏览器（2026-08-18）
 *
 * 四个工具共用 `engine/browse/registry.js` 的常驻实例：
 *   browser_navigate / browser_read / browser_click / browser_screenshot
 *
 * ## 跟 screenshot_url 的分工
 *
 * `screenshot_url` 是**一次性一张图**：开一个全新 chromium、截、关。便宜，适合
 * 「我只想看一眼这个站长什么样」。它留着不动。
 *
 * 这一组是**有会话的浏览**：点链接、翻子页、登录态留得住、Cookie 同意弹窗点一次就
 * 不再弹。用户提这条的原话是「很多时候可以让 agent 主动去访问相关内容的网站获取
 * 灵感」——而在这之前想看一个站第三层的页面只能猜 URL。
 *
 * ## 搜索不归这里管
 *
 * agent 先用现有搜索通道找到目标站，**再用 URL 直接访问**（用户拍板）。所以这里
 * 没有内建搜索，只有导航/读/点/截。
 *
 * ## 出网闸
 *
 * 每个请求（含跳转的每一跳、iframe、子资源）都过 `lib/ssrf-guard.js`。闸长在工具的
 * 实现体里 —— agent 关不掉它。被拦的东西会**如实写进返回值**：闸静默拦掉再让 agent
 * 对着一个半残的页面猜，比拦不住只好一点。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { withBrowser, peek, _limits } from '../../browse/registry.js';
import { requestHelp } from '../../browse/handover.js';
import { checkUrl } from '../../../lib/ssrf-guard.js';
import { normalizeShot } from './screenshot.js';
import { capture } from '../../browse/capture.js';

const NAV_TIMEOUT = _limits.NAV_TIMEOUT_MS;
const asText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** 被闸拦掉的东西要如实报，但别把一页的几十个第三方追踪器全倒出来 */
function blockedNote(guard, since) {
  const fresh = guard.blocked.slice(since);
  if (!fresh.length) return null;
  const shown = fresh.slice(0, 4).map(b => `  ${b.url.slice(0, 90)} ← ${b.reason}`);
  return `⛔ 网络闸拦掉了 ${fresh.length} 个请求（内网/本机地址一律禁，这是硬边界，不是可配置项）：\n`
    + shown.join('\n') + (fresh.length > 4 ? `\n  …还有 ${fresh.length - 4} 个` : '');
}

/** 页面的一句话现状 —— 每个工具的返回值都带上，agent 不用再问"我现在在哪" */
async function where(page) {
  const [title, url] = await Promise.all([page.title().catch(() => ''), Promise.resolve(page.url())]);
  return `${title || '(无标题)'} — ${url}`;
}

export function makeBrowserNavigateTool({ projectId, ctx }) {
  return tool(
    'browser_navigate',
    `Open a URL in this project's persistent browser and report what loaded.

This is a REAL browser session, not a one-shot fetch: cookies, logins and
dismissed consent banners persist — across turns and across conversations for
this project. So you can go three levels into a site instead of guessing URLs.

Workflow this exists for: agree a design direction with the user, search for
sites that actually have that design, then come here and LOOK at them —
navigate, click through, screenshot what is worth borrowing.

Pair it with browser_read (text + the links on the page, so you can pick where
to go next), browser_click (for links that JS handles) and browser_screenshot.

Only http/https. Internal and private addresses are refused by a hard network
gate — that is a security boundary, not a setting. If a site is behind a
verification wall that you cannot get past, say so plainly instead of retrying;
some walls score the server's IP and no amount of retrying changes that.

Note: one browser per project, at most ${_limits.MAX_RESIDENT} on this machine
(1 vCPU). It shuts down after ${Math.round(_limits.IDLE_MS / 60000)} minutes idle
and reopens on the next call — the profile survives, so you stay logged in.`,
    {
      url: z.string().min(4).describe('Absolute http(s) URL.'),
      waitUntil: z.enum(['domcontentloaded', 'load', 'networkidle']).optional()
        .describe("How long to wait. Default 'domcontentloaded' (fastest, enough to read). Use 'networkidle' when the page builds itself with JS and comes back empty."),
    },
    async ({ url, waitUntil }) => {
      try {
        return await withBrowser(projectId, async ({ page, guard }) => {
          // ⭐ 先判再动，不要让浏览器为一个我们已经知道会被拒的地址离开当前页面。
          // 真跑发现的：agent 正看着 MDN，试了一次内网地址被闸拦下，**页面留在
          // chrome-error:// 上**——它原来那一页没了，后面的 read/screenshot 全对着
          // 一张错误页。闸不该让 agent 丢掉浏览上下文。
          // 这不削弱安全：CDP 闸照旧拦跳转与子资源（那些是预检看不见的）。
          const pre = await checkUrl(url);
          if (!pre.ok) {
            return asText([
              `没打开，也没离开当前页面 —— 网络闸拒了这个地址：${pre.reason}`,
              '内网与本机地址是硬边界（不是可配置项）。你还在：' + await where(page),
            ].join('\n'), true);
          }

          const since = guard.blocked.length;
          const before = page.url();
          let status = null;
          let navErr = null;
          try {
            const resp = await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: waitUntil || 'domcontentloaded' });
            status = resp?.status() ?? null;
          } catch (err) {
            navErr = err.message.split('\n')[0];
          }
          const gate = blockedNote(guard, since);
          // 跳转中途被拦（预检看不到的那种）会把页面留在错误页 —— 退回原处，
          // 别让 agent 的下一次 read/screenshot 对着一张 chrome 错误页
          if (navErr && /ERR_ACCESS_DENIED|BLOCKED_BY_CLIENT/.test(navErr)) {
            // ⚠️ 按**结果**判断退没退回去，不是按 goto 有没有抛错。
            // 真跑时 goto 抛了（导航被打断）但页面其实已经回到原处，于是我给 agent
            // 报了个假警报 —— 而假警报会训练 agent 忽略警报，比不报更坏。
            if (before && /^https?:/.test(before)) {
              await page.goto(before, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {});
              // goto 会「抛错但导航仍在进行」—— 抛错那一刻地址栏还是错误页，
              // 等它真落到 before 上再判，否则又是一个假警报（第二次栽在同一处）
              await page.waitForURL(before, { timeout: 8000 }).catch(() => {});
            }
            const restored = (() => { try { return page.url() === before; } catch { return false; } })();
            return asText([
              '没打开 —— 这个地址在跳转中途指向了内网，被网络闸拦下。',
              gate,
              restored ? `已退回你原来那一页：${await where(page)}`
                : '⚠️ 也没能退回原来那一页，现在这个标签是空的 —— 重新 browser_navigate 一个地址。',
            ].filter(Boolean).join('\n'), true);
          }
          if (navErr) {
            return asText([
              `导航失败：${navErr}`,
              '如果是超时：站点可能慢或者在挡自动化访问；试 waitUntil:"load"，或者换一个参考站。',
              gate,
            ].filter(Boolean).join('\n'), true);
          }
          // 让用户看得见 agent 在逛什么：低频信号走现有 EventBus，前端开/更新那扇窗。
          // 像素不走这里（那是 /ws/projects/:pid/browser 的活）。
          try { ctx?.emit?.({ type: 'run.browser_opened', url: page.url(), ts: new Date().toISOString() }); } catch { /* */ }
          return asText([
            `已打开${status ? `（HTTP ${status}）` : ''}：${await where(page)}`,
            gate,
            '下一步：browser_read 看内容和站内链接，browser_screenshot 看长什么样。',
          ].filter(Boolean).join('\n'));
        });
      } catch (err) {
        return asText(`browser_navigate 失败：${err.message}`, true);
      }
    },
  );
}

export function makeBrowserReadTool({ projectId }) {
  return tool(
    'browser_read',
    `Read the current page: its heading outline, its text, and the links on it.

The link list is the point — it is how you decide where to go next without
guessing URLs. Links are reported with their visible text so you can tell a
navigation item from a footer legal link.

Pass a selector to read one region instead of the whole page (e.g. "main",
"article", ".pricing") when the page is long and you only need one part.`,
    {
      selector: z.string().optional().describe('Read only this element (first match). Plain CSS only.'),
      maxChars: z.number().int().min(200).max(20000).optional()
        .describe('Cap on the text returned (default 4000). Text is truncated, never silently dropped.'),
      links: z.boolean().optional().describe('Include the link list (default true).'),
    },
    async ({ selector, maxChars, links }) => {
      const cap = maxChars ?? 4000;
      const wantLinks = links !== false;
      try {
        return await withBrowser(projectId, async ({ page, guard }) => {
          const since = guard.blocked.length;
          const data = await page.evaluate(({ sel, want }) => {
            const root = sel ? document.querySelector(sel) : (document.querySelector('main') || document.body);
            if (!root) return { missing: true };
            const headings = [...root.querySelectorAll('h1,h2,h3')]
              .map(h => `${'#'.repeat(Number(h.tagName[1]))} ${(h.textContent || '').trim().slice(0, 90)}`)
              .filter(t => t.length > 2).slice(0, 40);
            const seen = new Set();
            const linkList = want ? [...root.querySelectorAll('a[href]')].map((a) => {
              const href = a.href;
              if (!href || !/^https?:/.test(href) || seen.has(href)) return null;
              seen.add(href);
              const label = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
              return { href, label, internal: a.hostname === location.hostname };
            }).filter(Boolean).slice(0, 60) : [];
            return {
              text: (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim(),
              headings, linkList,
              counts: {
                sections: root.querySelectorAll('section, article').length,
                images: root.querySelectorAll('img').length,
                forms: root.querySelectorAll('form').length,
              },
            };
          }, { sel: selector || null, want: wantLinks });

          if (data.missing) return asText(`选择器没匹配到元素：${selector}`, true);

          const body = data.text.length > cap
            ? `${data.text.slice(0, cap)}\n… （还有 ${data.text.length - cap} 个字符，要全文就加大 maxChars 或用 selector 缩范围）`
            : data.text;
          const inner = data.linkList.filter(l => l.internal);
          const outer = data.linkList.filter(l => !l.internal);
          const fmt = (l) => `  ${l.label || '(无文字)'} → ${l.href}`;

          return asText([
            `页面：${await where(page)}`,
            `结构：${data.counts.sections} 个 section/article · ${data.counts.images} 张图 · ${data.counts.forms} 个表单`,
            data.headings.length ? `\n标题层级：\n${data.headings.join('\n')}` : null,
            `\n正文：\n${body || '(读不到文字 —— 可能整页是图或靠 JS 渲染，试 browser_navigate 带 waitUntil:"networkidle"，或直接截图看)'}`,
            inner.length ? `\n站内链接（${inner.length}）：\n${inner.slice(0, 30).map(fmt).join('\n')}` : null,
            outer.length ? `\n站外链接（${outer.length}，只列前 8）：\n${outer.slice(0, 8).map(fmt).join('\n')}` : null,
            blockedNote(guard, since),
          ].filter(Boolean).join('\n'));
        });
      } catch (err) {
        return asText(`browser_read 失败：${err.message}`, true);
      }
    },
  );
}

export function makeBrowserClickTool({ projectId }) {
  return tool(
    'browser_click',
    `Click something on the current page and report where you ended up.

Use this instead of browser_navigate when the destination is not a plain href:
JS-driven navigation, tabs, accordions, "load more", cookie consent buttons
(dismiss those once and the profile remembers).

Prefer text= for buttons and links you can see, CSS selectors for structure.
If a click opens a new tab, that tab is closed on purpose — the network gate
cannot be installed on it in time, and an unguarded tab is a hole. Navigate to
the URL directly instead.`,
    {
      selector: z.string().min(1)
        .describe('What to click. Either a plain CSS selector, or text= followed by visible text (e.g. text=接受全部). First match wins.'),
      waitNav: z.boolean().optional()
        .describe('Wait for a navigation to finish after clicking (default true). Set false for in-page things like opening an accordion.'),
    },
    async ({ selector, waitNav }) => {
      try {
        return await withBrowser(projectId, async ({ page, guard }) => {
          const since = guard.blocked.length;
          const before = page.url();
          const loc = page.locator(selector).first();
          if (!(await loc.count())) {
            return asText([
              `点不到：${selector} 没匹配到元素。`,
              '先用 browser_read 看页面上到底有什么文字 —— 链接文案经常跟你以为的不一样。',
              'text= 是**子串**匹配（`text=更多` 能命中「了解更多」），所以写短一点更容易命中。',
            ].join('\n'), true);
          }
          let clickErr = null;
          try {
            if (waitNav === false) await loc.click({ timeout: 8000 });
            else {
              await Promise.all([
                page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {}),
                loc.click({ timeout: 8000 }),
              ]);
              await page.waitForTimeout(300);   // 让 JS 路由把地址栏改完
            }
          } catch (err) { clickErr = err.message.split('\n')[0]; }

          const after = page.isClosed() ? '(页面被关了)' : page.url();
          return asText([
            clickErr ? `点击报错：${clickErr}` : `点了 ${selector}`,
            after === before ? `地址没变（${before}）—— 可能是页内交互，或者那个元素不是链接。`
              : `${before}\n  → ${await where(page)}`,
            blockedNote(guard, since),
          ].filter(Boolean).join('\n'), !!clickErr && after === before);
        });
      } catch (err) {
        return asText(`browser_click 失败：${err.message}`, true);
      }
    },
  );
}

export function makeBrowserScreenshotTool({ projectId }) {
  return tool(
    'browser_screenshot',
    `Screenshot the current page in the browser session.

This is what makes browsing useful for design work: read tells you what a page
says, this tells you what it looks like — the layout rhythm, how the type is
set, where the whitespace is, how an opening screen is composed.

Default is the viewport (1440×900, cheap). fullPage for the whole scroll, or a
selector for one component you want to look at closely.`,
    {
      fullPage: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport. Several times more expensive.'),
      selector: z.string().optional().describe('Capture only the first element matching this CSS selector.'),
      scrollTo: z.union([z.number(), z.string()]).optional()
        .describe("Scroll the viewport here first: pixels, a percentage like '50%', or a CSS selector. Real scroll, so entry animations and sticky headers behave as a visitor sees them."),
    },
    async ({ fullPage, selector, scrollTo }) => {
      try {
        return await withBrowser(projectId, async ({ page }) => {
          if (scrollTo != null) {
            await page.evaluate(async (spec) => {
              const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
              let y = 0;
              if (typeof spec === 'number') y = spec;
              else if (/^-?[\d.]+%$/.test(spec)) y = maxY * (parseFloat(spec) / 100);
              else {
                const el = document.querySelector(spec);
                if (el) y = el.getBoundingClientRect().top + window.scrollY;
              }
              window.scrollTo({ top: Math.max(0, Math.min(y, maxY)), behavior: 'instant' });
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            }, scrollTo);
            await page.waitForTimeout(350);
          }
          let buf;
          if (selector) {
            const loc = page.locator(selector).first();
            if (!(await loc.count())) return asText(`选择器没匹配到元素：${selector}`, true);
            buf = await loc.screenshot({ type: 'png' });
          } else {
            buf = await page.screenshot({ type: 'png', fullPage: fullPage === true });
          }
          const shot = await normalizeShot(buf);
          return {
            content: [
              { type: 'text', text: [`${await where(page)}`,
                selector ? `只截了 ${selector}` : `${fullPage ? '整页' : '视口'} ${_limits.VIEWPORT.width}×${_limits.VIEWPORT.height}`,
                shot.note].filter(Boolean).join(' · ') },
              { type: 'image', data: shot.data, mimeType: shot.mimeType },
            ],
          };
        });
      } catch (err) {
        return asText(`browser_screenshot 失败：${err.message}`, true);
      }
    },
  );
}

export function makeBrowserRequestHelpTool({ projectId, ctx }) {
  return tool(
    'browser_request_help',
    `Ask the user to take over the browser for a moment, then wait for them.

Use it when you are stuck on something only a human can clear: a "prove you are
human" check, a login, an age gate, a consent dialog you cannot find the button
for. **Do not use it for slow pages or ordinary errors** — retry or move on.

What happens: the browser window opens on the user's canvas with your reason
shown on it, they click "我来接手", do the thing, then click "好了继续". You get
back control plus the page they left you on. If nobody answers within two
minutes you get told that, and it is then your call — usually: tell the user
plainly that this site cannot be reached from here and pick another reference.

Be honest with the user in your reason. Some walls score the server's IP and no
click will help; say that rather than making them try three times.`,
    {
      reason: z.string().min(4).max(300)
        .describe('What you need them to do, in one sentence, in the user\'s language. E.g. "这个站要过一个人机验证，帮我点一下就好".'),
    },
    async ({ reason }) => {
      try {
        const live = peek(projectId);
        if (!live) return asText('现在没有在跑的浏览器 —— 先 browser_navigate 打开一个页面再求助。', true);
        // 让前端把窗开起来 / 顶到前台 + 亮 banner（低频信号走现有 EventBus）
        ctx?.emit?.({ type: 'run.browser_help', reason, url: live.page.url(), ts: new Date().toISOString() });
        const r = await requestHelp(projectId, reason);
        if (!r.released) {
          return asText([
            `等了 ${Math.round(r.waitedMs / 1000)} 秒没人接手。`,
            '别在这站上继续耗 —— 跟用户说清楚"这个站从这台机器过不去"，换一个参考站。',
            '（有些墙看的是服务器 IP 的信誉，人点多少次都一样。）',
          ].join('\n'));
        }
        const nowAt = await withBrowser(projectId, async ({ page }) => where(page));
        return asText([
          `用户接手完了（等了 ${Math.round(r.waitedMs / 1000)} 秒）。`,
          `现在的页面：${nowAt}`,
          '⚠️ 页面被人动过，你之前对它的判断可能都不成立了 —— 先 browser_read 或者截一张图重新对齐，再继续。',
        ].join('\n'));
      } catch (err) {
        return asText(`browser_request_help 失败：${err.message}`, true);
      }
    },
  );
}

export function makeBrowserCaptureTool({ projectId, workspaceRoot, sessionId, ctx }) {
  return tool(
    'browser_capture',
    `Take something reusable off the page you are looking at and save it into the
workspace, so it survives this conversation.

The point is NOT just a screenshot. What is actually reusable from a reference
site is usually the parts you can turn straight into code:

- palette   the colours WITH their roles (page background, body text, link,
            button) read off computed styles — the author's choices, not a
            quantised bitmap full of nameless near-duplicates
- fonts     family + the sizes/weights/line-heights actually in use (a family
            name alone is not enough to copy a type system)
- css       every rule that matched one element you name, in cascade order —
            you can read it and re-derive the technique. Needs "selector".
- skeleton  three counts: how many sections, how many DISTINCT section shapes,
            how many interaction points. ⚠️ heuristic — use it as a comparison
            against the site you are building, not as fact. This is the same
            three numbers site-craft asks you to count when the user says a page
            is boring; having them for a reference site turns "it feels thin"
            into "theirs has 6 shapes, yours has 1".
- screenshot the picture, for the things numbers cannot carry

Everything lands in assets/references/web/ with a provenance sidecar (source
URL, when, what you were looking for). It is there in the NEXT conversation too
— that is the whole reason it goes to disk instead of just into your context.

Write "lookingFor" honestly: in three days a folder of screenshots with no note
about why they were taken is landfill.`,
    {
      kinds: z.array(z.enum(['screenshot', 'palette', 'fonts', 'css', 'skeleton'])).min(1)
        .describe('What to take. Cheap ones (palette/fonts/skeleton) can all go in one call.'),
      lookingFor: z.string().min(4).max(200)
        .describe('Why you are taking this, in one line — e.g. "刊物式开场的版面节奏与配色".'),
      name: z.string().max(48).optional()
        .describe('Filename stem. Defaults to the host plus a timestamp.'),
      selector: z.string().optional()
        .describe('Required for "css"; also narrows "screenshot" to one component.'),
    },
    async ({ kinds, lookingFor, name, selector }) => {
      try {
        if (kinds.includes('css') && !selector) {
          return asText('css 那一种要指一块：加上 selector（用 browser_read 先看页面上有什么）。', true);
        }
        return await withBrowser(projectId, async ({ page }) => {
          const r = await capture({
            page, workspaceRoot, kinds, name, lookingFor, selector,
            ids: { sessionId, runId: ctx?.runId ?? null },
            normalize: normalizeShot,
          });
          for (const f of r.files) {
            try { ctx?.emit?.({ type: 'run.file_changed', path: f.rel, change: 'add' }); } catch { /* */ }
          }
          const lines = [`从 ${r.data.title || r.data.url} 采下来了：`];
          for (const f of r.files) lines.push(`  ${f.rel}（${(f.bytes / 1024).toFixed(0)} KB，${f.kind}）`);
          if (r.data.palette?.length) {
            lines.push('', '调色板：' + r.data.palette.slice(0, 8)
              .map(c => `${c.role}=${c.value}`).join('  '));
          }
          if (r.data.fonts?.length) {
            lines.push('字体：' + r.data.fonts.map(f => `${f.role}=${f.family.split(',')[0]} ${f.size}/${f.weight}`).join('  ·  '));
          }
          if (r.data.skeleton) {
            const sk = r.data.skeleton;
            if (!sk.sectionCount) {
              // 数不出来就说数不出来。报一个 0 会让 agent 以为"这站真的没有结构"
              lines.push('', '结构：这一页量不出横带（可能整页是一张大图、或者内容靠 JS '
                + '后填 —— 试 browser_navigate 带 waitUntil:"networkidle" 再采一次）。');
            } else {
              lines.push('', `结构（⚠️ 启发式，当对照不当真相）：${sk.sectionCount} 节 · `
                + `**${sk.shapeKinds} 种节的形状** · ${sk.interactivePoints} 个交互点`);
              lines.push('  拿它跟你正在做的那个站比 —— 形状种类差得多，就是"薄"的量化形态。');
            }
          }
          if (r.data.css) lines.push('', `CSS：${r.data.css.length} 条命中规则已写进 json`);
          if (r.failed?.length) {
            lines.push('', `⚠️ 有 ${r.failed.length} 种没采到（其余的已经落盘了）：`,
              ...r.failed.map(f => `  ${f}`));
          }
          lines.push('', '这些文件下个会话还在（assets/ 不随会话分桶）。');
          return asText(lines.join('\n'));
        });
      } catch (err) {
        return asText(`browser_capture 失败：${err.message}`, true);
      }
    },
  );
}
