/**
 * server/projects/workspace-flatten.js — 扁平化迁移（2026-08-07）
 *
 * 三层（项目 → 任务 → 产物）扁平成两层（项目 → 产物）的一次性迁移。
 * M3b（2026-08-28）从 workspace.js 整块搬出：行数棘轮（web/src/lib/loc-ratchet.lint.test.js）
 * 钉 workspace.js ≤ 1025，M3c 的 rewindWorkspace 把它顶到 1092；棘轮规则是
 * 「胖了就拆，别抬上限」，这块一次性迁移自成一统（唯一对外依赖是
 * ensureProjectGit），整块搬走最干净。行为一字未改。
 */
import { promises as fs } from 'fs';
import path from 'node:path';
import { mutex } from 'async-mutex-lite';
import { getProjectWorkspace, getWorkspaceRoot } from './workspace.js';

/** 迁移后旧结构改叫这个名字。留着不删 = 出事能退回去，而且给幂等一个干净的信号 */
const PRE_FLATTEN_DIR = 'sessions.pre-flatten';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 真正属于**一次对话**的文件，扁平化后住 `.nd/<sid>/`。
 *
 * 这张表是踩出来的，不是想出来的：第一版只列了 spec.json 和 design-plan.md，
 * 拿真数据跑迁移时逐文件对账才发现另外两个 —— `session-config.json`（这条
 * 会话选的模型）和 `pending-changes.json`（画布上还没交给 agent 的改动）。
 * 这两个要是跟着别的东西一起摊平到工作区根，**两条会话会共用一份**：
 * 一边换模型另一边跟着变，一边的待处理改动被另一边 clear 掉。
 */
const SESSION_PRIVATE_FILES = [
  'spec.json',
  'design-plan.md',
  'session-config.json',
  'pending-changes.json',
];

/**
 * SDK 把 cwd 编码成 `<config>/projects/<encoded>/` —— 非字母数字一律换 '-'。
 * （算法 grep 自 sdk.mjs。）扁平化要搬转录，sessions.js 要按它找 jsonl，
 * 两边必须是同一个函数，所以放在这里当唯一真相。
 */
