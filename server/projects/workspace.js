/**
 * server/projects/workspace.js — 项目工作区（2026-08-07 扁平化）
 *
 * **一个项目 = 一个工作区 = 一个目录。会话是对话线程，不是文件容器。**
 *
 * 结构：
 *   <PROJECTS_DATA_ROOT>/<projectId>/
 *     ├── shared/                    ← **项目工作区**：agent 的 cwd，产物的家
 *     │   ├── CLAUDE.md              项目档案（指引/风格/习惯；08-24 挪到根，画布可见）
 *     │   ├── 记忆/                   SDK auto-memory（08-24 起，画布可见）
 *     │   ├── .claude/               settings.json · skills/ agents/ · projects/（SDK 转录）
 *     │   ├── assets/                上传素材 + 生成图
 *     │   ├── .nd/<sid>/             会话私档（spec.json / design-plan.md）
 *     │   ├── .git/                  项目历史
 *     │   └── <产物…>                 canvas.html / index.html / notes/ …
 *     └── sessions/                  扁平化前的旧结构，迁移后只剩空壳（不删，留退路）
 *
 * ## 为什么 cwd 是工作区，不是 sessions/<sid>/（2026-08-07 改）
 *
 * 旧模型是三层：项目 → `shared/tasks/<任务>/` → 产物，会话跟任务一对一绑定。
 * 线上 22 个项目的数据说这一层是空的：**13 个项目有任务，每个都恰好 1 个**，
 * 没有任何一个项目有第二个任务。三个名字（项目 / 任务 / 会话）指同一样东西，
 * 而代价是画布上要养一整套工作区几何（分区 / 格子 / 聚焦模式 / 文件夹卡），
 * 落点被吸附到 244×210 的格子上 —— 用户能感觉到的就是"拖了不跟手"。
 *
 * 所以任务这一层整个退役。产物直接住工作区根，会话只剩"对话线程"这一个含义。
 *
 * 顺带解决的：cwd 就是工作区之后，`tasks/` `assets/` `skills/` `agents/`
 * `agent-memory` 五条软链**全部不需要了**。那条写进 prelude 的老坑
 * （"Glob/Grep 不跟软链，对 assets/* 返回空"）跟着一起消失。
 *
 * ⚠️ 目录名仍叫 `shared/`：改名要动 22 个项目的磁盘路径，换不来任何功能。
 * 它现在的含义是"**被所有会话共享的那个工作区**"，字面上依然成立。
 *
 * 边界：
 *   - validateProjectId / validateSessionId 防 traversal
 *   - git ops 走 child_process spawn（不开 shell，args 不被 shell 解释）
 */

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { mutex } from 'async-mutex-lite';
import { validateProjectId } from './store.js';
import { resolveModelContextWindow } from '../engine/agent/model-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Per-sessionRoot read-modify-write 串行 utility（spec.json）。
 * 08-24 起唯一写入方 = 暂退役的 expose_tweaks（决策贴/PostCompact 摘要已拆）；
 * 锁留着 —— tweaks 升级回归时并发结构不变。
 *
 * @param {string} workspaceRoot - sessions/<sid>/ 路径
 * @param {(spec: object) => (object|void|Promise<object|void>)} mutator
 *        接收已 parse 的 spec object（不存在 / 解析失败时是 {}），同步或异步 mutate；
 *        return 的 object 当新 spec 写回（或 mutate 原 object 不 return 也行）。
 * @returns {Promise<object>} 写入后的 spec
 */
export async function mutateSpecJson(workspaceRoot, mutator) {
  return mutex(`spec:${workspaceRoot}`, async () => {
    const specPath = path.join(workspaceRoot, 'spec.json');
    let spec = {};
    try {
      const raw = await fs.readFile(specPath, 'utf8');
      spec = JSON.parse(raw);
      if (!spec || typeof spec !== 'object') spec = {};
    } catch { /* file not exist / parse error → fresh */ }
    const next = (await mutator(spec)) || spec;
    await fs.writeFile(specPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  });
}

export const PROJECTS_DATA_ROOT = path.resolve(
  process.env.PROJECTS_DATA_DIR || path.join(__dirname, '../projects-data'),
);

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SDK sessionId 必须 UUID 格式（防路径 traversal） */
export function validateSessionId(sid) {
  if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) {
    throw Object.assign(new Error(`非法 sessionId: ${JSON.stringify(sid)}`), { code: 'INVALID_SESSION_ID' });
  }
}

import {
  DEFAULT_GITIGNORE, DEFAULT_CLAUDE_MD,
} from './workspace-templates.js';
import { migrateMemoryLayout } from './memory-migration.js';
import { flattenWorkspace } from './workspace-flatten.js';

