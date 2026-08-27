/**
 * guard-rules.js —— Nodesign pi 安全闸 + lint 的纯判据（M2 GuardsExt 切片）
 *
 * 语义源（逻辑照搬，SDK 工具名/字段 → pi 重映射）：
 *   - agent/hooks/pre-workspace-scope-guard.js → checkWorkspaceScope（项目边界闸）
 *   - agent/hooks/pre-performance-log-guard.js → checkPerformanceLog（演出记录隐私闸）
 *   - agent/hooks/canvas-validate.js           → lintCanvasFile / isCanvasFilePath（deck lint）
 *   - agent/hooks/site-validate.js             → lintSiteFile / isSitePagePath（站点页 lint）
 *
 * pi 事实（源码核过，pi-rp packages/coding-agent/src/core/tools/）：
 *   - 内建工具名全集 read / write / edit / grep / find / ls / bash（无 glob）。
 *   - 主会话不设 defaultTools 白名单（2026-08-27 删）→ 走 pi 默认激活集
 *     read/bash/edit/write + state_update/get_state/subagent/subagent_profiles
 *     （agent-session.ts:3672），grep/find/ls 主会话不激活（bash 覆盖）；
 *     子代理自带 read/grep/find/ls/bash（subagent/prepare.ts:168）。
 *   - bash 无 path 字段，不走本文件的路径闸（边界闸只管文件工具，bash 越界靠
 *     失败建议引导 + prelude 纪律）。
 *   - 路径字段统一 `path`（read.ts:22 / write.ts:16 / edit.ts:47 / grep.ts:26 /
 *     find.ts:33 / ls.ts:15；grep/find/ls 的 path 是 optional）。READ_TOOLS 仍列
 *     grep/find/ls 是纵深防御：哪天被激活（子代理 / 未来配置）闸自动覆盖。
 *
 * 纪律：
 *   - fail-open：判据自身异常 → 放行（返 null / []）。guards.ts 薄壳里还有一层
 *     try/catch —— pi 的 tool_call handler throw 会变 fail-closed 拦截，必须自己兜住。
 *   - deny reason 带转向建议（教 agent 换做法，不只拒绝）。
 *   - 演出文件夹判据必须 YAML 解析、只认 历史.文件 —— 正则抓第一个 `文件:` 会把
 *     系统层条目的设定文件当成记录名（2026-08-15 在真配置上量出来的事故）。
 *
 * 本文件纯逻辑，vitest 直测（guard-rules.test.js）；guards.ts（pi extension）是薄壳。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import YAML from 'yaml';

// ─────────────────────────────────────────────────────────────────────────────
// 闸 ①：项目边界（写只准本工作区/临时目录；读只拦数据根内部越界）
// ─────────────────────────────────────────────────────────────────────────────

/** pi 写工具（SDK 的 Write/Edit/MultiEdit/NotebookEdit → pi 只有 write/edit） */
const WRITE_TOOLS = new Set(['write', 'edit']);
/** pi 读工具（SDK 的 Read/Grep/Glob → pi 的 read/grep/find/ls） */
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

