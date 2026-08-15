/**
 * quick-summary —— haiku 一次性小结通道（2026-08-14，日记本精灵批）
 *
 * 画布上的铅笔精灵要"写短句"：回合里把 agent 的回复压成一行手写体、收场时
 * 写一条 recap（离开回来一眼知道刚才干了什么）。这两件都是**装饰性**小结 ——
 * 所以这里的一切取舍都朝"便宜、不添乱、坏了无声"倾斜：
 *
 *   - 走 SDK 一次性会话（订阅 OAuth，跟 title 生成同一条计费通路）。服务端
 *     没有独立 ANTHROPIC_API_KEY，Messages API 走不了；这是 haiku 唯一的门。
 *   - 全局并发 1 + 排队上限 2：SDK 一次 spawn 是整个 CLI 进程（秒级、~百 MB
 *     瞬时），summaries 排山倒海只会把机器压死。挤不进队的直接丢（返回 null），
 *     调用方有首句兜底，丢了用户看不出来。
 *   - 15s 超时 abort，失败一律返回 null 不抛 —— 精灵写不出俏皮话不能影响 run。
 *
 * ⚠️ recap 特性调研（2026-08-14）：SDK 0.3.232 只有 `awaySummaryEnabled` 设置
 * 开关（@internal，"Hidden from public SDK types until external launch"），
 * recap 机器本体在 CLI 的 UI 层，流式接口拿不到 —— 所以 recap 在这儿自造。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { platform } from '../runtime/platform.js';

const MODEL = () => process.env.NODESIGN_FAST_MODEL || 'claude-haiku-4-5-20251001-cc';
// 25s：首发要付 CLI 冷启动税（实测首发 15s 会被掐，第二发 ~8s 内回）。
// 短句是装饰，晚到不如不到的反面 —— 它有首句底稿垫着，晚到只是显影慢一拍。
const TIMEOUT_MS = 25_000;
const MAX_QUEUE = 2;

/** 一次性会话的 cwd：固定一个空目录，扔下的 SDK session 文件都归拢在同一个
 *  project 名下（不污染任何真实 workspace）。 */
let scratchDir = null;
function ensureScratch() {
  if (scratchDir) return scratchDir;
  scratchDir = path.join(os.tmpdir(), 'nodesign-quick-summary');
  try { fs.mkdirSync(scratchDir, { recursive: true }); } catch { /* 已存在 */ }
  return scratchDir;
}

/**
 * 会话尘埃清扫（2026-08-14，用户点名）：每发一次性会话都会在
 * CLAUDE_CONFIG_DIR/projects/<scratch 目录名> 落一个 jsonl（实测 3~9KB，
 * 别处零痕迹 —— todos/history 都不沾）。这些文件用完即垃圾（永不 resume），
 * 但**不在收到结果时立删** —— CLI 子进程可能还有收尾写入，删早了是竞态。
 * 做法：每次发车前扫一遍，删掉超过 10 分钟的（在跑的那发永远够新，动不到）；
 * 外加数量兜底 —— 无论多新，只留最近 50 个。崩溃残留下次发车自动收走，
 * 不需要独立的 cron/钩子。
 */
const DUST_MAX_AGE_MS = 10 * 60_000;
const DUST_MAX_COUNT = 50;
let lastSweep = 0;

function sweepSessionDust() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;   // 一分钟内不重复扫
  lastSweep = now;
  try {
    // CLI 的 project 目录名 = cwd 路径的分隔符/点全换成 '-'（实测
    // /tmp/nodesign-quick-summary → -tmp-nodesign-quick-summary）
    const dir = path.join(
      platform.claudeConfigDir, 'projects',
      ensureScratch().replace(/[\\/.]/g, '-'),
    );
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(dir, f);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    files.forEach((f, i) => {
      if (now - f.mtime > DUST_MAX_AGE_MS || i >= DUST_MAX_COUNT) {
        try { fs.unlinkSync(f.full); } catch { /* 正被谁摸着就下次再说 */ }
      }
    });
  } catch { /* 目录还不存在 / 权限怪相：清扫是卫生不是功能，无声跳过 */ }
}

let chain = Promise.resolve();
let queued = 0;

/**
 * 单发 haiku：prompt 进、一行字出。挤不进队 / 超时 / 出错 → null。
 * @param {string} system  一句话系统提示（限定它只输出短句）
 * @param {string} prompt  正文
 * @returns {Promise<string|null>}
 */
