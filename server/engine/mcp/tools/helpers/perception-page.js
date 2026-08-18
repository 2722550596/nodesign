/**
 * server/engine/mcp/tools/helpers/perception-page.js
 * 感知工具的**唯一**页面加载口（2026-08-18）
 *
 * ## 为什么要有这一层
 *
 * 在这之前四个感知工具各自 `page.goto('file://' + abs)`，而用户预览走的是
 * `/api/projects/:pid/artifact-file/*`（http）。**两条通道不同源**，于是：
 *
 *   - `location.protocol` 守卫（导出 zip 用 file:// 打开时关掉客户端路由那种）
 *     在自检时触发，agent 看到的是退化行为
 *   - `fetch`/XHR 被 CORS 拒 —— 任何加载 JSON 的站点在自检里是死的
 *   - **localStorage 的 origin 是字符串 "null"**，全部任务共用一个桶；而用户
 *     预览下它们各自独立。mock-app 产线「写了刷新还在」那条硬定义正好踩在
 *     这上面 —— agent 验的东西和用户看的东西不是一回事
 *   - Service Worker / 动态 import 同理
 *
 * 一个 agent 为此花了 4 次截图 + 一次把 `location.protocol` 写进 DOM 再截图，
 * 才反推出来自己被 file:// 打开了（问题库 iss_msxk2oci_0v0v）。
 *
 * ## 凭什么能走 http
 *
 * MCP 工具的 handler 跟 express server 跑在**同一个进程**里，而 token 是无状态
 * HMAC：`mintToken(ownerId)` 当场铸一个、塞进 chromium 的 cookie jar 即可。
 * 拿到的权限跟项目所有者在浏览器里一模一样——不是新开一道后门，是走用户那道门。
 * （web/scripts/shot-live.mjs 早就是这么干的，这里只是把它收进产品代码。）
 *
 * ⚠️ 铸出来的 token 只进本机 chromium 的 cookie jar，不写日志、不进返回文本。
 * ⚠️ 前提是**调用方跟 HTTP server 同进程**（共用 NODESIGN_AUTH_SECRET）。独立脚本
 *    里直接调这个 helper 会铸出对不上号的 token，服务端回 401 —— 那是环境问题不是
 *    产品 bug，跑验证脚本记得 `node --env-file=.env`。
 */

import path from 'node:path';
import { getProject } from '../../../../projects/store.js';
import { COOKIE_NAME, mintToken, authEnabled } from '../../../../auth/session.js';

// ── 渲染层保真（2026-08-07 立，2026-08-18 从 screenshot.js 挪来收成一份）──
// Chromium 的强制暗色（Auto Dark）会在 paint 层反转颜色，而页面自己的 JS
// 一点都测不到 —— 2026-08-05 那次「位图深色 / computed style 浅色」事故就是它。
// ⚠️ 这组参数以前只有 screenshot / screenshot-url 两条路带，query_elements /
// get_computed_styles / list_pages 是裸奔的 —— 同一个 DOM 两条通道两种渲染，
// 正是「判据本身要先验一遍」那类坑。现在收成一份，谁开 chromium 都带上。
export const FIDELITY_LAUNCH_ARGS = [
  '--disable-features=WebContentsForceDark',  // 自动暗色：paint 层反转，页面自己测不到
  '--force-color-profile=srgb',               // 色彩配置固定 srgb，排除 ICC 差异
];

/** 服务端自己的监听口。跟 server/index.js 同一个默认值，改端口两处一起改。 */
const PORT = Number(process.env.PORT || 4001);

/** 127.0.0.1 而不是 localhost：避免 ::1/127.0.0.1 双栈解析下 cookie 域对不上 */
export const PERCEPTION_ORIGIN = `http://127.0.0.1:${PORT}`;

/**
 * 开一个「保真」chromium。凡是要把页面变成给人或给模型看的像素的地方都走这里 ——
 * 参数散在九个调用点上时，有三个是漏的（2026-08-18 逐处对账才发现）。
 */
export async function launchPerceptionBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, args: FIDELITY_LAUNCH_ARGS });
}

/**
 * 工作区相对路径 → 用户预览用的同一个 URL。
 * 逐段 encodeURIComponent —— 任务名和文件名大量是中文，整体编码会把 `/` 也吃掉。
 */
export function artifactFileUrl(projectId, relPath) {
  const sub = String(relPath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${PERCEPTION_ORIGIN}/api/projects/${projectId}/artifact-file/${sub}`;
}

/**
 * 打开一个产物页面，返回 { page, context, url, note }。
 *
 * - `note` 非空表示**没能走成 http**（退回了 file://），调用方应把它写进 caption：
 *   悄悄退回去就是把这个 bug 重新种一遍。
 * - HTTP 状态 >= 400 直接抛错，不截一张 JSON 错误页给 agent 当产物看。
 *
 * @param {import('playwright').Browser} browser
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.workspaceRoot  项目工作区根（= artifact-file 的可服务根）
 * @param {string} opts.absPath        要打开的文件绝对路径
 * @param {object} [opts.viewport]
 * @param {number} [opts.deviceScaleFactor]
 * @param {number} [opts.timeout]
 * @param {string} [opts.waitUntil]
 */
export async function openArtifactPage(browser, {
  projectId, workspaceRoot, absPath,
  viewport, deviceScaleFactor = 1, timeout = 15000, waitUntil = 'networkidle',
}) {
  const contextOpts = { colorScheme: 'light', deviceScaleFactor };
  if (viewport) contextOpts.viewport = viewport;
  const context = await browser.newContext(contextOpts);

  let url = null;
  let note = null;

  const rel = projectId && workspaceRoot
    ? path.relative(workspaceRoot, absPath)
    : null;
  const insideWorkspace = rel != null && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);

  if (insideWorkspace) {
    url = artifactFileUrl(projectId, rel.split(path.sep).join('/'));
    if (authEnabled()) {
      // 项目所有者的身份 —— guardProject 只认 owner 或 admin
      const ownerId = getProject(projectId)?.ownerId;
      if (ownerId) {
        await context.addCookies([{
          name: COOKIE_NAME, value: mintToken(ownerId), url: PERCEPTION_ORIGIN,
        }]);
      } else {
        note = 'project owner unknown — loaded via file:// (fetch/XHR/localStorage behave differently from the user preview)';
        url = null;
      }
    }
  } else {
    // 产物落在工作区外（不该发生，但寻址层出岔子时别整个瞎掉）
    note = 'file is outside the project workspace — loaded via file:// (fetch/XHR/localStorage behave differently from the user preview)';
  }

  const page = await context.newPage();
  if (!url) {
    return { page, context, url: `file://${absPath}`, note, viaHttp: false, goto: () => page.goto(`file://${absPath}`, { waitUntil, timeout }) };
  }

  return {
    page, context, url, note, viaHttp: true,
    goto: async () => {
      const resp = await page.goto(url, { waitUntil, timeout });
      // 401/403/404 会渲成一张 JSON 错误页 —— 截它等于给 agent 一张假产物
      const status = resp?.status();
      if (status && status >= 400) {
        throw new Error(`artifact-file returned HTTP ${status} for ${decodeURIComponent(url.replace(PERCEPTION_ORIGIN, ''))}`);
      }
      return resp;
    },
  };
}