function insideDir(abs, dir) {
  return abs === dir || abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** 临时目录（沙盒会把 TMPDIR 指到自己那份，几个都认） */
function tempDirs() {
  return [process.env.TMPDIR, os.tmpdir(), '/tmp'].filter(Boolean).map(d => path.resolve(d));
}

/**
 * 项目边界闸。读写不一样严：
 *   - 写（write/edit）：只准落 workspaceRoot 内或临时目录，往外写没有正当理由；
 *   - 读（read/grep/find/ls）：只拦 dataRoot 内部的越界（别的项目的工作区），
 *     仓库、skill 目录、/tmp 照读不误 —— 那是干活要用的。
 * 凭据不归它管（那是平台 protectedPathRules 的活）。
 *
 * @param {{toolName?:string, input?:Record<string,unknown>, workspaceRoot?:string, dataRoot?:string}} args
 * @returns {null | {block:true, reason:string}} null=放行
 */
export function checkWorkspaceScope({ toolName, input, workspaceRoot, dataRoot } = {}) {
  try {
    if (!workspaceRoot) return null;
    const isWrite = WRITE_TOOLS.has(toolName);
    const isRead = READ_TOOLS.has(toolName);
    if (!isWrite && !isRead) return null;            // 名单外工具（MCP 工具等）不归这道闸
    if (isRead && !dataRoot) return null;            // 没数据根，读侧无从判越界
    const ws = path.resolve(workspaceRoot);
    const root = dataRoot ? path.resolve(dataRoot) : null;
    const v = input?.path;                           // pi 工具路径字段统一是 path
    if (typeof v !== 'string' || !v) return null;
    const abs = path.resolve(ws, v);                 // 相对路径按工作区解析
    if (insideDir(abs, ws)) return null;             // 自己的工作区，放行
    if (isWrite) {
      if (tempDirs().some(d => insideDir(abs, d))) return null;   // 临时文件随便写
      return {
        block: true,
        reason: `${toolName} 只能落在你自己的工作区里（${ws}），或者临时目录。`
          + '产物、草稿、附件全都归工作区管；往外写一律拒绝。',
      };
    }
    if (!root || !insideDir(abs, root)) return null; // 数据根之外的读不归这道闸管
    return {
      block: true,
      reason: '这个路径在别的项目的工作区里，不是你这个项目的东西。'
        + `你的工作区是 ${ws} —— 用相对路径就好，越过它去读写别人的项目一律拒绝。`,
    };
  } catch { return null; }                           // 判据自己出错 → 放行（fail-open）
}

// ─────────────────────────────────────────────────────────────────────────────
// 闸 ②：演出记录隐私（演出文件夹的对话记录/摘要禁点名读；写不拦）
// ─────────────────────────────────────────────────────────────────────────────

const PERF_FIXED = ['对话.jsonl', '摘要.json'];
const PERF_CONFIG_FILE = '编排.yaml';
/**
 * 只拦「路径点名那个文件」的读法：read/grep 的 path 直指记录文件。
 * find/ls 是目录扫描、write 是建场种开场白（skill 教的正路）——照源闸边界放行。
 */
const PERF_READ_TOOLS = new Set(['read', 'grep']);

/**
 * 一个演出文件夹认哪几个记录文件名（固定两个 + `历史.文件` 自定义的记录名）。
 *
 * ⚠️ 必须**解析 YAML** 而不是正则抓第一个 `文件:` —— 系统层条目的
 * `文件: 设定/叙述者.md` 排在 `历史.文件` 前面，正则版会把用户的设定文件
 * 当成记录名（2026-08-15 在真配置上量出来的）。
 * 半写完的 YAML 解析失败 → 只认固定两个名，不拦别的。
 * @returns {Promise<null | Set<string>>} null=同目录没有 编排.yaml（不是演出文件夹）
 */
async function namesOfPerformanceDir(dir) {
  let raw;
  try { raw = await fs.readFile(path.join(dir, PERF_CONFIG_FILE), 'utf8'); } catch { return null; }
  const names = new Set(PERF_FIXED);
  try {
    const doc = YAML.parse(raw);
    const rec = doc?.历史?.文件;
    if (typeof rec === 'string' && rec.trim()) names.add(path.basename(rec.trim()));
  } catch { /* 写了一半的 YAML：固定两个名照旧生效 */ }
  return names;
}

/**
 * 演出记录隐私闸。RP 台词只走 chatai 通路（中转站），不进设计会话：
 * agent 线的上下文进上游模型，用户的演出原文不该去。
 *
 * @param {{toolName?:string, input?:Record<string,unknown>, workspaceRoot?:string}} args
 * @returns {Promise<null | {block:true, reason:string}>} null=放行
 */
export async function checkPerformanceLog({ toolName, input, workspaceRoot } = {}) {
  try {
    if (!PERF_READ_TOOLS.has(toolName)) return null;
    const fp = input?.path;
    if (typeof fp !== 'string' || !fp) return null;
    const abs = path.isAbsolute(fp) ? fp : path.resolve(workspaceRoot || '', fp);
    const names = await namesOfPerformanceDir(path.dirname(abs));
    if (!names) return null;                         // 同目录没有 编排.yaml → 不是演出文件夹
    const base = path.basename(abs);
    if (!names.has(base)) return null;
    return {
      block: true,
      reason: `「${base}」是这场演出的对话记录——用户的演出原文是隐私，只走 chatai 通路，不进设计会话。`
        + '要推进剧情改 状态/ 里的文件（尾部条目每轮现读）；用户想给你看某段戏会自己粘贴过来。',
    };
  } catch { return null; }                           // 判据自己出错 → 放行（fail-open）
}

// ─────────────────────────────────────────────────────────────────────────────
// lint ①：canvas（deck）三条硬规则 —— 照搬 canvas-validate.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验前预处理：strip HTML 注释 + CSS/JS block 注释
 *
 * 防止 false positive：模板里的 `<!-- ┄┄┄ 骨架范例 ... data-anchor="cover" ┄┄┄ -->`
 * HTML 注释 + page-styles 里"取消注释切到 ppt mode"的 CSS 注释切片，原始 grep
 * 都会误匹配。预先 strip 后再校验。
 *
 * 仅用于 validator 内部 regex 扫描；agent 看到的源文件不受影响。
 */
function stripCommentsForValidate(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')        // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, '');      // CSS / JS block 注释（含 babel script）
}

/**
 * LAYOUT_COMPONENT_TRIGGERS — data-layout 值 → 推荐组件 import / detect 列表
 *
 * 校验项 2（#6）消费：data-layout ∈ keys + babel script 段所有 detect 都不命中
 * → warn agent reach for 推荐组件（模板自带 inline 4 件 / 或 import @radix-ui）
 *
 * 形态：{ [layoutName]: { recommend: string[], detect: string[] regex sources } }
 */
const LAYOUT_COMPONENT_TRIGGERS = {
  'comparison-table':         { recommend: ['<Tabs>', '<Card>'], detect: ['\\bTabs\\s*[\\.<]', '<TabsList\\b', '<Card\\b', "import[^;]*['\"]@radix-ui/react-tabs['\"]"] },
  'feature-cards':            { recommend: ['<Card> 阵列'], detect: ['<Card\\b', '<CardHeader\\b', '<CardContent\\b', '<CardTitle\\b'] },
  'use-cases':                { recommend: ['<Tabs>', '<Card> 阵列'], detect: ['\\bTabs\\s*[\\.<]', '<Card\\b', "import[^;]*['\"]@radix-ui/react-tabs['\"]"] },
  'core-products':            { recommend: ['<Card> 阵列', '<Tabs>'], detect: ['<Card\\b', '\\bTabs\\s*[\\.<]'] },
  'tech-highlights':          { recommend: ['<Card> 阵列'], detect: ['<Card\\b', '<Badge\\b'] },
  'feature-array':            { recommend: ['<Tabs>', '<Card>'], detect: ['\\bTabs\\s*[\\.<]', '<Card\\b'] },
  'variant-showcase':         { recommend: ['<Tabs> (≤4) / embla-carousel-react (>4)'], detect: ['\\bTabs\\s*[\\.<]', 'embla-carousel-react', 'useEmblaCarousel'] },
  'comparison':               { recommend: ['<Tabs>', '<Card> 对比阵列'], detect: ['\\bTabs\\s*[\\.<]', '<Card\\b'] },
  'step-switcher':            { recommend: ['<Tabs>'], detect: ['\\bTabs\\s*[\\.<]', "import[^;]*['\"]@radix-ui/react-tabs['\"]"] },
  'concept-vs-misconception': { recommend: ['<Tabs>', '<Card> 对照阵列'], detect: ['\\bTabs\\s*[\\.<]', '<Card\\b'] },
  'config-switcher':          { recommend: ['<Tabs>'], detect: ['\\bTabs\\s*[\\.<]'] },
  'quadrant':                 { recommend: ['<Card> 4 格阵列'], detect: ['<Card\\b', 'grid-cols-2'] },
};

/**
 * 校验项 1：data-anchor 唯一性
 *
 * 全文 grep `data-anchor="X"`，按值分组，重名 → 报冲突 + 列页号
 */
function validateAnchorUniqueness(html) {
  const matches = [...html.matchAll(/data-anchor\s*=\s*['"]([^'"]+)['"]/g)];
  if (matches.length === 0) return null;

  const groups = new Map();
  for (const m of matches) {
    const value = m[1];
    const idx = m.index;
    // 反推所在 page：往前找最近的 <section data-page="N">
    const before = html.slice(0, idx);
    const lastSection = [...before.matchAll(/<section\b[^>]*data-page\s*=\s*['"](\d+)['"]/g)].pop();
    const page = lastSection ? lastSection[1] : '?';
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(page);
  }

  const conflicts = [];
  for (const [value, pages] of groups) {
    if (pages.length > 1) {
      conflicts.push(`"${value}" → 出现在 page ${[...new Set(pages)].join(', ')} (${pages.length} 次)`);
    }
  }
  if (conflicts.length === 0) return null;
  return {
    title: `data-anchor 重名 ${conflicts.length} 处`,
    detail: conflicts.join('\n   ') + '\n   data-anchor 必须 deck 内唯一（重名加 -pN 页号或角色后缀，如 portrait-name-p3 / cover-sub-1）。findElementByAnchor 三层 fallback 第一层是按 data-anchor 查；重名时 querySelector 永远返第一个匹配，DirectEdit / 评论 pin 到错的元素。',
  };
}

/**
 * 校验项 2：data-layout 推荐组件 reach for 检查（#6）
 *
 * data-layout ∈ LAYOUT_COMPONENT_TRIGGERS keys 且整文件 babel script 段所有
 * detect[i] regex 都不命中 → warn agent 用 inline 4 件
 */
function validateLayoutComponents(html) {
  const layoutMatches = [...html.matchAll(/data-layout\s*=\s*['"]([^'"]+)['"]/g)];
  if (layoutMatches.length === 0) return null;

  // 抽 babel script 段（多个）拼一起
  const babelBlocks = [...html.matchAll(/<script[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).join('\n');

  const issues = [];
  const seen = new Set();
  for (const m of layoutMatches) {
    const layoutName = m[1];
    if (seen.has(layoutName)) continue;
    seen.add(layoutName);
    const trigger = LAYOUT_COMPONENT_TRIGGERS[layoutName];
    if (!trigger) continue;
    const anyHit = trigger.detect.some(src => {
      try { return new RegExp(src).test(babelBlocks); } catch { return false; }
    });
    if (!anyHit) {
      issues.push(`data-layout="${layoutName}" 适合 ${trigger.recommend.join(' / ')}，但 babel script 段没检测到对应组件`);
    }
  }
  if (issues.length === 0) return null;
  return {
    title: `${issues.length} 处 data-layout 漏用推荐组件`,
    detail: issues.join('\n   ') + '\n   模板 <script id="__nd-shadcn-lite"> 已自带 Card / Button / Badge / Tabs，0 import 直接 <Card> / <Tabs> 用即可。选型见首次写 deck 时注入的 hybrid 技术参考（inline shadcn 一节）。',
  };
}

/**
 * 校验项 3：data-layout-role 必装
 *
 * 每个 <section data-page> 必标 data-layout-role
 */
function validateLayoutRolePresence(html) {
  const sections = [...html.matchAll(/<section\b[^>]*data-page\s*=\s*['"](\d+)['"][^>]*>/g)];
  if (sections.length === 0) return null;
  const missing = [];
  for (const m of sections) {
    const tag = m[0];
    if (!/data-layout-role\s*=/.test(tag)) {
      missing.push(m[1]);
    }
  }
  if (missing.length === 0) return null;
  return {
    title: `${missing.length} 个 section 缺 data-layout-role`,
    detail: `Page ${missing.join(', ')} 没标 data-layout-role（image-led / text-led / data-led / hybrid 必选其一）。这字段决定页型分布 + 视觉判断；缺它系统按"未知"处理，patterns/<role>.md 也无法对应。`,
  };
}

/** 纯 lint：html 文本 → 问题列表（空数组 = 干净）。三条规则串行。 */
export function lintCanvasHtml(html) {
  const cleaned = stripCommentsForValidate(String(html));
  return [
    validateAnchorUniqueness(cleaned),
    validateLayoutComponents(cleaned),
    validateLayoutRolePresence(cleaned),
  ].filter(Boolean);
}

/**
 * deck 认定闸（照搬 canvas-validate.js handler 首段）：扩展名是 html，
 * 且名字叫 canvas.html 或内容带 deck wrap 标记（deck 现在叫 <名>.html，
 * canvas.html 只是常用名；站点页也可能收进子目录，靠标记区分）。
 */
export function isCanvasFilePath(filePath, html) {
  if (!filePath || !/\.html?$/i.test(filePath)) return false;
  return /canvas\.html$/i.test(filePath) || String(html).includes('__nd-deck-wrap');
}

/**
 * deck 文件 lint 总入口：先过认定闸再跑三条规则。非 deck → []。
 * @returns {Array<{title:string, detail:string}>}
 */
export function lintCanvasFile(filePath, content) {
  try {
    if (!isCanvasFilePath(filePath, content)) return [];
    return lintCanvasHtml(content);
  } catch { return []; }                             // lint 自己出错 → 当没问题（fail-open）
}

// ─────────────────────────────────────────────────────────────────────────────
// lint ②：站点页两条硬规则 —— 照搬 site-validate.js
// ─────────────────────────────────────────────────────────────────────────────

const strip = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '');

/**
 * 纯函数：html 文本 → 问题列表（空数组 = 干净）。
 * 两条硬规则：
 *   1. `<meta name="viewport">` 缺失 → 手机端按 980px 虚拟视口渲染，媒体查询
 *      看着"没生效"
 *   2. 根路径 `href="/x"` / `src="/x"` → 预览走 `/api/projects/<id>/artifact-file/…`
 *      前缀，根路径跳出前缀直接 404（发布到独立域名后反而正常，所以本地更容易漏）
 * @returns {Array<{title:string, detail:string}>}
 */
export function lintSiteHtml(html) {
  const src = strip(html);
  const issues = [];
  if (!/<meta\s[^>]*name\s*=\s*["']viewport["']/i.test(src)) {
    issues.push({
      title: '缺 <meta name="viewport">',
      detail: '没有它手机端按 980px 虚拟视口渲染，媒体查询看着"没生效"。加 <meta name="viewport" content="width=device-width, initial-scale=1">。',
    });
  }
  // 根路径：href="/x" 或 src="/x"，排除协议相对 "//cdn…"；"/" 单独一个也算（回首页应写 index.html）
  const roots = [...src.matchAll(/\b(?:href|src|action)\s*=\s*["'](\/(?!\/)[^"']*)["']/gi)].map(m => m[1]);
  if (roots.length) {
    const uniq = [...new Set(roots)].slice(0, 5);
    issues.push({
      title: `根路径链接 ${roots.length} 处（${uniq.join(' ')}${roots.length > uniq.length ? ' …' : ''}）`,
      detail: '预览和导出都走 artifact-file/<路径> 前缀，根路径会跳出前缀直接 404。站内一律相对路径：about.html / assets/x.png / ../assets/generated/x.png。',
    });
  }
  return issues;
}

/** 相对工作区的 .html，且在子目录里（站点页）—— deck 在根上，不归这里 */
export function isSitePagePath(workspaceRoot, fp) {
  if (!fp || !/\.html?$/i.test(fp)) return false;
  const rel = path.relative(workspaceRoot, path.resolve(workspaceRoot, fp)).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || !rel.includes('/')) return false;
  if (/^(exports|node_modules|_drafts|\.)/.test(rel)) return false;   // _drafts/ 是独立单页，不是站点页
  return true;
}

/**
 * 站点页 lint 总入口：先过 isSitePagePath 闸（只看子目录 html；工作区根上的
 * .html 是 deck，归 canvas lint），再排除收进文件夹的 deck（带 wrap 标记）。
 * @returns {Array<{title:string, detail:string}>}
 */
export function lintSiteFile(filePath, content, workspaceRoot) {
  try {
    if (!workspaceRoot) return [];
    if (!isSitePagePath(workspaceRoot, filePath)) return [];
    if (String(content).includes('__nd-deck-wrap')) return [];   // 收进文件夹的 deck，不是站点页
    return lintSiteHtml(content);
  } catch { return []; }                             // lint 自己出错 → 当没问题（fail-open）
}