/**
 * NoDesign 全局默认 settings.json — 代码是 source of truth。
 *
 * 每次 ensureProjectWorkspace 都会跟 shared/.claude/settings.json merge
 * （existing 字段优先，新增 default 字段补上）。这样升级现存 project 不需要
 * 用户手动改文件。
 *
 * autoCompactEnabled / autoCompactWindow：
 *   2026-05-01 加 — Kimi gateway 上下文上限 256k（262144 tokens）。当前默认
 *   模型 kimi-k2.6 一旦 prompt 累积超 256k → gateway 直接 400 报错（用户实测
 *   request id 20260501104913995449543DV62Dl5F：requested 418547 tokens）。
 *   按 256k × 90% = 230400 tokens 触发自动 compact，SDK 用同模型压缩对话历史。
 *   PostCompact hook（hooks.js:84）已就位，compact 后摘要写 spec.json 长期记忆。
 *
 *   ⚠️ 历史坑（2026-05-08 修）：SDK binary 内部 model registry 不识别 kimi-*，
 *   rawMaxTokens fallback 到 Anthropic 标准 200000，链式后果 maxTokens
 *   = min(autoCompactWindow=230400, rawMaxTokens=200000) = 200000，
 *   autoCompactWindow=230400 永远被卡 200k，浪费 60k+ Kimi gateway 真实容量。
 *   修法：engine/agent/model-context.js 把 sdkOptions.model spoofing 成
 *   `claude-opus-4-7[1m]`（SDK 认 1M context），rawMaxTokens=1M 不再卡 230400；
 *   binary-fixup-proxy 在出口把 model 还原成真 kimi-k2.6 给 gateway。
 *   现在 230400 真生效，SDK auto-compact 在 230k 触发，留 26k margin 防 400。
 *
 *   2026-07-27 起不再写死 230400：按 NODESIGN_MODEL 真实窗口 × 0.9 计算。
 *   sonnet-5[1m] → 900000（SDK 在此再扣内部 reserve，实际 compact 触发 ~86w）；
 *   kimi-k2.6 → 230400（原值，256000 × 0.9）；未知模型兜底 200000 × 0.9。
 *   SDK 接受 1e5 ~ 1e6 区间。切回 kimi 只需改 env 重启，默认值自动跟随。
 *   旧项目 settings.json 里遗留的 230400 视为 stale default 强制迁移
 *  （mergeSettingsDefaults 内特判），用户手改过的其他值不动。
 */
const MAIN_MODEL = process.env.NODESIGN_MODEL || null;   // M1.5：去订阅行兜底（同 session-model.js fail-loud 口径）。未设 → resolveModelContextWindow 返 null → 下面 ?? 200_000 兜底
const LEGACY_DEFAULT_WINDOWS = new Set([230400]);

function defaultAutoCompactWindow() {
  const realWindow = resolveModelContextWindow(MAIN_MODEL) ?? 200_000;
  return Math.min(Math.round(realWindow * 0.9), 1_000_000);
}

const DEFAULT_NODESIGN_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  autoCompactEnabled: true,
  autoCompactWindow: defaultAutoCompactWindow(),
};

/**
 * Merge NoDesign defaults 到现存 settings.json（existing 字段优先）。
 * 文件不存在时直接落 defaults。
 *
 * @returns {Promise<boolean>} 是否有改动（true = 写入了，false = 完全相同跳过）
 */
async function mergeSettingsDefaults(settingsPath) {
  let existing = {};
  if (await fileExists(settingsPath)) {
    try {
      existing = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    } catch (err) {
      // 损坏的 JSON：保留备份后用 defaults 覆盖
      const backup = settingsPath + `.broken-${Date.now()}`;
      await fs.rename(settingsPath, backup).catch(() => {});
      console.warn(`[workspace] settings.json parse failed, backed up to ${backup}`);
      existing = {};
    }
  }
  const merged = { ...DEFAULT_NODESIGN_SETTINGS, ...existing };
  // stale default 迁移：旧代码把 230400 写进过所有项目的 settings.json，
  // existing 优先的 merge 规则会让新默认值永远进不去 —— 命中旧默认值时视为
  // "非用户自定义"，跟随当前默认。用户改成其他数字则尊重不动。
  if (
    LEGACY_DEFAULT_WINDOWS.has(existing.autoCompactWindow) &&
    existing.autoCompactWindow !== DEFAULT_NODESIGN_SETTINGS.autoCompactWindow
  ) {
    merged.autoCompactWindow = DEFAULT_NODESIGN_SETTINGS.autoCompactWindow;
  }
  // 旧 _comment 字段不再写默认（曾经的 placeholder），用户自定义保留
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return false;
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return true;
}

