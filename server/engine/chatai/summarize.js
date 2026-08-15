/**
 * summarize.js —— 滚动前情提要。
 *
 * 长演出的记忆基础设施：活历史（摘要边界之后的轮次）攒到 摘要.触发轮数 就
 * 折叠一次——把「旧提要 + 除最近 保留轮数 外的活轮次」交给 chatai 压成一份
 * 新提要，边界前移。触发轮数 > 保留轮数 的差值就是滞回区间，保证不会每轮
 * 都在摘要，也保证缓存前缀只在折叠瞬间断一次、之后又稳定到下次折叠。
 *
 * 摘要本身是一次独立的 chatai 调用（chatai 没有工具，摘要不可能是 agent 的
 * 副作用），花费单独记在 摘要.json 里，端点计量时要把它加进这轮的账。
 */

import { runChatai } from './index.js';
import { readLog, readSummary, writeSummary } from './chat-log.js';

const DEFAULT_PROMPT = (长度) => `把下面这段对话压缩成一份前情提要，供后续继续演出时当作记忆。只输出提要本身，不要任何前后缀。
要求：保留人物与称呼、关系变化、承诺与约定、得到或失去的东西、时间地点的推进、未解决的伏笔；去掉寒暄和过程性描写；用第三人称陈述句；${长度}字以内。
如果下面给了旧提要，把它和新对话并成一份完整提要，旧提要里仍然有效的信息不能丢。`;

/**
 * 该不该折叠、折叠到哪。纯函数，方便测试。
 * @returns {null | { 至: number, fold: records[] }}  至 = 折叠后的新边界 seq
 */
export function needsSummary(records, summary, config) {
  if (!config.摘要.启用) return null;
  const boundary = summary?.至 ?? 0;
  const live = records.filter(r => r.seq > boundary);
  const userIdxs = live.map((r, i) => (r.role === 'user' ? i : -1)).filter(i => i >= 0);
  if (userIdxs.length < config.摘要.触发轮数) return null;
  // 保留最近 保留轮数 轮，其余折叠；新边界 = 保留区第一条 user 记录的前一条
  const keepFrom = userIdxs[userIdxs.length - config.摘要.保留轮数];
  const fold = live.slice(0, keepFrom);
  if (!fold.length) return null;
  return { 至: fold[fold.length - 1].seq, fold };
}

function renderTranscript(records) {
  return records
    .map(r => `${r.role === 'user' ? '用户' : '演出'}：${r.text}`)
    .join('\n\n');
}

/**
 * 检查并执行一次折叠。没到触发线 → null；执行了 → 摘要对象（含花费）。
 * 失败直接抛给调用方——摘要失败不该静默，下一轮编译仍按旧边界走，不丢戏。
 */
export async function maybeSummarize({ dir, config, signal }) {
  const records = await readLog(dir, config);
  const prev = await readSummary(dir);
  const need = needsSummary(records, prev, config);
  if (!need) return null;

  const parts = [];
  if (prev) parts.push(`【旧提要】\n${prev.内容.trim()}`);
  parts.push(`【新对话】\n${renderTranscript(need.fold)}`);

  const out = await runChatai({
    system: config.摘要.提示 || DEFAULT_PROMPT(config.摘要.长度),
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    model: config.摘要.模型 || config.模型 || undefined,
    maxTokens: Math.max(500, config.摘要.长度 * 2),
    signal,
  });
  const text = out.text.trim();
  if (!text) throw Object.assign(new Error('摘要调用返回了空文本，边界不动'), { code: 'SUMMARY_EMPTY' });

  const summary = {
    至: need.至,
    内容: text,
    时: new Date().toISOString(),
    模型: out.model,
    用量: out.usage,
    花费: out.costUsd,
  };
  await writeSummary(dir, summary);
  return summary;
}
