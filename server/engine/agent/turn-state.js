/**
 * server/engine/agent/turn-state.js — 每 turn 动态状态注入装配（M2 pi 化）
 *
 * SDK 时代这套逻辑住在 hooks/user-prompt-submit.js（UserPromptSubmit hook 的
 * additionalContext 注入）。M2 引擎换成 pi-rp 后没有 SDK hooks —— 搬到 session-loop
 * 的 runTurn 区：client.prompt 之前把状态块拼进 prompt text（`<system>…</system>`
 * 包裹，对齐 turn-compose 原 pendingSummary 块的约定）。
 *
 * 注的是状态不是指令：cwd、素材清单、便利贴、画布关系线、产物清单、板书、视点、
 * 黑板模式。怎么用这些东西住 prelude（preset 里缓存的 system prompt）；每轮再说
 * 一遍是上下文里的 N 倍重复。
 *
 * ## 首轮全量，之后只报变化
 *
 * 每节算指纹记在下面的 turn memory（按 sessionId）：
 *   - 首轮（或压缩后 / 进程重启后）：全量 + 结尾"请基于这些信息处理用户的请求"
 *   - 之后：变了的节全文（标「有变化」），素材/便利贴这种清单只报新增/移除；没变
 *     的节只在末尾一行点名"未变：…"；一节都没变就一句话
 * compaction_end 事件后调 resetTurnStateMemory —— 旧状态块已被摘要吞了，"同上轮"
 * 没有所指，下一轮必须重新全量。
 *
 * ## turn-state-memory 内联（原 hooks/turn-state-memory.js 整份搬入）
 *
 * 不 import 旧文件：hooks/ 全族在 wave 3 删除波里要删，留 import 等于给删除波埋
 * 返工。djb2 指纹 + LRU 300 逻辑逐字搬来，模块自包含。
 *
 * 采集纪律：任一节采不到就不出现（扫不动就不说，别拿错信息误导）；任何异常
 * fail-soft（warn + 跳过该节），绝不炸 turn。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readUiConfigFile, withUiDefaults } from '../../projects/ui-config.js';
import { readAssetsSummary } from '../../projects/assets-summary.js';
import { relationsDigest } from '../../lib/board-relations.js';
import { getViewpoint, describeViewpoint } from '../../projects/viewpoint-store.js';
import { recentChalk, CHALK_DIR } from '../../lib/chalk.js';
import { readBoard } from '../../projects/board-store.js';
import { estimateSizeOn } from '../../lib/board-kind-sizes.js';
import { layerOf } from '../../lib/canvas-id.js';
import {
  getActiveArtifact, listWorkspaceArtifacts, taskManifest, kindDef,
  KIND_DECK, KIND_SITE, ENTRY_FILE,
} from '../../lib/artifact-target.js';

// ── turn memory（原 hooks/turn-state-memory.js 整份内联）──
// 键按 sessionId（一次对话一份记忆）。上限 300 个会话，LRU 淘汰 —— 会话结束不
// 另外清（多数会话没几轮，留着也就几百字节）。

const MAX_SESSIONS = 300;
/** sessionId → { sections: Map<key, {hash:string, items:string[]|null}>, turns: number } */
const memory = new Map();