// ── 路径 helpers ──

/** 项目数据目录（容器：里面装 shared/ 和迁移前遗留的 sessions/） */
export function getProjectWorkspace(projectId) {
  validateProjectId(projectId);
  return path.join(PROJECTS_DATA_ROOT, projectId);
}

/**
 * **项目工作区根** —— agent 的 cwd，产物的家，画布上看到的一切的真相。
 *
 * 这是扁平化之后唯一有意义的"工作目录"概念。旧名 `getSharedDir` 继续可用
 * （40+ 处调用，含义没变）。
 */
export function getWorkspaceRoot(projectId) {
  return path.join(getProjectWorkspace(projectId), 'shared');
}

/** 旧名，等价于 getWorkspaceRoot */
export const getSharedDir = getWorkspaceRoot;

/**
 * 会话工作目录 = 项目工作区。**sessionId 只用来校验，不参与路径**。
 *
 * 保留这个名字是因为它是 SDK 侧 `cwd` 的取值口（转录目录 encodeCwdForSDK(cwd)
 * 从它算），28 处调用全都是"给这个会话一个 cwd"的意思 —— 现在这个答案对每个
 * 会话都一样，那正是"产物与 session 脱钩"。
 */
export function getSessionWorkspace(projectId, sessionId) {
  validateSessionId(sessionId);
  return getWorkspaceRoot(projectId);
}

/**
 * 会话私档目录（`<工作区>/.nd/<sid>/`）：spec.json（压缩摘要）、design-plan.md。
 *
 * 这些属于**对话**不属于产物，所以既不上画布也不进 git，但必须留在 cwd 内 ——
 * 放 cwd 外就得靠 additionalDirectories + 绝对路径，而 agent 看不见仓库路径。
 */
export function getSessionMetaDir(projectId, sessionId) {
  validateSessionId(sessionId);
  return path.join(getWorkspaceRoot(projectId), '.nd', sessionId);
}

// ── ensure ──

/**
 * 创建项目工作区（幂等）。完成后保证：
 *   - .claude/{CLAUDE.md, settings.json} 模板写入（仅不存在时）
 *   - .claude/{skills, agents, agent-memory} 目录存在
 *   - assets/ 存在、.gitignore 写入
 *   - 旧的三层结构（tasks/ + per-session 沙盒）已扁平化
 *   - .git 存在（项目级历史；扁平化前是 per-session 的）
 *
 * 扁平化跟着 ensure 走而不是单独一次性脚本：跟 removeRootLegacyArtifacts 同一个
 * 范式 —— 幂等、按项目惰性触发、跑过一次之后是 no-op。这样线上不需要停机窗口，
 * 也不存在"迁移脚本漏了哪个项目"。
 */
export async function ensureProjectWorkspace(projectId) {
  await removeRootLegacyArtifacts(projectId);

  const root = getWorkspaceRoot(projectId);
  await fs.mkdir(path.join(root, '.claude', 'skills'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude', 'agent-memory'), { recursive: true });
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });

  // .gitignore 每次比对而不是"不存在才写"：扁平化新增了 .claude/projects/ 和
  // .nd/ 两条，老项目的文件里没有，不补的话 SDK 转录会被 commit 进项目历史。
  await ensureGitignore(path.join(root, '.gitignore'));
  // 记忆体系改版迁移（2026-08-24，幂等：源不在了就什么都不做）——
  // CLAUDE.md 从 .claude/ 挪到工作区根（画布可见，SDK 两处都读、根优先级同级），
  // 老的偏好/风格档案并进去，SDK auto-memory 的存量从 .claude/agent-memory/auto
  // 搬到画布可见的 记忆/。三步全是"搬走后源删除"，跑几遍结果一样。
  await migrateMemoryLayout(root, { fileExists });
  if (!(await fileExists(path.join(root, 'CLAUDE.md')))) {
    await fs.writeFile(path.join(root, 'CLAUDE.md'), DEFAULT_CLAUDE_MD, 'utf8');
  }
  // settings.json：每次 merge defaults 让代码层 default 升级时现存 project 自动跟上
  // （用户字段优先，缺失的 NoDesign default 字段补进去）
  await mergeSettingsDefaults(path.join(root, '.claude', 'settings.json'));

  await flattenWorkspace(projectId, ensureProjectGit);

  // 返回**工作区根**（…/shared），跟 ensureSessionWorkspace 一致（2026-08-13）。
  // 以前返回的是项目目录（shared 的上一层）——两个 ensure 返回值差一层目录，
  // 而 api 层的 rootOf 模式（pending-changes.js 首创）把两者当同一个 sessionRoot
  // 用：sid 走 ensureSessionWorkspace、项目级走这里。不统一的话项目级路由会把
  // pending-changes.json 之类写到 shared 外面，agent（读工作区根）永远看不见。
  // 改这里而不是改每个调用方：全仓只有 rootOf 消费这个返回值，其余 10 处都是
  // 纯 await 副作用。
  return getWorkspaceRoot(projectId);
}

