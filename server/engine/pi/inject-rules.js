/**
 * inject-rules.js — 懒注入族 + 失败建议 + rate-limit 判别的纯逻辑（vitest 直测）。
 *
 * 语义源（CC SDK 时代 hooks，M2 迁 pi，逻辑照搬；见 docs/engine-pi-rp-migration.md §6）：
 *   - agent/hooks/pre-injectors.js  首调懒注入族（触发键 / write kind 判据 / ReadPageReminder 内联文本）
 *   - agent/hooks/failure.js        工具失败恢复建议的按工具/错因分流
 * extensions/inject.ts 是薄壳：读 md、去重、sidecar emit；所有判定在这里。
 *
 * 工具名一律裸名：pi 的 MCP 工具（adapter 注册）在 tool_result 事件里无 mcp__ 前缀，
 * 内建工具是小写 read/write/edit/grep/find/ls。
 */
import path from 'node:path';

// ── 懒注入注册表 ─────────────────────────────────────────────────────────────
//
// 触发工具名 → { key, file, inlinePrefix? }
//   key          去重键（每会话每 key 只注一次；paint_still 与 lookup_tags 共享同一 key——
//                纪律是"先查后画"，手册得在第一次查标签时就到，两个工具合计只注一次，
//                对齐 hooks.js 把两者挂同一 matcher 共享 closure 的原语义）
//   file         prompts/tools/ 下的 md 文件名
//   inlinePrefix 拼在 md 前的内联文本（仅 generate_image 的 ReadPageReminder）

/**
 * generate_image 目标页提醒（pre-injectors.js makePreToolUseGenerateImageReadPageReminder
 * 的 additionalContext 逐字照搬）。设计原则 metadata-not-content：不预解析页面注入 HTML，
 * 而是提醒 agent 自己 Read——避免"被注入摘要后反而不主动读"的反模式。
 */
export const READ_PAGE_REMINDER =
  '<system-reminder>\n[generate_image 目标页提醒]\n\n'
  + '即将生成图片。如果还没看过目标页（deck 里对应的 <section data-page="N"> / 站点的那一页），建议先 Read 一下：\n'
  + '  - 页面尺寸（多少行 / 多大留给图）\n'
  + '  - 主色（design-tokens 里的 --bg / --accent / --hero）\n'
  + '  - 已有视觉风格（hybrid 范式有无 React 组件 / 已有图片调性）\n\n'
  + '多数情况下第一张图会被当 referenceImages 种子用于全 deck，看一眼能避免后续违和（暖色页塞冷调插图这类）。本提醒每 session 只触发一次。\n'
  + '</system-reminder>';

export const LAZY_INJECTIONS = new Map([
  ['get_pending_changes', { key: 'direct-edit-protocol', file: 'direct-edit-protocol.md' }],
  ['generate_image', { key: 'generate-image-cookbook', file: 'generate-image-cookbook.md', inlinePrefix: READ_PAGE_REMINDER }],
  ['paint_still', { key: 'paint-still-cookbook', file: 'paint-still-cookbook.md' }],
  ['lookup_tags', { key: 'paint-still-cookbook', file: 'paint-still-cookbook.md' }],
  ['roll_film', { key: 'roll-film-cookbook', file: 'roll-film-cookbook.md' }],
  ['expose_tweaks', { key: 'tweaks-syntax', file: 'tweaks-syntax.md' }],
]);

/** write 按 kind 分发的技术参考（referenceDoc 定义源：lib/kinds/deck.js:21、lib/kinds/site.js:136） */
export const WRITE_KIND_FILES = Object.freeze({
  deck: { key: 'hybrid-reference', file: 'hybrid-reference.md' },
  site: { key: 'site-reference', file: 'site-reference.md' },
});

/**
 * write 的 kind 判据 —— artifact-target.js kindOfPath() 回退文件名规则的同步版。
 *
 * 取舍（为什么不 import lib/kinds）：完整 kindOfPath 先查 taskManifest（async + fs 读
 * .nd-project.json / 目录扫描），而 ① injectionFor 是同步签名（薄壳按 tool_result 事件
 * 字段即时判定）；② 写文件的当下文件多半还没落盘，manifest 里查不到，kindOfPath 自己
 * 也落到文件名回退——回退规则就是主路径；③ 规则模块零依赖，vitest / jiti 都直接加载。
 * lib/kinds 各模块 import 期无副作用（已核查），此处理由是①②③，不是副作用。
 *
 * 回退规则照搬 artifact-target.js:134-141：
 *   basename === 'index.html' → site（含 dist/index.html、about/index.html 这类 pretty-URL 子页）
 *  其余 .html / .htm（canvas.html 与任何认不出的散装 html）→ deck（"认不出的散装 .html 一律按 deck"）
 *  非 html → null（不注入。word 形态没有自己的 referenceDoc，老 hook 的 entryFile 扩展名
 *   闸门会把 deck 参考错注给 .docx 写入，属历史回退怪癖，M2 不保留）
 */