export function encodeCwdForSDK(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * 三层（项目 → 任务 → 产物）扁平成两层（项目 → 产物）。**幂等**。
 *
 * 跑过之后 `sessions/` 改名成 `sessions.pre-flatten/`，下次进来一次 stat 就返回。
 *
 * 搬七样东西：
 *   1. `tasks/<任务>/*` → 工作区根。**只有一个任务时摊平**（线上 13 个有任务的
 *      项目全是这种），多个任务时各自变成一个顶层文件夹 —— 那样绝不撞名，
 *      html 里的相对引用也原封不动。
 *   2. 任务自己的 `.git`（旧形态留下的）→ 工作区的 `.git`，历史不丢。
 *   3. `.nd-task.json` 删掉：它记的是"这个任务属于哪个会话"，正是要废的那条绑定。
 *   4. `sessions/<sid>/{spec.json, design-plan.md}` → `.nd/<sid>/`。
 *   5. `sessions/<sid>/canvas.html`（旧式单 deck 会话）→ 工作区根。
 *   6. **SDK 转录**：cwd 变了，encoded 目录跟着变，不搬的话每条会话的历史全部
 *      失联。这是整个迁移里唯一不可逆的损失点，所以搬之前先确认目标不存在。
 *   7. `board.json` 的物件 id / 关系线端点重写，zones 整个丢掉。
 *
 * @param {(root: string) => Promise<void>} ensureGit 项目级 git 幂等初始化（workspace.js 的 ensureProjectGit，经参数注入免循环 import）
 * @returns {Promise<boolean>} 这次是否真的迁了（false = 早就迁过了）
 */
export async function flattenWorkspace(projectId, ensureGit) {
  const root = getWorkspaceRoot(projectId);
  const container = getProjectWorkspace(projectId);
  const sessionsDir = path.join(container, 'sessions');
  const tasksDir = path.join(root, 'tasks');

  const hasTasks = await pathExists(tasksDir);
  const hasSessions = await pathExists(sessionsDir);
  if (!hasTasks && !hasSessions) {
    await ensureGit(root);
    return false;
  }

  return mutex(`flatten:${root}`, async () => {
    // 拿到锁再查一遍 —— 等锁那会儿别人可能已经迁完了
    if (!(await pathExists(tasksDir)) && !(await pathExists(sessionsDir))) return false;

    const log = [];
    const renames = new Map();   // 老物件 id → 新物件 id（board.json 用）

    // ① 任务目录上移一层：`tasks/<名>/` → `<名>/`
    //
    // **文件夹一律保留**，哪怕项目里只有一个。2026-08-07 那版在只有一个任务时
    // 会把内容摊平到工作区根（线上 13 个有产物的项目正好都是这种），当时的理由
    // 是「三个名字指同一样东西」。那个判断被推翻了：文件夹要升级成能嵌套、能
    // 自由摆放的一等公民，摊平等于把用户仅有的那个收纳容器也拆了。
    // 去掉的只有 `tasks/` 这一层中间目录，不是文件夹本身。
    if (await pathExists(tasksDir)) {
      const entries = await fs.readdir(tasksDir, { withFileTypes: true });
      const taskNames = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
      for (const name of taskNames) {
        const src = path.join(tasksDir, name);
        const dest = path.join(root, name);
        // 根上已经有同名东西才需要逐条合并；正常情况一次 rename 搞定，
        // 既快又不碰文件内容（撞名走 mergeDir，它会逐字节比对再决定）
        if (await pathExists(dest)) await mergeDir(src, dest, log);
        else await fs.rename(src, dest);
        await retireTaskMarker(dest, log);
        await fixEscapingRelativePaths(dest, log);
        renames.set(`tasks/${name}/`, `${name}/`);
        renames.set(`task/${name}`, name);
      }
      await fs.rm(tasksDir, { recursive: true, force: true });
      log.push(`tasks/ 这一层去掉（${taskNames.length} 个文件夹上移到工作区根）`);
    }
    await retireTaskMarker(root, log);

    // ④ ⑤ ⑥ 会话目录
    if (await pathExists(sessionsDir)) {
      const sids = (await fs.readdir(sessionsDir, { withFileTypes: true }))
        .filter(e => e.isDirectory() && SESSION_ID_RE.test(e.name)).map(e => e.name);
      for (const sid of sids) {
        const sRoot = path.join(sessionsDir, sid);
        const meta = path.join(root, '.nd', sid);
        await fs.mkdir(meta, { recursive: true });
        for (const f of SESSION_PRIVATE_FILES) {
          await moveFile(path.join(sRoot, f), path.join(meta, f), log);
        }
        // 旧式单 deck 会话的产物、以及 skill 拷进 cwd 的起手模板：都归工作区
        for (const f of ['canvas.html', 'canvas.template.html', 'site.template.html', 'style.template.css']) {
          await moveFile(path.join(sRoot, f), path.join(root, f), log);
        }
        // export_handoff 的落点：产物性质，归项目
        if (await pathExists(path.join(sRoot, 'exports'))) {
          await fs.mkdir(path.join(root, 'exports'), { recursive: true });
          await mergeDir(path.join(sRoot, 'exports'), path.join(root, 'exports'), log);
        }
        await moveTranscripts(sRoot, root, sid, log);
      }
      await fs.rename(sessionsDir, path.join(container, PRE_FLATTEN_DIR)).catch(async (err) => {
        if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err;
        // 已经有一份存档（迁移跑到一半重来过）→ 旧的那份留着，这次的丢进去
        await fs.rm(sessionsDir, { recursive: true, force: true });
      });
      log.push(`${sids.length} 个会话的私档与转录已归位`);
    }

    // ⑦ board.json
    await rewriteBoardIds(path.join(root, 'board.json'), renames, log);

    await ensureGit(root);
    console.log(`[flatten] ${projectId}\n  ${log.join('\n  ')}`);
    return true;
  });
}

/**
 * 递归合并 src 的内容进 dest。
 *
 * 撞名策略：**字节相同就丢掉来的那份**（线上唯一一处撞名是 agent 把生成图从
 * assets/ 拷了一份进任务目录，7 个文件逐字节相同）。真不一样才两份都留，
 * 来的那份加后缀 —— 并且**大声报出来**，因为改名会让 html 里的引用指空。
 */
async function mergeDir(src, dest, log) {
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) {
      if (await pathExists(to)) {
        await fs.mkdir(to, { recursive: true });
        await mergeDir(from, to, log);
        await fs.rm(from, { recursive: true, force: true });
      } else {
        await fs.rename(from, to);
      }
      continue;
    }
    if (!(await pathExists(to))) { await fs.rename(from, to); continue; }
    if (await sameFile(from, to)) { await fs.rm(from, { force: true }); continue; }
    const ext = path.extname(e.name);
    const alt = path.join(dest, `${path.basename(e.name, ext)}-任务版${ext}`);
    await fs.rename(from, alt);
    log.push(`⚠️ 撞名且内容不同：${e.name} → ${path.basename(alt)}（引用它的地方要改）`);
  }
}