/**
 * .gitignore：保证 DEFAULT_GITIGNORE 里每一条都在，用户自己加的行原样保留。
 * 按行合并而不是整文件覆盖 —— 有人会往里加自己的规则。
 */
async function ensureGitignore(file) {
  let existing = '';
  try { existing = await fs.readFile(file, 'utf8'); } catch { /* 还没有 */ }
  const have = new Set(existing.split('\n').map(l => l.trim()));
  const missing = DEFAULT_GITIGNORE.split('\n').filter(l => l.trim() && !have.has(l.trim()));
  if (!missing.length && existing) return;
  const merged = existing
    ? `${existing.replace(/\n*$/, '\n')}${missing.join('\n')}\n`
    : DEFAULT_GITIGNORE;
  await fs.writeFile(file, merged, 'utf8');
}

/**
 * 备好一个会话能开跑的一切（幂等）。返回**项目工作区根** = 这个会话的 cwd。
 *
 * 扁平化之后这里几乎没事干了，值得记一笔它以前干什么：建 `sessions/<sid>/`
 * 沙盒、拉五条绝对软链（.claude/CLAUDE.md、settings.json、skills、agents、
 * agent-memory、assets、tasks）、init 一个 per-session git。那一整套的存在
 * 理由只有一个 —— **cwd 不是工作区**，所以工作区里的东西得一条条链进来。
 *
 * cwd 就是工作区之后：软链零条（连带 bwrap 目录型软链冲突、Glob 不跟软链两个
 * 老坑一起消失），git 变成项目级一个仓（在 ensureProjectWorkspace 里 init）。
 *
 * @returns {Promise<string>} 项目工作区绝对路径（agent 的 cwd）
 */
export async function ensureSessionWorkspace(projectId, sessionId) {
  await ensureProjectWorkspace(projectId);
  const root = getWorkspaceRoot(projectId);
  // SDK 转录落点。它在 cwd/.claude/projects/<encoded-cwd>/<sid>.jsonl，
  // cwd 收敛成项目工作区之后，一个项目的所有会话转录并排住在同一个目录里
  // （这正是 Claude Code 自己的形状）。
  await fs.mkdir(path.join(root, '.claude', 'projects'), { recursive: true });
  await fs.mkdir(getSessionMetaDir(projectId, sessionId), { recursive: true });
  return root;
}

/**
 * 项目级 git（幂等）。扁平化前这是 per-session 的，
 * 现在一个项目一个仓 —— 产物归项目，历史当然也归项目。
 */
async function ensureProjectGit(root) {
  if (await fileExists(path.join(root, '.git'))) {
    // board.json 2026-08-08 才进 gitignore，而 gitignore 对**已经被跟踪**的
    // 文件不起作用 —— 得显式从索引里摘一次。幂等：没被跟踪时 rm 会失败，吞掉。
    await runGit(root, ['rm', '--cached', '-q', '--ignore-unmatch', 'board.json']).catch(() => {});
    return;
  }
  await runGit(root, ['init', '-q', '-b', 'main']);
  await runGit(root, ['add', '-A']);
  await runGit(root, [
    '-c', 'user.email=nodesign@local',
    '-c', 'user.name=NoDesign',
    'commit', '-q', '--allow-empty', '-m', 'init',
  ]);
}

// ── 扁平化迁移（2026-08-07）整块搬去 workspace-flatten.js（M3b 行数棘轮）──

// ── workspace 主动提醒（C8 SKILL/prelude 改造）──
//
// 给 turn.js composeUserMessage 用 —— 检测 sessionRoot 下 assets/ 软链指向的
// shared/assets/ 是否有内容，有就让 agent 看见 "<system>workspace 里有 N 个文
// 件……" 提示。空目录就不注入，agent 不必每个 turn 都硬 Glob 一遍。
//
// 之前的设计：prelude 强制 agent 首跑前 Glob assets/**/* —— 浪费一次 turn 即便
// 目录是空的。改成 workspace 主动 prepend 提示，把"是否需要看 assets" 这个
// 决策从"agent 必须先做"翻译成"agent 看到提示自己判断"。

// Office / PDF：二进制或 OOXML zip 包，Read 直接看是字节流，需 python 解


// ── 老结构清理（用户决策"删了"）──

