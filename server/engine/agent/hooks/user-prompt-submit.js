/**
 * UserPromptSubmit handler — 每次用户输入前自动注入 spec.json 决策摘要 +
 * canvas.html 当前页数到 additionalContext。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 *
 * 为什么要 hook 注入而不是让 agent 自己 Read：
 *   - SKILL.md 引导是软约束，agent 偶尔会忘
 *   - hook 注入 = SDK 硬保证，每个 turn 都有
 *   - 成本：hook 内 fs 读 2 个文件（< 200KB），单次 turn 增加 ~10-50ms。
 *     spec.json 摘要 +canvas 页数本来 agent 就要 Read，hook 提前喂效率更高
 *
 * input: UserPromptSubmitHookInput (sdk.d.ts:5475)
 *   - prompt: string                  用户原文
 *   - session_title?: string
 *
 * output: UserPromptSubmitHookSpecificOutput (sdk.d.ts:5481)
 *   - additionalContext?: string      注入后续 prompt（标记成 system 提示）
 *   - sessionTitle?: string           覆盖 session 标题（不用）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readUiConfigFile } from '../../../projects/ui-config.js';
import { relationsDigest } from '../../../lib/board-relations.js';
import {
  getActiveArtifact, listWorkspaceArtifacts, taskManifest, kindDef,
  KIND_DECK, KIND_SITE, ENTRY_FILE,
} from '../../../lib/artifact-target.js';

/** UserPromptSubmit hook 读取 spec.json 时的最大字节数 */
const SPEC_JSON_MAX_BYTES = 200 * 1024;
/** spec.json.decisions 注入摘要时取最近 N 条 */
const SPEC_DECISIONS_TAIL = 5;

