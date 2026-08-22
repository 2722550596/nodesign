/**
 * engine/mcp/capability-gate.js — 工具 × 本机能力位（runtime/capabilities.js）的唯一对照表 + 闸。
 *
 * 两种模式：
 *   - block：能力缺席时工具描述前缀「⛔ CURRENTLY UNAVAILABLE + 装法」（照 roll_film 的先例，agent 看到就不会调），
 *            真调了也在这里拦住，返回同一句话让它转告用户——不让裸的 ENOENT / 500 漏到 agent 面前
 *   - note ：工具仍可用，只在描述末尾加一句降级说明（build_docx 没有 LibreOffice 时仍能出文件，只是没页图）
 * 没探过（capabilityState 为 null：单测 / 脚本直接 import）→ 原样放行，这层不猜。
 */

import { capabilityState } from '../../runtime/capabilities.js';

const CHROMIUM_TOOLS = [
  'screenshot_canvas', 'screenshot_url', 'list_pages', 'query_elements', 'get_computed_styles', 'explain_style',
  'profile_scroll', 'trace_motion',
  'browser_navigate', 'browser_read', 'browser_click', 'browser_screenshot', 'browser_capture', 'browser_computer',
  'browser_find', 'browser_batch', 'browser_request_help',
  'artifact_open', 'artifact_computer', 'artifact_find', 'artifact_motion', 'artifact_batch',
];

/** 工具名 → { cap, mode }。没列的工具不归这层管 */
export const TOOL_CAPABILITIES = Object.freeze({
  ...Object.fromEntries(CHROMIUM_TOOLS.map((t) => [t, { cap: 'chromium', mode: 'block' }])),
  build_docx: { cap: 'libreoffice', mode: 'note' },
  remove_background: { cap: 'rembg', mode: 'block' },
  web_search: { cap: 'webSearch', mode: 'block' },
  generate_image: { cap: 'imageGen', mode: 'block' },
  publish_site: { cap: 'publish', mode: 'block' },
});

export function unavailableMessage(c) {
  return `本机缺 ${c.label}（${c.detail}）。装法：${c.fix}`;
}

export function withCapabilityGate(toolDef) {
  const spec = TOOL_CAPABILITIES[toolDef.name];
  if (!spec) return toolDef;
  const c = capabilityState(spec.cap);
  if (!c || c.available) return toolDef;
  const msg = unavailableMessage(c);
  if (spec.mode === 'note') {
    return { ...toolDef, description: `${toolDef.description}\n\n⚠️ ${msg} 本工具仍可用，但依赖它的步骤（页图/体检）会缺席。` };
  }
  return {
    ...toolDef,
    description: `⛔ CURRENTLY UNAVAILABLE — ${msg} Do not call this tool; tell the user what to install (原话转告，不要重试).\n\n${toolDef.description}`,
    handler: async () => ({
      content: [{ type: 'text', text: `${toolDef.name} 不可用：${msg}。把这句话原话转告用户，装好后重启 Nodesign 再试；不要重试本工具。` }],
      isError: true,
    }),
  };
}