/**
 * 检测 project workspace 根有 canvas.html / spec.json / .git / .claude 这些
 * S1 时代的老 artifacts，且 shared/ 不存在 → 这是老结构 → 全删。
 *
 * 运行一次性，每个 project 第一次进入新代码时清理。idempotent。
 */
export async function removeRootLegacyArtifacts(projectId) {
  const root = getProjectWorkspace(projectId);
  if (!(await fileExists(root))) return;
  if (await fileExists(path.join(root, 'shared'))) return;

  // 只有当老 artifacts 至少一个存在时，认定是老 project
  const legacyTargets = ['canvas.html', 'spec.json', '.git', '.gitignore', '.claude', 'assets'];
  let hadLegacy = false;
  for (const name of legacyTargets) {
    if (await fileExists(path.join(root, name))) { hadLegacy = true; break; }
  }
  if (!hadLegacy) return;

  for (const name of legacyTargets) {
    const p = path.join(root, name);
    if (await fileExists(p)) {
      await fs.rm(p, { recursive: true, force: true });
    }
  }
  console.log(`[workspace] removed legacy root artifacts for ${projectId}`);
}

// ── 删除 ──

export async function removeProjectWorkspace(projectId) {
  const root = getProjectWorkspace(projectId);
  await fs.rm(root, { recursive: true, force: true });
}

/**
 * 删一个会话留下的东西 —— **只有它的私档**（`.nd/<sid>/`）。
 *
 * ⚠️ 扁平化之前这里是 `rm -rf sessions/<sid>/`，那时候产物住在会话目录里，
 * 所以"删会话"顺带删掉产物是对的。现在产物归项目，删对话不能动产物 ——
 * 这个函数要是照抄旧实现（删 getSessionWorkspace 返回的目录），删的就是
 * **整个项目工作区**。
 */
export async function removeSessionWorkspace(projectId, sessionId) {
  await fs.rm(getSessionMetaDir(projectId, sessionId), { recursive: true, force: true });
}

// ── git ops（per-session）──

/**
 * commit 项目工作区。无改动 silent skip。
 *
 * sessionId 现在只是**记在 commit 信息里的出处**（哪次对话干的），不再决定
 * 提交到哪个仓 —— 一个项目一个仓。两个会话同时收尾也不会打架：mutex 的 key
 * 是工作区路径，本来就串行。
 */
export async function commitWorkspace(projectId, sessionId, message, { author = 'system' } = {}) {
  const sessionRoot = getWorkspaceRoot(projectId);
  if (!(await fileExists(sessionRoot))) return null;
  // git race guard：用户 PUT canvas（DirectEdit 上行）+ agent Edit canvas.html
  // 同时触发会撞 .git/index.lock，最坏 lock 残留导致后续 commit 全卡死。per-sessionRoot
  // mutex 串行所有 git 写操作（commit / revert）。同 sid 共享 key=`git:${sessionRoot}`。
  return mutex(`git:${sessionRoot}`, async () => {
    await runGit(sessionRoot, ['add', '-A']);
    const { stdout } = await runGit(sessionRoot, ['status', '--porcelain'], { capture: true });
    if (!stdout.trim()) return null;
    await runGit(sessionRoot, [
      '-c', `user.email=${author}@nodesign`,
      '-c', `user.name=${author}`,
      'commit', '-q', '-m', message,
    ]);
    const { stdout: hash } = await runGit(sessionRoot, ['rev-parse', 'HEAD'], { capture: true });
    return hash.trim();
  });
}

/**
 * 从某个 commit 到 HEAD 之间，git 认出来的**改名**。
 *
 * 画布物件的 id 就是工作区相对路径，所以 agent 在画布背后 `mv` 一个文件，
 * 画布上那张卡的身份就断了：坐标丢、关系线指向虚空、挂在它上面的批注成孤儿。
 * 而且**清理不掉** —— board.objects 是故意稀疏的（没被摆过的产物压根没有条目），
 * 所以"在 board 里但磁盘上没有"跟"agent 正在写、这一瞬读不到"没法区分，
 * 死 id 只能一直攒着。
 *
 * 靠 git 来认这件事，是因为它已经是这个工作区的历史，而且**自带内容相似度
 * 匹配** —— 一个文件被 mv 的同时改了几行，`-M` 照样认得出来，这是任何
 * 自建的路径比对做不到的。前提是每轮 turn 之后真的落了 commit
 * （2026-08-08 之前只有"用户直接编辑 HTML"那一条路会提交）。
 *
 * @returns {Promise<{ head: string|null, renames: Array<[string,string]> }>}
 */