export function kindOfWritePath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const fp = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(fp).toLowerCase();
  const ext = (base.match(/\.[a-z0-9]+$/) || [''])[0];
  if (ext !== '.html' && ext !== '.htm') return null;
  if (base === 'index.html') return 'site';
  return 'deck';
}

/**
 * 本次 tool_result 该懒注哪份参考。
 * @param {string} toolName 裸工具名
 * @param {object} [input]  工具入参（write 用 path / file_path 判 kind）
 * @returns {{ key: string, file: string, inlinePrefix?: string } | null}
 */
export function injectionFor(toolName, input) {
  if (typeof toolName !== 'string' || !toolName) return null;
  if (toolName === 'write') {
    // pi write schema 字段是 path；file_path 是渲染层的兼容别名，一并认（对齐 pi tools/write.ts 的读取次序）
    const fp = typeof input?.path === 'string' ? input.path
      : typeof input?.file_path === 'string' ? input.file_path : '';
    const kind = kindOfWritePath(fp);
    return kind ? { ...WRITE_KIND_FILES[kind] } : null;
  }
  const hit = LAZY_INJECTIONS.get(toolName);
  return hit ? { ...hit } : null;
}

// ── 失败恢复建议 ─────────────────────────────────────────────────────────────

/**
 * 工具失败时给 agent 的恢复建议（hooks/failure.js 分流照搬，工具名改裸名）。
 *
 * 与源的差异（均按 M2 任务书）：
 *   - 删 seccomp/unshare 分支：bwrap 沙盒已随 M2 删除，apply-seccomp / unshare(CLONE_NEWUSER)
 *     那类偶发不复存在（原分支见 failure.js:58-69）。
 *   - 不 import issues-store：recordIssue 自动层问题记录留 Main 接线 sidecar，
 *     本函数只产建议文本。
 *   - ctx.emit(run.tool_failure) 不保留：pi 侧 event-bridge 已把 tool_execution_end isError
 *     映射成 run.delta.tool_result {ok:false} + toolFailures 计数，可见性已有来源。
 *
 * @param {{ toolName?: string, isError?: boolean, errorText?: string, input?: unknown, isInterrupt?: boolean }} args
 * @returns {string | null} 建议全文（含 [工具失败恢复建议] 头）；不该注入时 null
 */