export function makeUserPromptSubmitHandler({ ctx, workspaceRoot, sessionId, projectId }) {
  return async (_input, _toolUseId, _options) => {
    try {
      if (!workspaceRoot) return {};

      const parts = [];

      // 0. cwd + 关键路径常量（用户报告"agent 总找错路径"的根治）
      // 每个 turn 都注入让 agent 不必凭记忆推路径，看一眼 hook 提示就有
      // canonical 答案。especially: agent-memory 路径以前 prompt 0 提及，
      // agent 写品牌档案常写错位置（./brand.md / ./memory.md 等）→ BrandCard 读不到
      parts.push(
        `你的 cwd 是 ${workspaceRoot} —— 这是**项目工作区**，产物直接住这儿。\n`
        + `关键路径（用 ./ 相对路径访问，全是真目录，没有软链）：\n`
        + `  ./                         产出的家。deck → <名>.html（每个 .html 一份；用 mcp__nodesign__read_page 切片读，别 Read 全文件）；站点 → <站名>/index.html + 子页（住自己的文件夹，样式怎么拆你定）\n`
        + `  ./notes/                   便利贴（.md，\\n---\\n 分面）——和用户共享的头脑风暴层，桌面上渲成可翻页贴纸\n`
        + `  ./assets/                  用户上传素材 + 你 curl 下载的资源\n`
        + `  ./.claude/agent-memory/    跨项目长期记忆\n`
        + `    ├── memory.md            main agent 通用 memory（前端 MemoryCard 读这条）\n`
        + `    └── brand/memory.md      风格档案（前端 BrandCard 读这条；写风格信息一定走这个完整路径）`,
      );

      // 1. spec.json：取最近 N 条 decisions 拼摘要
      try {
        const specPath = path.join(workspaceRoot, 'spec.json');
        const stat = await fs.stat(specPath);
        if (stat.size <= SPEC_JSON_MAX_BYTES) {
          const raw = await fs.readFile(specPath, 'utf8');
          const spec = JSON.parse(raw);
          const decisions = Array.isArray(spec?.decisions) ? spec.decisions : [];
          if (decisions.length > 0) {
            const recent = decisions.slice(-SPEC_DECISIONS_TAIL);
            const lines = recent.map((d, i) => {
              const idx = decisions.length - recent.length + i + 1;
              const title = (d?.title || '(无标题)').slice(0, 80);
              const rationale = (d?.rationale || '').slice(0, 200);
              return `  ${idx}. ${title}${rationale ? ` — ${rationale}` : ''}`;
            }).join('\n');
            parts.push(
              `旧决策档案（spec.json 遗产，共 ${decisions.length} 条，最近 ${recent.length} 条；新决策一律走 record_decision → 任务便利贴）：\n${lines}`,
            );
          }
        }
      } catch {
        // spec.json 不存在 / 解析失败 / stat 失败：noop
      }

      // 1.5 便利贴清单（2026-07-30）：notes/*.md —— 决策 + 头脑风暴的共享层。
      // metadata-not-content：只列文件和每张贴的首行标题，细节 agent 自己 Read
      try {
        const notesDir = path.join(workspaceRoot, 'notes');
        const noteFiles = (await fs.readdir(notesDir))
          .filter(n => n.endsWith('.md') && !n.startsWith('.'));
        const lines = [];
        for (const n of noteFiles.slice(0, 12)) {
          let title = '';
          let faces = 0;
          try {
            const raw = await fs.readFile(path.join(notesDir, n), 'utf8');
            title = (raw.match(/^#\s+(.{1,60})/m)?.[1] || '').trim();
            faces = raw.split(/\n---\n/).length;
          } catch { /* 列出文件名就够 */ }
          const meta = [title, faces > 1 ? `${faces} 面` : ''].filter(Boolean).join(' · ');
          lines.push(`  notes/${n}${meta ? `（${meta}）` : ''}`);
        }
        if (lines.length > 0) {
          parts.push(`便利贴（和用户共享，他看得到也可能改过；细节 Read）：\n${lines.join('\n')}`);
        }
      } catch {
        // notes/ 不存在：noop
      }

      // 1.7 画布关系线摘要（2026-08-14 切片③）：用户/你在画布上画的连线。
      // 用户画的排前面 —— 他专门画的线就是他想让你知道的事。手写字端点直接
      // 带内容（标注全局化的关键一步）。没有线 = 沉默不占 prompt。
      try {
        const digest = await relationsDigest(projectId, { limit: 12 });
        if (digest) {
          parts.push(
            `画布关系线（用户和你手动画的连线，端点跟着改名走；语义看线上的词）：\n${digest}\n`
            + `  产出新东西后记得用 relate_on_board 把「改自/对照/接着/取材」画上去。`,
          );
        }
      } catch { /* 板读不到就沉默 */ }

      // 2. 现有产物清单（2026-07-28：任务模型下产物住 tasks/<任务>/，这里以前只看
      //    cwd/canvas.html —— 于是每一轮都在说"还不存在，这可能是首跑"，手上明明有
      //    一份七页的 deck。同日加站点后又要按形态报不同的东西：deck 报页数，
      //    站点报页面清单，报错了等于每轮对 agent 撒一次谎。）
      try {
        const artifacts = await listWorkspaceArtifacts(workspaceRoot);
        if (artifacts.length === 0) {
          parts.push(
            '这个工作区还没有产物 —— 直接在工作区根上写：'
            + `deck 写 ${ENTRY_FILE[KIND_DECK]}，站点写 ${ENTRY_FILE[KIND_SITE]}。`,
          );
        } else {
          const active = getActiveArtifact(sessionId)?.path || null;
          const lines = [];
          // 一个工作区一份 manifest，八个产物共用（原来是"同任务多产物"缓存）
          let manifest = null;
          for (const a of artifacts.slice(0, 8)) {
            let note = '';
            try {
              // 形态说明由注册表出（每个产物一行：deck 报页数，站点报页面清单+产物根）
              if (!manifest) manifest = await taskManifest(workspaceRoot);
              const art = manifest?.artifacts?.find(x => x.entryRel === a.rel) || null;
              note = art ? await kindDef(art.kind).describe(workspaceRoot, art) : '还判不出形态';
            } catch { note = '读不到'; }
            lines.push(`  ${a.rel}（${note}）${a.rel === active ? '  ← 画布工具默认打这份' : ''}`);
          }
          parts.push(`现有产物：\n${lines.join('\n')}`);
        }
      } catch {
        // 扫不动就不说，别拿错信息误导
      }

      // 3. design-plan.md：仅检查存在性，不读内容
      // 设计原则 metadata-not-content：给 agent "地图"不给"答案"，保留主动 Read 的判断力
      // 避免"被注入摘要后反而不主动读"的反模式
      try {
        const planPath = path.join(workspaceRoot, 'design-plan.md');
        await fs.access(planPath);
        parts.push(
          'design-plan.md 已存在（plan mode 产出的故事弧）。涉及编辑 / 生成时建议先 Read 对应页 c_decisions（reference / opposition / constraint / motion），对照主线再下笔；改动跟主线方向不一致时跟用户点一下再动。',
        );
      } catch {
        // design-plan.md 不存在：noop
      }

      // 4. ui-config.json（#25 从 session-config.json 改名，读取带旧名回落，
      // 详见 projects/ui-config.js）：tweaks_mode_enabled 注入对应行为提示。
      // 用户在 toolbar Tweaks toggle 控制；ON / OFF 对应不同的 agent 行为。
      // **文件不存在（用户从没碰过 toggle）= 沉默不注入** —— 这条语义靠
      // readUiConfigFile 返回 null 表达，别用带默认值的读法糊掉它。
      try {
        const cfg = await readUiConfigFile(workspaceRoot);
        if (cfg) {
          const tweaksEnabled = cfg?.tweaks_mode_enabled !== false;
          if (tweaksEnabled) {
            parts.push(
              '【Tweaks 模式：启用】用户偏好"可调产品"——deck 形态稳定后，建议调 expose_tweaks 暴露核心微调参数（颜色 / 字号 / 排版密度等）让用户拖滑杆即时改样式，这是 NoDesign 的差异化价值。',
            );
          } else {
            parts.push(
              '【Tweaks 模式：禁用】用户在 toolbar 关闭了 Tweaks——这次跳过 expose_tweaks，按对话方式让用户提需求你来 Edit。已暴露的 controls 保留不动，不新增 / 不重 expose。',
            );
          }
        }
      } catch {
        // 读失败：默认行为（启用），不注入
      }

      if (parts.length === 0) return {};

      const additionalContext = `[NoDesign 工作台自动注入的当前状态]\n\n${parts.join('\n\n')}\n\n请基于这些信息处理用户的请求。`;

      // 不 emit 业务事件 —— additionalContext 注入是私域提示，不需要前端展示
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      };
    } catch (err) {
      console.warn(`[hooks/UserPromptSubmit] handler threw:`, err.message);
      return {};
    }
  };
}