export async function gitRenamesSince(projectId, fromCommit) {
  const root = getWorkspaceRoot(projectId);
  if (!(await fileExists(path.join(root, '.git')))) return { head: null, renames: [] };
  return mutex(`git:${root}`, async () => {
    let head = null;
    try {
      const { stdout } = await runGit(root, ['rev-parse', 'HEAD'], { capture: true });
      head = stdout.trim();
    } catch { return { head: null, renames: [] }; }
    if (!head || !fromCommit || fromCommit === head) return { head, renames: [] };

    let out = '';
    try {
      // -M50% 比默认宽松些：改名的同时顺手改几行内容是常态（重命名一份 deck
      // 往往连标题一起改）。太严的话这类改名认不出来，退化成"删一个加一个"。
      const r = await runGit(root, [
        'diff', '--name-status', '--find-renames=50%', '-z', fromCommit, head,
      ], { capture: true });
      out = r.stdout;
    } catch { return { head, renames: [] }; }

    // -z 的格式：状态 \0 旧路径 \0 新路径 \0（改名/复制是三段，其余两段）。
    // 用 -z 而不是换行分隔，是因为产物名里有中文和空格，默认输出会加引号转义。
    const parts = out.split('\0');
    const renames = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i];
      if (!st) continue;
      if (st[0] === 'R') { renames.push([parts[i + 1], parts[i + 2]]); i += 2; }
      else i += 1;                       // 其余状态只跟一个路径
    }
    const files = renames.filter(([a, b]) => a && b);
    return { head, renames: [...await deriveFolderRenames(root, files), ...files] };
  });
}

/**
 * 从文件级改名推出**目录改名**。
 *
 * git 只认文件：`mv 稿件 定稿` 报出来是一串
 * `稿件/a.md → 定稿/a.md`、`稿件/b.md → 定稿/b.md`。而画布上的文件夹条目
 * （位置、标题、收起状态）的 id 是 `稿件` —— 没有任何一条文件配对匹配得上它，
 * 于是**机制二能改物件，永远改不了文件夹**。
 *
 * 推法：一对路径去掉最长公共后缀，剩下的头就是目录改名的候选
 * （`稿件/初稿/a.md → 定稿/初稿/a.md` 去掉 `/初稿/a.md` 得 `稿件 → 定稿`，
 * 天然拿到最高一层，正好是 mapId 前缀匹配要的粒度）。
 *
 * 然后**拿磁盘验一遍**才算数：老的确实没了、新的确实在。只有一个文件从
 * A/ 挪进 B/ 也会产生候选，但那时 A/ 还在，验不过。
 *
 * 目录排在文件前面返回：mapId 顺着 renames 的顺序找第一个命中，先按目录前缀
 * 改能一次盖住整棵子树，省得每个文件各改一遍还可能改出中间态。
 */
async function deriveFolderRenames(root, filePairs) {
  const cand = new Map();
  for (const [from, to] of filePairs) {
    const a = from.split('/');
    const b = to.split('/');
    let i = a.length - 1; let j = b.length - 1;
    while (i >= 0 && j >= 0 && a[i] === b[j]) { i -= 1; j -= 1; }
    if (i < 0 || j < 0) continue;                 // 一方是另一方的子路径，不是改名
    const dirA = a.slice(0, i + 1).join('/');
    const dirB = b.slice(0, j + 1).join('/');
    if (dirA && dirB && dirA !== dirB) cand.set(dirA, dirB);
  }
  const out = [];
  for (const [dirA, dirB] of cand) {
    if (await pathExists(path.join(root, dirA))) continue;   // 老的还在 = 没搬走
    if (!(await pathExists(path.join(root, dirB)))) continue; // 新的不在 = 别的事
    out.push([dirA, dirB]);
  }
  // 长的排前面：`稿件/初稿` 要先于 `稿件` 匹配，否则外层一改，内层那条就对不上了
  out.sort((x, y) => y[0].length - x[0].length);
  return out;
}

/**
 * 任务目录自己的 git。
 *
 * 为什么不复用 per-session git：**它根本盖不到任务文件。** git 仓在
 * `sessions/<sid>/.git`，而任务物理上在 `shared/tasks/`，会话里的 `tasks/` 只是
 * 一条软链。git 不跟随软链，`git add -A` 把 `tasks` 存成一个 mode 120000 的软链
 * 对象，任务文件内容从来没进过任何历史。线上实测过：随便挑个会话仓 cat-file，
 * tasks 就是个 120000 blob，且仓里只有一条 init commit。
 *
 * 就算能盖到也不该复用：session 仓的 checkout 会把 spec.json、notes 这些**会话
 * 状态**一起回退，而任务级的回退要的是「这份产物回到几步之前」，粒度不同。
 *
 * 懒初始化：第一次提交时才 init，没人调用就永远不会有 .git。
 *
 * ⚠️ 目前没有调用方（唯一的消费者随 world 形态一起拆了，2026-08-14）。留着是
 * 因为它跟形态无关 —— 下一个需要"按产物回退"的形态直接用，别再造一遍。
 *
 * @returns {Promise<string|null>} commit hash；没有改动返回 null
 */
