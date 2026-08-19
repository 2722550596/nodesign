/**
 * quick-summary —— 画布铅笔精灵那行手写短句的整形（纯本地，零成本零延迟）
 *
 * ## 这里以前还挂着一发 haiku（2026-08-14 加，2026-08-19 拆）
 *
 * 原设计是两条腿：assistant 文本一到先用下面的 clampFirstClause 起个"底稿"
 * 写上画布，同时起一发一次性 SDK 会话让 haiku 精修一行，到货覆盖底稿
 * （前端管这叫"显影"）。拆掉不是因为它写得不好，是因为它**写死走订阅**：
 *
 *   - 模型名是常量 `claude-haiku-4-5`，**不跟随会话的主 agent 模型**。会话
 *     跑在本地 Qwen / 中转 API 上时，这一发照旧打进 Claude 订阅额度 ——
 *     用户明明选了别的模型，装饰性短句却还在替他烧订阅；而且是每条
 *     assistant 消息一发、每轮收场再一发。
 *   - 它是**独立 SDK 会话**（自己 spawn 一个 CLI 进程），不经 model-ingress，
 *     所以既不受路由表管，也不进 run_model_usage 记账 —— 花掉的钱看不见。
 *
 * 一行装饰性旁白不值这个价。现在只剩底稿这条腿：纯字符串整形，不发任何请求，
 * 精灵照常有话说，只是不再有"过几秒被精修覆盖"那一下。
 *
 * 同批退役的还有收场 recap（原 summarizeRecap → `run.recap` 事件）：它没有
 * 本地底稿可垫，唯一的产出方式就是那发 haiku，所以随通道一起走。闲时精灵
 * 改回写问候语 —— 那本来就是 recap 缺席时的既有分支（SpriteSketchLayer 的
 * pickGreeting），不是新造的降级路。
 */

/** 一行整形：合并空白、去首尾引号、硬截。再啰嗦的原文也只放一行上画布。 */
export function sanitizeLine(s, max = 48) {
  const line = String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'「『""]+|["'」』""]+$/g, '')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * 回复 → 精灵手写行：取第一小句。中文回复的第一小句通常本来就像一句旁白
 * （"好的，我来把配色调暖一点"）。
 *
 * 开头的应答词单独剥掉（"好的，"/"明白，"/"没问题，"）：那半句是说给用户听的
 * 客套，占着 26 字的额度还不带信息，剥了剩下的正好是"我在干什么"。
 */
const OPENER_RE = /^(好的?|行|明白了?|收到|没问题|你说得对|说得对|确实|是的|对|OK|ok|Sure|当然)[，,。！!、～~ ]+/;

export function clampFirstClause(text, max = 26) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const parts = t.split(/(?<=[。！？!?；;\n])/).filter(s => s.trim());
  // 整句都是应答词（"没问题！"）就往后挪一句 —— 这行要的是"在干什么"那句
  const hit = parts.find(s => s.replace(OPENER_RE, '').replace(/[。！？!?；;，,、～~ ]/g, ''));
  const cut = hit || parts[0] || t;
  return sanitizeLine(cut.replace(OPENER_RE, '').trim() || cut, max);
}