export function failureAdvice({ toolName, isError, errorText, isInterrupt } = {}) {
  if (!isError) return null;
  // is_interrupt: 用户中断 → 不注入建议（agent 应该停下，不是恢复）。
  // pi 的 tool_result 事件没有 is_interrupt 字段（中断不走 tool_result），参数保留是为对齐源语义与可测性。
  if (isInterrupt) return null;

  const tool = (typeof toolName === 'string' && toolName) ? toolName : 'unknown';
  const error = String(errorText || '').slice(0, 500);

  let advice;
  if (tool === 'screenshot_canvas') {
    advice =
      '截图失败。常见原因：\n'
      + '  1. 产物文件还没创建 → 先 Write 创建首版\n'
      + '  2. playwright spawn 慢 / 失败 → 换 Read 产物文件让用户看代码\n'
      + '  3. fullPage 截图太大 → 换 fullPage:false 截视口';
  } else if (tool === 'bash') {
    // bash 已在 defaultTools 白名单（2026-08-27 放开）。pi 的 bash 无沙盒（M2 删了
    // bwrap isolation），越界靠 guards 的项目边界闸 + 本建议引导，不靠 sandbox 拦截。
    advice =
      'Bash 命令失败。常见：\n'
      + '  1. 路径越界 / 访问了工作区外文件 → 路径相对 workspace，别用绝对路径出界\n'
      + '  2. cwd 不对 → 命令默认在工作区根，需要别处就显式 cd 或给绝对路径\n'
      + '  3. 命令本身错（参数 / 文件不存在）→ 检查 stderr';
  } else if (/_batch$/.test(tool)) {
    // batch 一步失败整批标错，但失败步之前的动作（click / type 这类非幂等的）
    // **已经执行过了** —— 兜底那句"先重试 1 次"对 batch 是错的，会重放前面的步骤。
    advice =
      `${tool} 失败：${error.slice(0, 200)}\n`
      + '返回文本第一行标了失败在第几步。**不要整批重跑** —— 失败步之前的动作已经执行过了；\n'
      + '看当前状态（返回末尾的截图），只从失败那一步起继续（单独调用或开一个新 batch）。';
  } else if (tool === 'write' || tool === 'edit') {
    advice =
      `${tool} 失败。检查：\n`
      + '  1. 路径相对 workspace 还是绝对路径\n'
      + '  2. Edit 的 old_string 是否完整匹配（含空格/缩进）\n'
      + '  3. 文件是否存在（不存在用 Write 创建）';
  } else if (tool === 'read') {
    advice = `read 失败：${error}\n  1. 确认路径相对 workspace\n  2. 用 Glob 找文件确认存在`;
  } else if (tool === 'generate_image') {
    // 按错因分流恢复建议（多数 generate_image 失败可恢复，**默认应重试不是放弃**）
    const errLower = error.toLowerCase();
    let cause;
    if (/http 429|rate.?limit|too many request/.test(errLower)) {
      cause = '网关限流（429）→ 等 3-5 秒**直接重试**，不必改 prompt。短时间内连续生图触发的，过会儿就 OK';
    } else if (/http 5\d\d|timeout|gateway|econnreset|socket/.test(errLower)) {
      cause = '网关 / 上游临时故障（5xx / 网络抖动）→ **直接重试 1-2 次**，多数情况下第二次就成；连续 3 次同错才考虑改思路';
    } else if (/no parts|no image|safety|blocked|policy/.test(errLower)) {
      cause = '模型拒生（安全过滤 / 内容策略）→ 调 prompt：换更具体的视觉词（流派 / 镜头 / 灯光），去掉可能触发安全过滤的人物 / 暴力 / 品牌侵权描述，重试';
    } else if (/http 400|invalid|bad request/.test(errLower)) {
      cause = 'Prompt 或参数问题（400）→ 检查：去掉否定描述（"no cars" → "empty street"）/ 加风格锚（"Saul Bass minimalist" / "Fujifilm color science"）/ aspectRatio + imageSize 组合是否合法，重试';
    } else if (/path|reference|enoent|not.?found/.test(errLower)) {
      cause = 'referenceImages 路径错 → 用 Glob 确认文件存在；只接 workspace 相对路径（assets/...），不接 http url；选 1-2 张最切题的不要全 14 张';
    } else if (/quota|budget|limit/.test(errLower)) {
      cause = '配额 / 预算限制 → 看 PM2 日志确认；非紧急情况下告诉用户，等用户决定';
    } else {
      cause = '错因未知 → **先重试 1 次**（多数是网络抖动）；同错重现再调 prompt 关键参数（5 元素公式 / 风格锚 / 文字带引号）。不要第一次失败就放弃';
    }
    advice =
      `generate_image 失败：${error}\n\n`
      + `→ ${cause}\n\n`
      + `**重要**：generate_image 多数失败是可恢复的（网关抖动 / prompt 微调）。第一次失败就放弃 = 用户没图用，跟"agent 不会生图"体感一样差。**默认应重试 1-2 次**，连续 3 次同错才考虑换思路 / 询问用户。`;
  } else {
    advice =
      `${tool} 失败：${error}\n`
      + '常见恢复：\n'
      + '  1. 先重试 1 次（网络抖动 / 临时上游故障多数情况下二次成功）\n'
      + '  2. 同错重现 → 分析错因调整参数 / 换工具\n'
      + '  3. 仅当连续失败且阻塞主线 → 在 chat 里跟用户说当前卡点 + 你打算怎么绕过';
  }

  return `[工具失败恢复建议]\n${advice}`;
}

// ── rate-limit 判别 ──────────────────────────────────────────────────────────

/** headers 大小写不敏感取值（pi 的 after_provider_response headers 已归一化，双保险） */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * provider 响应是不是 rate-limit 信号。
 *
 * 与 event-bridge.js isRateLimitMessage 的分工（详见切片报告）：那里判 auto_retry_end
 * 耗尽后的**错误文本**；这里判 after_provider_response 的**一手 HTTP 面**（status/headers），
 * 信号更早（重试耗尽前就能上报）。文本正则比 event-bridge 多认 "too many requests"
 * （附录 C 遗留 TODO：上游可能只回 "rate limit" 无 429 / 无 rate_limit 字样）。
 * 529 overloaded 不算限流（5xx 瞬时过载，pi 自动重试覆盖，与 event-bridge 同口径）。
 *
 * @param {{ status?: number, headers?: Record<string, string>, errorMessage?: string }} args
 * @returns {{ isRateLimit: true, detail: string } | null} 非限流信号返 null
 */
export function isRateLimitSignal({ status, headers, errorMessage } = {}) {
  if (status === 429) {
    return { isRateLimit: true, detail: 'HTTP 429（provider 限流）' };
  }
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter !== null && String(retryAfter).trim() !== '') {
    return { isRateLimit: true, detail: `retry-after: ${String(retryAfter).slice(0, 80)}` };
  }
  if (typeof errorMessage === 'string' && /rate.?limit|too many requests|429/i.test(errorMessage)) {
    return { isRateLimit: true, detail: `errorMessage: ${errorMessage.slice(0, 200)}` };
  }
  return null;
}
