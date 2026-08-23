/**
 * UserPromptSubmit handler — 每次用户输入前注入工作区**状态**（2026-08-21 重做）
 *
 * 注的是状态不是指令：cwd、素材清单、旧决策、便利贴、画布关系线、产物清单、tweaks 开关。
 * 怎么用这些东西（路径表、"先看有没有现成的素材"、工具怎么选）住 prelude，那是缓存的
 * system prompt；每轮再说一遍是上下文里的 N 倍重复。
 *
 * ## 首轮全量，之后只报变化
 *
 * 以前每轮全量（实测 540~1300 token/轮），30 轮下来对话历史里是十几份几乎相同的块。
 * 现在每节算指纹记在 turn-state-memory.js（按 sessionId）：
 *   - 首轮（或压缩后 / 进程重启后）：全量 + 结尾"请基于这些信息处理用户的请求"
 *   - 之后：变了的节全文（标「有变化」），素材/便利贴这种清单只报新增/移除；没变的节
 *     只在末尾一行点名"未变：…"（让模型知道它们还在，但不重复内容）；一节都没变就一句话
 *
 * ## 素材块从 turn-compose 搬过来（同日）
 *
 * 以前 assets 摘要是 turn-compose 拼进**用户消息**里的 <system> 块，跟这里的状态块是
 * 两条线两个真相源；而且那块写着"assets/ 是 symlink 别用 Glob"—— 08-07 扁平化后早就是
 * 真目录了。现在合成这一条线，symlink 那句删掉。
 *
 * input: UserPromptSubmitHookInput — output: { hookSpecificOutput: { additionalContext } }
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readUiConfigFile } from '../../../projects/ui-config.js';
import { readAssetsSummary } from '../../../projects/assets-summary.js';
import { relationsDigest } from '../../../lib/board-relations.js';
import { getViewpoint, describeViewpoint } from '../../../projects/viewpoint-store.js';
import { readBoard } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf } from '../../../lib/canvas-id.js';
import {
  getActiveArtifact, listWorkspaceArtifacts, taskManifest, kindDef,
  KIND_DECK, KIND_SITE, ENTRY_FILE,
} from '../../../lib/artifact-target.js';
import { getTurnMemory, setTurnMemory, fingerprint, diffItems } from './turn-state-memory.js';

/** UserPromptSubmit hook 读取 spec.json 时的最大字节数 */
const SPEC_JSON_MAX_BYTES = 200 * 1024;
/** spec.json.decisions 注入摘要时取最近 N 条 */
const SPEC_DECISIONS_TAIL = 5;

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
 */