/** djb2：够用的短指纹，不引 crypto */
export function fingerprint(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function getTurnMemory(sessionId) {
  if (!sessionId) return null;
  const m = memory.get(sessionId);
  if (m) { memory.delete(sessionId); memory.set(sessionId, m); }   // LRU 触碰
  return m || null;
}

export function setTurnMemory(sessionId, sections) {
  if (!sessionId) return;
  const prev = memory.get(sessionId);
  memory.delete(sessionId);
  memory.set(sessionId, { sections, turns: (prev?.turns || 0) + 1 });
  while (memory.size > MAX_SESSIONS) memory.delete(memory.keys().next().value);
}

/** 两个清单的差 → { added, removed }（给素材 / 便利贴这种按项报变化的节用） */
export function diffItems(prevItems, nextItems) {
  const prev = new Set(prevItems || []);
  const next = new Set(nextItems || []);
  return {
    added: [...next].filter(x => !prev.has(x)),
    removed: [...prev].filter(x => !next.has(x)),
  };
}

export const _memory = memory;   // 测试用

// ── 状态采集 + 渲染 ──

/** PDF/Office 文档的解法（系统自带工具；python 包没装且装不上 —— 08-19 上报实锤）。只在首次出现二进制文档时说一遍。 */
const BINARY_DOC_HINT = 'PDF / PPTX / DOCX / XLSX 直接 Read 拿不到结构化内容（二进制或 zip 包）。用系统自带的工具解'
  + '（pdfplumber/PyPDF2/python-docx/openpyxl 这些 python 包**没装且装不上**，别试）：'
  + 'pdf 文本 `pdftotext -layout 文件.pdf -`；pdf 转页图 `pdftoppm -png -r 100 文件.pdf 页前缀` 再 Read 图片；pdf 嵌入图 `pdfimages -png`。'
  + 'docx/pptx/xlsx 用 `soffice --headless --convert-to txt|csv|pdf --outdir 目录 文件`（xlsx 转 csv；⚠️ soffice 吃不下中文文件名，先拷成 ASCII 名，并加 `-env:UserInstallation=file:///tmp/lo-任意名` 免得和渲染管线抢 profile）；'
  + 'docx/pptx 里的嵌入图直接 `unzip -o 文件 "word/media/*"`（pptx 是 `ppt/media/*`）。'
  + '**提取出来的不只是文本，通常还包含嵌入图片** —— 提取完一定 Read 看图片，别只看 stdout 文本就以为信息齐了。';

/**
 * 采集各节。每节 { key, title, text, items? }：text 是全量文案；items 是可按项报变化的清单。
 * 任一节采不到就不出现（跟以前一样：扫不动就不说，别拿错信息误导）。
 * 单节抛错 → warn + 跳过该节（fail-soft），不炸 turn。
 *
 * projectId 可选：缺省时视点 / 关系线两节静默缺席（测试只给 workspaceRoot 也能跑）。
 */
export async function collectSections({ workspaceRoot, sessionId, projectId }) {
  const sections = [];
  /** 每节套一层：采集模块自己多数 fail-soft，这里是兜底 —— 任何意外只丢一节 */
  const gather = async (key, fn) => {
    try { await fn(); } catch (err) {
      console.warn(`[turn-state] 采集 ${key} 节失败（跳过）: ${err.message}`);
    }
  };

  // cwd：唯一真正动态的一行。路径表（./ notes/ assets/ 各是什么）在 prelude
  sections.push({ key: 'cwd', title: '工作区', text: `你的 cwd 是 ${workspaceRoot} —— 项目工作区，产物直接住这儿（路径表见 prelude「你跑在哪」）。` });

  // 素材：顶层 assets/ + assets/references/**（逛站采回来的）
  await gather('assets', async () => {
    const a = await readAssetsSummary(workspaceRoot);
    if (a.count > 0) {
      const all = Array.isArray(a.allPaths) ? a.allPaths : [];
      const shown = Array.isArray(a.paths) ? a.paths : [];
      const text = `${a.summary}\n完整路径（直接 Read；Glob/Grep 也能用）：\n${shown.map(p => `- ${p}`).join('\n')}`
        + (a.hasBinaryDocs ? `\n${BINARY_DOC_HINT}` : '');
      sections.push({ key: 'assets', title: '素材', text, items: all, hasBinaryDocs: a.hasBinaryDocs });
    }
  });

  // （spec.json 决策档案注入 2026-08-24 拆除：决策体系退役，长期事实走 CLAUDE.md/记忆）

  // 便利贴：metadata-not-content，只列文件和首行标题
  await gather('notes', async () => {
    const notesDir = path.join(workspaceRoot, 'notes');
    const noteFiles = (await fs.readdir(notesDir)).filter(n => n.endsWith('.md') && !n.startsWith('.'));
    const lines = []; const items = [];
    for (const n of noteFiles.slice(0, 12)) {
      let title = ''; let faces = 0;
      try {
        const raw = await fs.readFile(path.join(notesDir, n), 'utf8');
        title = (raw.match(/^#\s+(.{1,60})/m)?.[1] || '').trim();
        faces = raw.split(/\n---\n/).length;
      } catch { /* 列出文件名就够 */ }
      const meta = [title, faces > 1 ? `${faces} 面` : ''].filter(Boolean).join(' · ');
      lines.push(`  notes/${n}${meta ? `（${meta}）` : ''}`);
      items.push(`notes/${n}`);
    }
    if (lines.length) sections.push({ key: 'notes', title: '便利贴', text: `便利贴（和用户共享，他看得到也可能改过；细节 Read）：\n${lines.join('\n')}`, items });
  });

  // 用户视点（2026-08-23 黑板）：一行，只在变化时进注入（renderTurnState 按 hash 判）。
  // 视口矩形按 1/8 视口量化再进 hash，不然相机挪一像素就算"变了"。
  await gather('viewpoint', async () => {
    const vp = getViewpoint(projectId);
    if (vp) {
      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      const rects = Object.entries(board.objects || {})
        .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === (vp.layer || ''))
        .map(([id, e]) => ({ id, x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
      const q = vp.camera ? { ...vp, camera: {
        x: Math.round(vp.camera.x / Math.max(1, vp.camera.w / 8)) * Math.round(vp.camera.w / 8),
        y: Math.round(vp.camera.y / Math.max(1, vp.camera.h / 8)) * Math.round(vp.camera.h / 8),
        w: vp.camera.w, h: vp.camera.h,
      } } : vp;
      const line = describeViewpoint(q, rects);
      if (line) sections.push({ key: 'viewpoint', title: '用户视点', text: `用户此刻在画布上：${line}。他说「这个/这里/这张」多半指选中的 > 开着的窗 > 视口里的东西；要细节调 read_user_view。` });
    }
  });

  // 画布关系线：用户画的排前面
  await gather('relations', async () => {
    const digest = await relationsDigest(projectId, { limit: 12 });
    if (digest) {
      sections.push({ key: 'relations', title: '画布关系线', text: `画布关系线（用户和你手动画的连线，端点跟着改名走；语义看线上的词）：\n${digest}\n  产出新东西后记得用 relate_on_board 把「改自/对照/接着/取材」画上去。` });
    }
  });

  // 产物清单：按形态报（deck 报页数，站点报页面清单 + 产物根）
  await gather('artifacts', async () => {
    const artifacts = await listWorkspaceArtifacts(workspaceRoot);
    if (artifacts.length === 0) {
      sections.push({ key: 'artifacts', title: '产物', text: `这个工作区还没有产物 —— 直接在工作区根上写：deck 写 ${ENTRY_FILE[KIND_DECK]}，站点写 ${ENTRY_FILE[KIND_SITE]}。` });
    } else {
      const active = getActiveArtifact(sessionId)?.path || null;
      const lines = [];
      let manifest = null;
      for (const a of artifacts.slice(0, 8)) {
        let note = '';
        try {
          if (!manifest) manifest = await taskManifest(workspaceRoot);
          const art = manifest?.artifacts?.find(x => x.entryRel === a.rel) || null;
          note = art ? await kindDef(art.kind).describe(workspaceRoot, art) : '还判不出形态';
        } catch { note = '读不到'; }
        lines.push(`  ${a.rel}（${note}）${a.rel === active ? '  ← 画布工具默认打这份' : ''}`);
      }
      sections.push({ key: 'artifacts', title: '产物', text: `现有产物：\n${lines.join('\n')}` });
    }
  });

  // 最近板书（2026-08-23；08-24 记忆改版时被误删，同日修回）：你/用户在画布上
  // 说过的最近几句 —— 对话在板上，得记得板上说了什么
  await gather('chalk', async () => {
    const recent = await recentChalk(workspaceRoot, { limit: 8 });
    if (recent.length) {
      const lines = recent.map(c => `  ${c.path}（${c.by === 'user' ? '用户' : '你'}${c.anchor ? `，关于 ${c.anchor}` : ''}${c.replyTo ? `，回应 ${c.replyTo.replace(`${CHALK_DIR}/`, '')}` : ''}）「${c.first}」`);
      sections.push({ key: 'chalk', title: '最近板书', text: `画布上最近的板书（${CHALK_DIR}/，新在前；正文 Read 文件）：\n${lines.join('\n')}`, items: recent.map(c => c.path) });
    }
  });

  // 黑板模式（2026-08-23；08-24 起默认开 —— 没写过这个键的按开算，显式 false 才算关）
  await gather('blackboard', async () => {
    const cfg = withUiDefaults(await readUiConfigFile(workspaceRoot));
    if (cfg.blackboard_mode === true) {
      sections.push({ key: 'blackboard', title: '黑板模式', text:
        '【黑板模式：开】用户此刻在画布上专注思考。这一轮默认这么做：想事情就画成图（sketch_on_board，'
        + '小改动用 edit_sketch 原地改别重画）；做完一件东西在它旁边写一条板书（write_on_board near=）；'
        + '用户标注了板上的东西就接在那条下面回（reply_to=）。侧栏照常回复，但板上已经写的别大段重复。'
        + '尺寸守规范（0.8 倍一屏可读、正文 md 起、一条板书说一件事）；画完 look_at_board 看一眼再收。' });
    }
  });

  // （tweaks 开关注入 2026-08-24 随 expose_tweaks 暂退役一起摘除；工具升级后再回来）

  return sections;
}

/**
 * 把各节渲染成这一轮的注入文本（纯函数，可单测）。
 * @param {Array} sections  collectSections 的结果
 * @param {Map|null} prev   上一轮记忆（null = 首轮）
 * @returns {{ text: string|null, next: Map }}
 */
export function renderTurnState(sections, prev) {
  const next = new Map();
  for (const s of sections) next.set(s.key, { hash: fingerprint(s.text), items: s.items ? [...s.items] : null, hasBinaryDocs: !!s.hasBinaryDocs });
  if (!sections.length) return { text: null, next };

  if (!prev) {
    const body = sections.map(s => s.text).join('\n\n');
    return { text: `[NoDesign 工作台自动注入的当前状态]\n\n${body}\n\n请基于这些信息处理用户的请求。`, next };
  }

  const changed = []; const unchanged = []; const gone = [];
  for (const s of sections) {
    const p = prev.get(s.key);
    if (!p) { changed.push(`（新出现）${s.text}`); continue; }
    if (p.hash === next.get(s.key).hash) { unchanged.push(s.title); continue; }
    if (s.items && p.items) {
      const d = diffItems(p.items, s.items);
      const bits = [];
      if (d.added.length) bits.push(`新增 ${d.added.length}：${d.added.slice(0, 8).join('、')}${d.added.length > 8 ? ' 等' : ''}`);
      if (d.removed.length) bits.push(`移除 ${d.removed.length}：${d.removed.slice(0, 8).join('、')}${d.removed.length > 8 ? ' 等' : ''}`);
      if (bits.length) {
        let line = `${s.title}（有变化）：${bits.join('；')}（现共 ${s.items.length} 件）`;
        if (s.hasBinaryDocs && !p.hasBinaryDocs) line += `\n${BINARY_DOC_HINT}`;
        changed.push(line);
        continue;
      }
    }
    changed.push(`（有变化）${s.text}`);
  }
  for (const [key] of prev) if (!next.has(key)) gone.push(key);
  const lines = [];
  if (changed.length) lines.push(...changed);
  if (gone.length) lines.push(`（已不存在：${gone.join('、')}）`);
  if (!changed.length && !gone.length) {
    return { text: `[工作台状态：与上轮相同（${unchanged.join('、')}）]`, next };
  }
  lines.push(`未变：${unchanged.join('、') || '（无）'}`);
  return { text: `[工作台状态 · 只报变化]\n\n${lines.join('\n\n')}`, next };
}

/**
 * 装配这一轮的动态状态块（session-loop runTurn 在 client.prompt 前调）。
 *
 * 采集 8 节（cwd/assets/notes/viewpoint/relations/artifacts/chalk/blackboard）
 * + 首轮全量 / 之后指纹 diff，包 `<system>…</system>`（对齐 turn-compose 原
 * pendingSummary 块的约定）。
 *
 * @param {{ sessionId: string, workspaceRoot: string, projectId?: string }} opts
 * @returns {Promise<string|null>} 状态块文本；无内容（或没给 workspaceRoot）返 null
 */
export async function assembleTurnContext({ sessionId, workspaceRoot, projectId } = {}) {
  if (!workspaceRoot) return null;
  try {
    const sections = await collectSections({ workspaceRoot, sessionId, projectId });
    const prev = getTurnMemory(sessionId)?.sections || null;
    const { text, next } = renderTurnState(sections, prev);
    setTurnMemory(sessionId, next);
    if (!text) return null;
    return `<system>${text}</system>`;
  } catch (err) {
    // 单节异常已在 collectSections 内跳过；这里是整体兜底 —— 状态块丢了 turn 照跑
    console.warn('[turn-state] assembleTurnContext failed:', err.message);
    return null;
  }
}

/** compaction 后 / 想强制下一轮全量时调（session-loop 在 compaction_end 事件调） */
export function resetTurnStateMemory(sessionId) {
  if (sessionId) memory.delete(sessionId);
}