export async function commitTaskWorkspace(taskDir, message, { author = 'agent' } = {}) {
  if (!(await fileExists(taskDir))) return null;
  return mutex(`git:${taskDir}`, async () => {
    if (!(await fileExists(path.join(taskDir, '.git')))) {
      await runGit(taskDir, ['init', '-q', '-b', 'main']);
    }
    await runGit(taskDir, ['add', '-A']);
    const { stdout } = await runGit(taskDir, ['status', '--porcelain'], { capture: true });
    if (!stdout.trim()) return null;
    await runGit(taskDir, [
      '-c', `user.email=${author}@nodesign`,
      '-c', `user.name=${author}`,
      'commit', '-q', '-m', message,
    ]);
    const { stdout: hash } = await runGit(taskDir, ['rev-parse', 'HEAD'], { capture: true });
    return hash.trim();
  });
}

export async function listHistory(projectId, sessionId, { limit = 50 } = {}) {
  // 同 commitWorkspace：git 仓是项目级一个，sessionId 不参与路径。这里直接取
  // 工作区根而不是走 getSessionWorkspace —— 后者会校验 sid 形状，而项目级路由
  // （2026-08-13 会话收敛）根本不带 sid，undefined 会被它一票否决。
  // sid 存在与否的校验责任在路由层 guard，不在这。
  const sessionRoot = getWorkspaceRoot(projectId);
  if (!(await fileExists(sessionRoot))) return [];
  const { stdout, code } = await runGit(
    sessionRoot,
    ['log', `--max-count=${limit}`, '--pretty=format:%H%x09%cI%x09%an%x09%s'],
    { capture: true },
  );
  if (code !== 0) return [];
  return stdout
    .trim().split('\n').filter(Boolean)
    .map((line) => {
      const [hash, isoDate, gitAuthor, ...msgParts] = line.split('\t');
      return { hash, date: isoDate, author: gitAuthor, message: msgParts.join('\t') };
    });
}

export async function revertWorkspace(projectId, sessionId, commitHash) {
  if (!/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    throw Object.assign(new Error(`invalid commit hash: ${commitHash}`), { code: 'INVALID_COMMIT' });
  }
  // 同 listHistory：项目级一个仓，sessionId 不参与路径也不在这校验
  const sessionRoot = getWorkspaceRoot(projectId);
  // git race guard: 同 commitWorkspace —— checkout + 后续 commit 全 wrap mutex
  // 串行。注意：内层调 commitWorkspace 也会进 mutex，async-mutex-lite 对同 key 同
  // 调用栈会按 prev Promise chain，**不会死锁**（mutex 拿到后释放 prev、await prev
  // 已是 resolved 立即继续）—— 但为简洁还是把 checkout + commit 做成原子段，避免
  // checkout 完别的 commit 抢进来覆盖待 commit 的 staged 状态。
  return mutex(`git:${sessionRoot}`, async () => {
    await runGit(sessionRoot, ['checkout', commitHash, '--', '.']);
    await runGit(sessionRoot, ['add', '-A']);
    const { stdout } = await runGit(sessionRoot, ['status', '--porcelain'], { capture: true });
    if (!stdout.trim()) return null;
    await runGit(sessionRoot, [
      '-c', 'user.email=user@nodesign',
      '-c', 'user.name=user',
      'commit', '-q', '-m', `revert to ${commitHash.slice(0, 7)}`,
    ]);
    const { stdout: hash } = await runGit(sessionRoot, ['rev-parse', 'HEAD'], { capture: true });
    return hash.trim();
  });
}

/**
 * 当前 git HEAD 的 sha（M3c rewind：turn 开始时的树状态锚点）。
 * 无 git 仓 / 无 commit → null（rewind 文件侧不可用，调用方跳过索引）。
 */
export async function getHeadSha(workspaceRoot) {
  try {
    const { code, stdout } = await runGit(workspaceRoot, ['rev-parse', 'HEAD'], { capture: true });
    if (code !== 0) return null;
    return stdout.trim() || null;
  } catch { return null; }
}

