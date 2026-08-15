/**
 * pre-performance-log-guard —— 演出记录的隐私闸（2026-08-15，用户拍板）。
 *
 * RP 台词只走 chatai 通路（中转站），**不进设计会话**：agent 线过外审、
 * 上下文进 Anthropic，用户的演出原文两边都不该去。此闸拦 agent 对演出
 * 文件夹里对话记录/摘要的 Read / Grep —— 判定证据是同目录有 编排.yaml。
 *
 * 写不拦：建场要种开场白（Write 对话.jsonl 是 skill 教的正路）。
 * 诚实边界：agent 有 Bash，这道闸防"顺手误食"不防蓄意 —— agent 不是
 * 对抗方，防误食就是全部需求；deny 文案同时是一次隐私教义注入。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

const FIXED = ['对话.jsonl', '摘要.json'];

/** @returns {Promise<null | string>} null=放行；string=拒绝理由 */
export async function checkPerformanceLogRead(toolInput, workspaceRoot) {
  const fp = toolInput?.file_path || toolInput?.path || '';
  if (typeof fp !== 'string' || !fp) return null;
  const abs = path.isAbsolute(fp) ? fp : path.resolve(workspaceRoot || '', fp);
  const base = path.basename(abs);
  const dir = path.dirname(abs);
  let yaml;
  try {
    yaml = await fs.readFile(path.join(dir, '编排.yaml'), 'utf8');
  } catch { return null; }                     // 同目录没有 编排.yaml → 不是演出文件夹
  const names = new Set(FIXED);
  const m = yaml.match(/文件:\s*([^\s#]+)/);   // 历史.文件 可自定义记录名
  if (m) names.add(path.basename(m[1]));
  if (!names.has(base)) return null;
  return `「${base}」是这场演出的对话记录——用户的演出原文是隐私，只走 chatai 通路，不进设计会话。`
    + '要推进剧情改 状态/ 里的文件（尾部条目每轮现读）；用户想给你看某段戏会自己粘贴过来。';
}

export function makePreToolUsePerformanceLogGuard({ workspaceRoot }) {
  return async (input, _toolUseId, _options) => {
    try {
      const reason = await checkPerformanceLogRead(input?.tool_input, workspaceRoot);
      if (!reason) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    } catch { return {}; }                     // 闸自己出错不拦工具（fail-open）
  };
}