/**
 * 旧任务标记 `.nd-task.json` → 新产物标记 `.nd-project.json`。
 *
 * 旧标记里有三样：`sessionId` / `boundAt`（"这个任务属于哪次对话" —— 正是这次
 * 要废掉的绑定，不带走）和 `kind`（形态兜底，还有用）。`root`（构建型站点显式
 * 声明产物根）线上数据里一个都没有，但真出现了也一并带走，它比 kind 更要紧。
 *
 * 不能只删不转：形态判定是「文件即真相，marker 兜底」，兜底那一支塌了的话，
 * 刚建好还没写入口文件的空文件夹会认不出形态。
 */
async function retireTaskMarker(dir, log) {
  const old = path.join(dir, '.nd-task.json');
  let parsed = null;
  try { parsed = JSON.parse(await fs.readFile(old, 'utf8')); } catch { return; }
  const keep = {};
  if (typeof parsed?.kind === 'string') keep.kind = parsed.kind;
  if (typeof parsed?.root === 'string') keep.root = parsed.root;
  const next = path.join(dir, '.nd-project.json');
  if (Object.keys(keep).length && !(await pathExists(next))) {
    await fs.writeFile(next, JSON.stringify(keep, null, 2), 'utf8');
    log.push(`${path.basename(dir)}/.nd-task.json → .nd-project.json（留下 ${Object.keys(keep).join('+')}，去掉会话归属）`);
  }
  await fs.rm(old, { force: true });
}

/**
 * 文件夹上移一层之后，修 HTML/CSS 里**爬出文件夹**的相对路径。
 *
 * 这是这次迁移唯一会**静默损坏内容**的地方，实测抓到的：
 *   `tasks/Space-Colony/_drafts/proto.html` 里写着 `../../../assets/generated/x.webp`
 *   —— 老位置深三层，爬三下正好到 `shared/assets/`。上移之后只剩两层，
 *   同样爬三下就爬到工作区外面，图全部 404，而页面照常渲染，没有任何报错。
 *
 * 判据是「这条引用有没有爬出它自己那个文件夹」：
 *   文件在文件夹内的深度 d（`<T>/f.html` → 0，`<T>/_drafts/f.html` → 1）
 *   引用的 `../` 个数 k
 *   k > d  = 爬出去了 → 少爬一层（文件夹整体上移了一层，外面的东西近了一层）
 *   k ≤ d  = 还在文件夹里面 → 一个字节都不动（文件和目标一起搬的，相对关系没变）
 */
async function fixEscapingRelativePaths(dir, log, depth = 0) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  let fixed = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      fixed += await fixEscapingRelativePaths(p, log, depth + 1);
      continue;
    }
    if (!/\.(html?|css|js)$/i.test(e.name)) continue;
    let src;
    try { src = await fs.readFile(p, 'utf8'); } catch { continue; }
    // 只认跟在引号 / url( / 空白后面的那种，避免动到正文里偶然出现的 "../"
    const next = src.replace(/(["'(\s=])((?:\.\.\/)+)/g, (m, lead, dots) => {
      const k = dots.length / 3;
      if (k <= depth) return m;                       // 没爬出这个文件夹
      return lead + '../'.repeat(k - 1);
    });
    if (next === src) continue;
    try { await fs.writeFile(p, next, 'utf8'); fixed += 1; } catch { /* 只读文件，跳过 */ }
  }
  if (fixed && depth === 0) log.push(`${path.basename(dir)}/ 里 ${fixed} 个文件的相对路径少爬了一层`);
  return fixed;
}

async function sameFile(a, b) {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return ba.equals(bb);
  } catch { return false; }
}

async function moveFile(from, to, log) {
  if (!(await pathExists(from)) || await pathExists(to)) return;
  await fs.rename(from, to);
  log.push(`${path.basename(from)} → ${path.relative(path.dirname(path.dirname(to)), to)}`);
}

/**
 * SDK 转录搬家：`<config>/projects/<encode(老 cwd)>/*.jsonl`
 *                → `<config>/projects/<encode(新 cwd)>/`
 *
 * 不搬 = 每条会话打开是空白。已存在同名就跳过（不覆盖，宁可留在老目录里）。
 */
async function moveTranscripts(oldCwd, newCwd, sid, log) {
  const base = path.join(claudeConfigDir(), 'projects');
  const from = path.join(base, encodeCwdForSDK(oldCwd));
  const to = path.join(base, encodeCwdForSDK(newCwd));
  if (!(await pathExists(from))) return;
  await fs.mkdir(to, { recursive: true });
  let moved = 0;
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const dst = path.join(to, e.name);
    if (await pathExists(dst)) continue;
    await fs.rename(path.join(from, e.name), dst);
    moved += 1;
  }
  if (moved) log.push(`转录 ${moved} 份 → ${sid.slice(0, 8)}`);
}

/** 延迟取（platform.js 读 env，import 时机比这里早不了多少，但别在模块顶层固化） */
function claudeConfigDir() {
  return process.env.NODESIGN_CONFIG_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
}