async function collectSections({ workspaceRoot, sessionId, projectId }) {
  const sections = [];

  // cwd：唯一真正动态的一行。路径表（./ notes/ assets/ .claude/agent-memory/ 各是什么）在 prelude
  sections.push({ key: 'cwd', title: '工作区', text: `你的 cwd 是 ${workspaceRoot} —— 项目工作区，产物直接住这儿（路径表见 prelude「你跑在哪」）。` });

  // 素材：顶层 assets/ + assets/references/**（逛站采回来的）
  try {
    const a = await readAssetsSummary(workspaceRoot);
    if (a.count > 0) {
      const all = Array.isArray(a.allPaths) ? a.allPaths : [];
      const shown = Array.isArray(a.paths) ? a.paths : [];
      const text = `${a.summary}\n完整路径（直接 Read；Glob/Grep 也能用）：\n${shown.map(p => `- ${p}`).join('\n')}`
        + (a.hasBinaryDocs ? `\n${BINARY_DOC_HINT}` : '');
      sections.push({ key: 'assets', title: '素材', text, items: all, hasBinaryDocs: a.hasBinaryDocs });
    }
  } catch { /* 素材读不到就沉默 */ }

  // spec.json 遗产决策：取最近 N 条
  try {
    const specPath = path.join(workspaceRoot, 'spec.json');
    const stat = await fs.stat(specPath);
    if (stat.size <= SPEC_JSON_MAX_BYTES) {
      const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
      const decisions = Array.isArray(spec?.decisions) ? spec.decisions : [];
      if (decisions.length > 0) {
        const recent = decisions.slice(-SPEC_DECISIONS_TAIL);
        const lines = recent.map((d, i) => {
          const idx = decisions.length - recent.length + i + 1;
          const title = (d?.title || '(无标题)').slice(0, 80);
          const rationale = (d?.rationale || '').slice(0, 200);
          return `  ${idx}. ${title}${rationale ? ` — ${rationale}` : ''}`;
        }).join('\n');
        sections.push({ key: 'decisions', title: '旧决策档案', text: `旧决策档案（spec.json 遗产，共 ${decisions.length} 条，最近 ${recent.length} 条；新决策一律走 record_decision → 任务便利贴）：\n${lines}` });
      }
    }
  } catch { /* spec.json 不存在 / 解析失败：noop */ }

  // 便利贴：metadata-not-content，只列文件和首行标题
  try {
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
  } catch { /* notes/ 不存在：noop */ }

  // 画布关系线：用户画的排前面
  // 用户视点（2026-08-23 黑板）：一行，只在变化时进注入（renderTurnState 按 hash 判）。
  // 视口矩形按 1/8 视口量化再进 hash，不然相机挪一像素就算"变了"。
  try {
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
  } catch { /* 视点读不到就沉默 */ }
  try {
    const digest = await relationsDigest(projectId, { limit: 12 });
    if (digest) {
      sections.push({ key: 'relations', title: '画布关系线', text: `画布关系线（用户和你手动画的连线，端点跟着改名走；语义看线上的词）：\n${digest}\n  产出新东西后记得用 relate_on_board 把「改自/对照/接着/取材」画上去。` });
    }
  } catch { /* 板读不到就沉默 */ }

  // 产物清单：按形态报（deck 报页数，站点报页面清单 + 产物根）
  try {
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
  } catch { /* 扫不动就不说 */ }

  // tweaks 开关：文件不存在 = 用户没碰过 = 沉默
  // 黑板模式（2026-08-23）：用户把画布当主窗口。这一节只在开着时注入，关着不提。
  try {
    const cfg = await readUiConfigFile(workspaceRoot);
    if (cfg?.blackboard_mode === true) {
      sections.push({ key: 'blackboard', title: '黑板模式', text:
        '【黑板模式：开】用户此刻把画布当主窗口，侧栏只是旁白。这一轮的**主体内容必须落在画布上**'
        + '（sketch_on_board 画新图 / edit_sketch 改旧图 / create_on_board 一条便签），聊天里只留 1~2 句：'
        + '指出画了什么、问下一步。思考、对比、列要点、画关系，一律上板；不要把整段分析写在聊天里再"顺便"画一张。'
        + '改动优先用 edit_sketch 原地改（挪/改字/加支/删线），不要擦掉重画。'
        + '尺寸守规范（一张图 0.8 倍一屏可读，正文 md 起）；画完 look_at_board 看一眼再收。' });
    }
  } catch { /* 读失败：不注入 */ }
  try {
    const cfg = await readUiConfigFile(workspaceRoot);
    if (cfg) {
      const on = cfg?.tweaks_mode_enabled !== false;
      sections.push({ key: 'tweaks', title: 'Tweaks 开关', text: on
        ? '【Tweaks 模式：启用】用户偏好"可调产品"——deck 形态稳定后，建议调 expose_tweaks 暴露核心微调参数（颜色 / 字号 / 排版密度等）让用户拖滑杆即时改样式。'
        : '【Tweaks 模式：禁用】用户在 toolbar 关闭了 Tweaks——这次跳过 expose_tweaks，按对话方式让用户提需求你来 Edit。已暴露的 controls 保留不动，不新增 / 不重 expose。' });
    }
  } catch { /* 读失败：默认行为，不注入 */ }

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

export function makeUserPromptSubmitHandler({ ctx: _ctx, workspaceRoot, sessionId, projectId }) {
  return async (_input, _toolUseId, _options) => {
    try {
      if (!workspaceRoot) return {};
      const sections = await collectSections({ workspaceRoot, sessionId, projectId });
      const prev = getTurnMemory(sessionId)?.sections || null;
      const { text, next } = renderTurnState(sections, prev);
      setTurnMemory(sessionId, next);
      if (!text) return {};
      // 不 emit 业务事件 —— additionalContext 注入是私域提示，不需要前端展示
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
    } catch (err) {
      console.warn('[hooks/UserPromptSubmit] handler threw:', err.message);
      return {};
    }
  };
}