/**
 * rewind 文件侧（M3c C4）：精确回到 targetSha 的树状态。
 *
 * 与 revertWorkspace 的区别：revertWorkspace 用 `checkout <hash> -- .` —— pathspec
 * checkout 只更新目标树里存在的路径，目标 commit 之后**新建**的文件不会被删除。
 * rewind 的语义是「当作这轮没发生过」，必须精确回到目标树：checkout 目标树 +
 * `git rm` 掉期间新增的文件 + 新 commit。
 *
 * 为什么不用 `git reset --hard`：reset 直接移 HEAD，丢审计痕迹。checkout + rm +
 * 新 commit 保留完整历史（rewind 本身也是一条可回头的 commit）。
 *
 * 返回 { sha, filesChanged }：sha = 新 commit（无变化时 null）；filesChanged =
 * targetSha→HEAD 的完整变更清单（前端按 length 显示「已回滚 N 个文件」）。
 */
export async function rewindWorkspace(projectId, sessionId, targetSha) {
  if (!/^[a-f0-9]{7,40}$/i.test(targetSha)) {
    throw Object.assign(new Error(`invalid sha: ${targetSha}`), { code: 'INVALID_SHA' });
  }
  // 同 revertWorkspace：项目级一个仓，sessionId 不参与路径；mutex 串行 git 段
  const sessionRoot = getWorkspaceRoot(projectId);
  return mutex(`git:${sessionRoot}`, async () => {
    // 0. 回滚前的完整变更清单（新增+修改+删除），前端 filesChanged.length 用
    const diffRes = await runGit(sessionRoot, ['diff', '--name-only', targetSha, 'HEAD'], { capture: true });
    if (diffRes.code !== 0) {
      throw Object.assign(
        new Error(`git diff ${targetSha} HEAD 失败: ${diffRes.stderr.trim() || `code=${diffRes.code}`}`),
        { code: 'REWIND_FAILED' },
      );
    }
    const filesChanged = diffRes.stdout.trim().split('\n').filter(Boolean);
    // 1. targetSha 之后新增的文件（checkout 不会删它们，需显式 rm）
    const addedRes = await runGit(
      sessionRoot, ['diff', '--name-only', '--diff-filter=A', targetSha, 'HEAD'], { capture: true },
    );
    const addedFiles = addedRes.code === 0 ? addedRes.stdout.trim().split('\n').filter(Boolean) : [];
    // 2. checkout 目标树（恢复已有文件到目标状态，含期间被删的文件）
    await runGit(sessionRoot, ['checkout', targetSha, '--', '.']);
    // 3. 删除新增文件（单个失败不阻断 —— 文件可能已被手动删掉）
    for (const f of addedFiles) {
      await runGit(sessionRoot, ['rm', '-f', '--', f]).catch(() => {});
    }
    // 4. add + commit（无变化 → sha:null，rewind 端点照样回 canRewind:true）
    await runGit(sessionRoot, ['add', '-A']);
    const { stdout: status } = await runGit(sessionRoot, ['status', '--porcelain'], { capture: true });
    if (!status.trim()) return { sha: null, filesChanged: [] };
    await runGit(sessionRoot, [
      '-c', 'user.email=user@nodesign',
      '-c', 'user.name=user',
      'commit', '-q', '-m', `rewind to ${targetSha.slice(0, 7)}`,
    ]);
    const { stdout: hash } = await runGit(sessionRoot, ['rev-parse', 'HEAD'], { capture: true });
    return { sha: hash.trim(), filesChanged };
  });
}

// ── fork ──

/**
 * Fork 一条对话。**不再复制任何文件。**
 *
 * 以前 fork 要 `cp -r sessions/<src> → sessions/<new>`（连 .git 一起，语义是
 * "从这里继续"）。产物归项目之后这件事没有对应物了：两条分叉的对话面对的是
 * 同一个工作区，复制一份产物出来反而会造出两套互不相干的文件。
 *
 * 所以 fork 现在只发生在 SDK 那一侧（复制 jsonl 到新 sid），这里只把新会话的
 * 私档目录备好。
 */
export async function forkSessionWorkspace(projectId, srcSessionId, newSessionId) {
  validateSessionId(srcSessionId);
  validateSessionId(newSessionId);
  const root = getWorkspaceRoot(projectId);
  if (!(await fileExists(root))) {
    throw Object.assign(new Error(`fork source project not found: ${projectId}`), { code: 'SRC_NOT_FOUND' });
  }
  await fs.mkdir(getSessionMetaDir(projectId, newSessionId), { recursive: true });
  return root;
}

// ── helpers ──

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p) {
  // 区分 fileExists 用于"包括软链 dangling"的检查（lstat 不 follow）
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (capture) resolve({ code, stdout, stderr });
      else if (code === 0) resolve({ code });
      else reject(new Error(`git ${args.join(' ')} failed (code=${code})`));
    });
  });
}