const SESSION_DECK_RE = /^deck:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * board.json 的物件 id 重写 + zones 丢弃。
 *
 * id 里的任务段直接消失：
 *   `tasks/<t>/notes/a.md` → `notes/a.md`      （文件型物件 = 相对路径）
 *   `deck:task/<t>`        → `deck:canvas.html`
 *   `deck:task/<t>/x.html` → `deck:x.html`
 *   `site:task/<t>`        → `site:.`          （`.` = 产物根就是工作区根）
 *   `site:task/<t>/v2`     → `site:v2`
 *   `deck:<会话uuid>`       → 丢弃（会话 deck 这个概念随绑定一起废）
 *
 * 关系线的两个端点用同一张表改，改完两端还在才留 —— 否则线会挂在空气上。
 */
async function rewriteBoardIds(file, renames, log) {
  let board;
  try { board = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return; }
  if (!board || typeof board !== 'object') return;

  const mapId = (id) => {
    if (typeof id !== 'string') return null;
    if (SESSION_DECK_RE.test(id)) return null;                 // 会话 deck 退役
    const m = id.match(/^(deck|site):task\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const [, type, task, rest] = m;
      const seat = renames.get(`task/${task}`);
      // 磁盘上没有这个任务了（board.json 里的陈年孤儿，指向的文件早就不在）。
      // 迁移前它就已经是死的，顺手清掉而不是搬到根上假装还活着。
      if (!seat) return null;
      const under = (p) => `${seat}/${p}`;
      if (type === 'deck') return `deck:${under(rest || 'canvas.html')}`;
      return `site:${rest ? under(rest) : seat}`;
    }
    for (const [oldPrefix, newPrefix] of renames) {
      if (oldPrefix.endsWith('/') && id.startsWith(oldPrefix)) {
        return newPrefix + id.slice(oldPrefix.length);
      }
    }
    // 还带着 `tasks/` 前缀却没匹配上任何一条改名 = 指向一个磁盘上早就没有的
    // 任务（board.json 里的陈年孤儿，实测 3wgl 有两条指向删掉的 shelter/）。
    // 迁移前它就不渲染，留着只会变成一条永远对不上号的路径。
    if (id.startsWith('tasks/')) return null;
    return id;
  };

  /**
   * 分区 → 文件夹。**不丢弃**（2026-08-08 改）。
   *
   * 上一版这里是 `delete next.zones` —— 那时的方向是分区整个体系退役。方向变了：
   * 分区降级成文件夹，是能嵌套、能自由摆放的一等公民，它在画布上的矩形、标题、
   * 收起状态都还要用。id 从 `task/<名>` 变成文件夹的工作区相对路径 `<名>`。
   *
   * 会话分区（id 是 sessionId 的那些，任务模型之前的遗产）没有对应的文件夹，
   * 照旧丢 —— 它们背后没有任何磁盘目录，留着就是永远删不掉的僵尸卡。
   */
  const mapZoneId = (id) => {
    if (typeof id !== 'string') return null;
    if (!id.startsWith('task/')) return null;
    return renames.get(id) ?? null;
  };

  const objects = {};
  for (const [id, o] of Object.entries(board.objects || {})) {
    const next = mapId(id);
    if (next && !objects[next]) objects[next] = o;
  }
  const zones = {};
  for (const [id, z] of Object.entries(board.zones || {})) {
    const next = mapZoneId(id);
    if (next && !zones[next]) zones[next] = z;
  }
  // 关系线的端点可以是物件，也可以是文件夹 —— 两种都要跟着改名。
  // **先判形状再解**：`task/<名>` 落进 mapId 会走到末尾那句 `return id` 被
  // 原样放行（既不匹配 `deck:` 那条正则，也不匹配任何以 '/' 结尾的前缀），
  // 于是永远轮不到 mapZoneId，文件夹端点就留在旧 id 上成了断头线。
  const mapEnd = (id) => (typeof id === 'string' && id.startsWith('task/') ? mapZoneId(id) : mapId(id));
  const bindings = {};
  for (const [id, b] of Object.entries(board.bindings || {})) {
    const from = mapEnd(b?.from);
    const to = mapEnd(b?.to);
    if (from && to && from !== to) bindings[id] = { ...b, from, to };
  }
  await fs.writeFile(file, JSON.stringify({ ...board, objects, zones, bindings }), 'utf8');
  log.push(`board.json：物件 ${Object.keys(board.objects || {}).length} → ${Object.keys(objects).length}`
    + `，文件夹 ${Object.keys(board.zones || {}).length} → ${Object.keys(zones).length}`
    + `，关系 ${Object.keys(board.bindings || {}).length} → ${Object.keys(bindings).length}`);
}

async function pathExists(p) {
  // lstat 不 follow：包括软链 dangling 在内"存在"就算
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
