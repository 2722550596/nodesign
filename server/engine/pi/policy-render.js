/**
 * engine/pi/policy-render.js — 「底线」政策块的抽取与渲染（M2：从 agent/system-prompts.js
 * 搬来的纯函数版，逻辑逐字等价）。
 *
 * 为什么拆出来：M2 起政策节不再由主进程 renderPrelude 拼进系统提示词，而是由 pi preset
 * 里的 {{ndPolicy}} 宏在 pi 进程内展开（extensions/prompt-support.ts 注册）。宏 render 是
 * 同步的，所以这里全部同步（readFileSync 模块级缓存，同 system-prompts.js 模式）。
 *
 * 消费方：
 * - extensions/prompt-support.ts（宏 render，读 env 定档位）
 * - extensions/migrate-prelude.mjs（生成 preset 时校验标记块还在）
 * - policy-render.test.js / agent/prelude-render.test.js（回归）
 *
 * system-prompts.js 的 renderPrelude 保留不删（删除波处理），本文件与它并存期间
 * 两边行为必须一致 —— 测试同时钉两份。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** prelude 原文路径（相对本文件：server/engine/pi/ → server/engine/agent/prompts/）。 */
export const PRELUDE_MD_PATH = path.join(__dirname, '..', 'agent', 'prompts', 'nodesign-prelude.md');

// 成人段与外审档联动（2026-08-08）：一个旋钮同时管 GPT 外审和提示词口径，
// 两边永远一致。off=明文允许（站主/获批账号）、loose=原默认、strict=收敛。
// 三档文案从 system-prompts.js 原样搬来，逐字不改。
export const ADULT_POLICY = {
  off: '**成人内容明确允许，不用迂回。** 露骨的性与亲密描写照常写、写到位，不留白、不淡化、\n不换成暗示手法带过，前后也不加提醒和免责声明。用户没要求收敛就不要自己收敛，写完接着干活。\n**写实风格照做** —— 照片级真实感的虚构人物不是真人，画得像不构成任何问题，生图同理。\n不做的只有两种：涉及未成年人；把可指认的现实个人（点名的公众人物、用户给的真人照片）\n放进这类内容。除此之外不要自己发明别的边界。',
  loose: '成人向的亲密情节可以写，涉及未成年人是上面那条绝对红线，真实存在的个人也不写。',
  strict: '露骨的成人内容在这个账号档位下不写——涉及时收敛处理、用留白带过。',
};

/**
 * 「底线」那一节在 prelude 里有**两份并排写着**的版本，标记块框起来：
 * `nd:policy:full`（对外开放平台的完整产物政策）和 `nd:policy:min`。渲染时留一份、
 * 删一份，两个标记本身永远不进模型上下文。
 *
 * 为什么用显式标记而不是按标题正则切：靠 `## 底线` 到下一个 `##` 去猜边界的话，
 * 以后谁在这节里加个三级标题，剥离就会剥掉半截 —— 而且不会报错，只会让线上某条
 * 路径的提示词悄悄少一段。标记块是写死的边界，配 extractPolicyBlocks 的断言，切错当场炸。
 */
export const POLICY_BLOCK = /<!-- nd:policy:(full|min):start -->\n([\s\S]*?)<!-- nd:policy:\1:end -->\n/g;

/** CRLF 归一：Windows git autocrlf 会把 md checkout 成 CRLF，POLICY_BLOCK 按 `\n` 切块
 * （.gitattributes 已钉 LF，这里是第二道保险，老 checkout 不重拉也能起）。同 system-prompts.js。 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 从 prelude md 原文抽出 full / min 两个政策块体（不含标记行）。
 * 缺一即 throw —— 加载期断言语义保留：少一份说明有人编辑 prelude 时把标记删了，
 * 那时候正则会静默退化（uncensored 路径拿到完整底线 / 整节消失），必须当场炸。
 *
 * @param {string} md prelude 原文（内部先做 CRLF 归一 + trim，同 NODESIGN_PRELUDE 的读法）
 * @returns {{full: string, min: string}}
 */
