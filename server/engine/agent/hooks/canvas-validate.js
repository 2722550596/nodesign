/**
 * Canvas 一致性校验（2026-05-08 范式重整 #1/#3/#5/#6 反馈通道）。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 读 canvas.html 时的最大字节数（防大文件吞内存） */
const CANVAS_HTML_MAX_BYTES = 2 * 1024 * 1024;

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
 * 校验项 4（#6）消费：data-layout ∈ keys + babel script 段所有 detect 都不命中
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

/**
 * Canvas validation 总入口（PostToolUse Edit|Write canvas.html 触发）
 *
 * matcher 第一行 path filter：仅对 canvas.html 跑校验，其他文件 noop。
 * 单 hook 内 3 项串行校验（in-memory，~ms），有 issue 拼 systemMessage 注下一轮。
 *
 * 单 turn 反馈（不持久化）：agent 不修则下次 Edit 自然惩罚再报，跨 turn 持续
 * 延期下一轮（spec.json schema 扩展）。
 */
export function makePostToolUseCanvasValidationHandler({ ctx: _ctx, workspaceRoot }) {
  return async (input, _toolUseId, _options) => {
    try {
      const fp = input?.tool_input?.file_path;
      // deck 现在叫 <名>.html（canvas.html 只是常用名）：先按扩展名放行，读到内容再按 deck wrap 标记认
      if (!fp || !/\.html?$/i.test(fp)) return {};
      if (!workspaceRoot) return {};

      // 校验刚写的那份（2026-07-28）：任务模型下 deck 在 tasks/<任务>/canvas.html，
      // 这里以前固定读 cwd/canvas.html —— 文件不存在直接 ENOENT return，
      // 于是整套一致性校验在任务模型下从来没跑过。
      const canvasPath = path.resolve(workspaceRoot, fp);
      let html;
      try {
        const stat = await fs.stat(canvasPath);
        if (stat.size > CANVAS_HTML_MAX_BYTES) return {};  // 大文件 noop
        html = await fs.readFile(canvasPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
      }
      if (!/canvas\.html$/i.test(fp) && !html.includes('__nd-deck-wrap')) return {};   // 不是 deck（站点页等）

      // 预 strip 注释（HTML + CSS/JS block）防 false positive
      const cleaned = stripCommentsForValidate(html);
      // 依序调对应 validator。旧版含 mode-CSS / 必装 CSS 两项已删
      // （2026-05-08 范式简化：不再有 deck-mode）

      const issues = [
        validateAnchorUniqueness(cleaned),
        validateLayoutComponents(cleaned),
        validateLayoutRolePresence(cleaned),
      ].filter(Boolean);

      if (issues.length === 0) return {};

      const body = issues.map((i, idx) => `${idx + 1}. ${i.title}\n   ${i.detail}`).join('\n\n');
      return {
        systemMessage:
          `<system-reminder>\n[canvas-validate] 你刚改完 ${fp}，系统检测到 ${issues.length} 项可疑：\n\n`
        + body
        + `\n\n如果有意为之（custom mode / 故意命名重复 等）忽略；否则在下一轮主动修。\n`
        + `</system-reminder>`,
      };
    } catch (err) {
      console.warn('[hooks/canvas-validate] threw:', err.message);
      return {};
    }
  };
}