export function quickModelLine(system, prompt) {
  if (queued >= MAX_QUEUE) return Promise.resolve(null);
  queued += 1;
  const job = chain.then(() => runOnce(system, prompt)).catch(() => null);
  chain = job.then(() => { queued -= 1; }, () => { queued -= 1; });
  return job;
}

async function runOnce(system, prompt) {
  sweepSessionDust();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const stream = query({
      prompt,
      options: {
        cwd: ensureScratch(),
        abortController: abort,
        model: MODEL(),
        maxTurns: 1,
        tools: [],                    // 纯补全：一件工具都不给
        permissionMode: 'default',
        systemPrompt: system,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: platform.claudeConfigDir,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign/0.0.1',
        },
      },
    });
    for await (const message of stream) {
      if (message.type === 'result') {
        const text = message.subtype === 'success' ? (message.result || '') : '';
        return sanitizeLine(text) || null;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 模型输出整形：一行、去引号、硬截。模型再啰嗦也只放一行上画布。 */
export function sanitizeLine(s, max = 48) {
  const line = String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'「『""]+|["'」』""]+$/g, '')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * 首句兜底（不花钱那条腿）：haiku 到货前先把回复的第一小句写上去 ——
 * 铅笔先起个底稿，显影稿到了再换。中文回复的第一小句通常本来就像一句
 * 旁白（"好的，我来把配色调暖一点"）。
 *
 * 开头的应答词单独剥掉（"好的，"/"明白，"/"没问题，"）：那半句是说给用户听的
 * 客套，占着 26 字的额度还不带信息，剥了剩下的正好是"我在干什么"。
 */
const OPENER_RE = /^(好的?|行|明白了?|收到|没问题|你说得对|说得对|确实|是的|对|OK|ok|Sure|当然)[，,。！!、～~ ]+/;

export function clampFirstClause(text, max = 26) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const parts = t.split(/(?<=[。！？!?；;\n])/).filter(s => s.trim());
  // 整句都是应答词（"没问题！"）就往后挪一句 —— 底稿要的是"在干什么"那句
  const hit = parts.find(s => s.replace(OPENER_RE, '').replace(/[。！？!?；;，,、～~ ]/g, ''));
  const cut = hit || parts[0] || t;
  return sanitizeLine(cut.replace(OPENER_RE, '').trim() || cut, max);
}

/**
 * 回合内回复 → 画布短句。
 *
 * ⭐ 视角是**第一人称**：这句话写在精灵旁边，说话的就是干活的那位自己
 * （"正在把海报配色调暖"），不是解说员在旁边报"它/你在干嘛"。2026-08-15
 * 用户报"看起来是第二人称"——病根是原提示只说了"第一人称"没堵住"你/为你/
 * 帮你"这类**对着用户说话**的写法，而被摘的原文本来就是说给用户听的，
 * 模型顺手就把人称抄过来了。所以现在既给正例也给反例。
 */
export function summarizeReply(text) {
  const body = String(text || '').slice(0, 2400);
  if (body.replace(/\s+/g, '').length < 40) return Promise.resolve(sanitizeLine(body, 26) || null);
  return quickModelLine(
    '把用户给的这段 AI 助手回复摘成一行不超过 16 字的中文短句，放在画布上当旁白。'
    + '视角是助手自己的第一人称（主语「我」省略不写）：说我这会儿在做/刚做完的**那一件具体的事**，'
    + '准确、不夸张、不评价。'
    + '不许出现「你」「为你」「帮你」「已为您」这类对着用户说话的写法，也不要「助手」「它」这类第三人称。'
    + '例：正在把海报配色调暖 / 三张封面已导出 / 在查登录失败的原因。'
    + '只输出短句本身，不要引号不要句号。',
    body,
  );
}

/**
 * 整轮 → recap（离开回来那一眼）。输入是本轮最终回复 + 简单动作账。
 */
export function summarizeRecap({ finalText, toolCount = 0, durationMs = 0 }) {
  const mins = Math.max(1, Math.round(durationMs / 60_000));
  const body = String(finalText || '').slice(0, 3000);
  if (!body.trim()) return Promise.resolve(null);
  return quickModelLine(
    '用不超过 40 字的中文写一句「我刚才做了什么」：第一人称（主语「我」省略不写），'
    + '说清这一轮实际做完的事，有没留下待办；有待办就点出来，没有就说都做完了。'
    + '不许出现「你」「为你」「帮你」，也不要「助手」「它」这类第三人称。只输出这一句，一行。',
    `（本轮约 ${mins} 分钟，动了 ${toolCount} 次工具）\n${body}`,
  );
}