export function extractPolicyBlocks(md) {
  const text = normalizeNewlines(md).trim();
  const found = {};
  for (const m of text.matchAll(POLICY_BLOCK)) found[m[1]] = m[2];
  for (const want of ['full', 'min']) {
    if (!(want in found)) {
      throw new Error(`[policy-render] nodesign-prelude.md 缺少 nd:policy:${want} 标记块 —— 提示词渲染会静默走错版本`);
    }
  }
  return { full: found.full, min: found.min };
}

/**
 * 渲染政策节（{{ndPolicy}} 宏的展开结果）。
 *
 * @param {{full: string, min: string}} blocks extractPolicyBlocks 的产物
 * @param {'off'|'loose'|'strict'} level 成人段档位（moderation.levelFor 算出来的）
 * @param {boolean} uncensored true 时留 min 版 —— 本地无审查权重走这条
 *   （model-context 表里的 `uncensored` 位，今天只有 qwen3.8-27b）。
 *
 *   这不是"把成人档位调到最宽"：off 档改的只是成人段一句话，整节产物政策照旧在。
 *   min 版是**整节换掉**，站主 08-19 拍板 —— 那节的前提是"对外开放、产物能一键挂
 *   到站主域名下"，而这条路跑在自己租的盒子上、只对获批账号开、产物不外发，
 *   前提不成立。留下的一条不随档位变，也不随谁在用变。
 *
 *   ⚠️ 调用方拿不到模型信息时落**完整**那份（uncensored=false），绝不落 min。
 *   未知 level 落 loose（拼错档位名不能变成放开）。
 */
export function renderPolicyBlock(blocks, level, uncensored) {
  const body = uncensored === true ? blocks.min : blocks.full;
  return body.replace('{{ADULT_POLICY}}', ADULT_POLICY[level] || ADULT_POLICY.loose).trim();
}

// ── 模块级缓存的 prelude 块（同 system-prompts.js 的 NODESIGN_PRELUDE 模式）──
// 宏 render 是同步的，md 只在模块加载时读一次。读失败不 throw（扩展加载期炸会
// 拖垮整个 pi 进程）—— 记 warn，renderNdPolicy 走保守兜底。
let cachedBlocks = null;
let cachedError = null;
try {
  cachedBlocks = extractPolicyBlocks(fs.readFileSync(PRELUDE_MD_PATH, 'utf8'));
} catch (err) {
  cachedError = err;
  console.warn('[policy-render] failed to load policy blocks from nodesign-prelude.md:', err.message);
}

/**
 * {{ndPolicy}} 宏的渲染入口（prompt-support.ts 直接调这个）。
 *
 * 档位来自 env（lifecycle spawn 时注入，主进程算好）：
 * - NODESIGN_ADULT_LEVEL：off|loose|strict，缺省/未知落 loose
 * - NODESIGN_UNCENSORED："1" → min 版，其余一律 full（拿不到信息绝不落 min）
 *
 * 失败兜底：md 读不到 / 标记块缺失 → 返回 full 块的保守替代。绝不返回空串 ——
 * 政策节消失是安全事故；宁可返回最严的 loose 版 full 块原文。
 */
export function renderNdPolicy(env = process.env) {
  const level = env.NODESIGN_ADULT_LEVEL || 'loose';
  const uncensored = env.NODESIGN_UNCENSORED === '1';
  if (cachedBlocks) return renderPolicyBlock(cachedBlocks, level, uncensored);
  // 兜底：缓存没建起来（md 缺失/标记被删）。full 块拿不到就退到内嵌的 loose 一句话，
  // 保证政策节永远非空、且永远不往宽了放。
  const fallbackFull = `## 底线\n\n${ADULT_POLICY.loose}`;
  return uncensored ? ADULT_POLICY.loose : fallbackFull;
}
