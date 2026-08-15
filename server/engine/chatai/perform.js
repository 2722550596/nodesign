/**
 * perform.js —— 一轮完整演出：编译 → 调用 → 落盘 → （必要时）折叠摘要。
 *
 * 这是将来 HTTP 端点的核心；限流、owner 隔离、计量入库都归端点层，
 * 这里只管把一轮跑对。摘要折叠放在回复落盘之后串行执行：它只在每
 * 攒够一批轮次时发生一次，多出的几秒延迟落在「本轮已经拿到回复之后」，
 * 用户无感；换成后台跑要多一套失败通知机制，v1 不值。
 */

import { runChatai } from './index.js';
import { loadOrchestration, compileContext } from './orchestrate.js';
import { appendTurn } from './chat-log.js';
import { maybeSummarize } from './summarize.js';

/**
 * @param {object} opts  dir / userInput / signal / onDelta
 * @returns {{ text, usage, costUsd, model, meta, 摘要: null|object }}
 */
export async function performTurn({ dir, userInput, signal, onDelta }) {
  const config = await loadOrchestration(dir);
  const compiled = await compileContext({ dir, userInput, config });
  const out = await runChatai({
    system: compiled.system,
    messages: compiled.messages,
    model: compiled.model || undefined,
    思考: compiled.思考,
    maxTokens: compiled.maxTokens,
    signal, onDelta,
  });
  await appendTurn(dir, config, String(userInput).trim(), out.text);

  let 摘要 = null;
  try {
    摘要 = await maybeSummarize({ dir, config, signal });
  } catch (err) {
    // 摘要失败不吞掉本轮回复：边界不动，下一轮还会再试。往上抛消息但带着结果。
    摘要 = { 失败: err.message };
  }
  return { ...out, meta: compiled.meta, 摘要 };
}
