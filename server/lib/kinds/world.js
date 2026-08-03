/**
 * kinds/world.js — world 形态（世界 / 角色扮演）
 *
 * 2026-08-03：小说模式（大纲三层 + 正文散文）从 world-craft skill 和注入提示词里
 * 撤掉了 —— 那条线还没想清楚最终形态，先不对外露出。撤的只是**方法论与话术**，
 * 形态本身、目录结构、判定逻辑一个字没动，将来要接回来是往 SKILL 里加节，
 * 不是重做形态。历史设计仍在 docs/world-kind-plan.md。
 *
 * 形态契约见 kinds/index.js。world 跟 deck、site 的本质区别是**源就是状态本身**：
 * deck 和 site 的任务目录装的是「要交付的东西」，world 的任务目录装的是「这个
 * 世界现在的样子」——世界书、地图、角色、关系、场记。产物根永远是任务根，
 * dist/ 只用来放导出物（仿书 html 之类，阶段 6）。
 *
 * 核心结构决定（详见 docs/world-kind-plan.md）：
 *   **文件夹树就是世界的空间结构。** `世界/` 之下每一层文件夹是一个地点，
 *   文件夹里的角色文件夹就是此刻在那儿的人。角色移动 = 文件夹 mv。
 *   「谁在哪」不需要第二份数据结构，它就是路径本身。
 *
 * 判定证据用**内容**不用命名（与 index.js 头注释「文件会被用户和 agent 直接改，
 * marker 不会」同源）：装着 `地点.md` 的文件夹是地点，装着 `角色.md` 的是角色，
 * 装着 `容器.md` 的是收纳容器（不是地点，存不在场的人）。于是重命名永远不会
 * 弄坏东西，显示名可以随便起。
 *
 * ── 当前进度（阶段 1 完）──
 * 判定与独占（阶段 0）、`世界/` 的嵌套节点发现（阶段 1）已就位，只读。
 * 还没有的：per-task git、world-craft skill 与每轮注入接线（阶段 2）、
 * 角色移动与章末结算（阶段 3）、立绘管线（阶段 4）。路线见
 * docs/world-kind-plan.md。
 *
 * 阶段 3 会用到但现在**故意没做**的一件事：角色的稳定 id。现在一切按 path
 * 寻址，而 mv 会让 path 变。之所以敢先不做，是因为目前没有任何一层持久化过
 * 节点路径（board.json 只存任务级的 `world:task/<t>`）。真开始做 mv 之前，
 * 别让评论锚点 / 托盘 / 布局任何一层开始按节点路径存引用。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/** 世界书。既是 detect 证据，也是入口文件 */
const ENTRY = '世界.md';

/** 空间结构根：`世界/` 之下的文件夹树就是地图 */
export const WORLD_DIR = '世界';

/**
 * 节点类型的内容证据。一个文件夹装着哪份说明文件，它就是哪种节点。
 * 顺序 = 判定优先级（同时装了多份时取先命中的，属于用户写错，不崩）。
 */
export const NODE_EVIDENCE = Object.freeze([
  { type: 'place', file: '地点.md' },
  { type: 'character', file: '角色.md' },
  { type: 'container', file: '容器.md' },
]);

/**
 * 递归深度上限。世界/大陆/国/城/区/建筑/房间/角色 = 7 层，8 够用且挡住
 * 手滑造出来的深树把 manifest 撑爆（每次列任务清单都要跑这个扫描）。
 */
const MAX_DEPTH = 8;

/** 地点背景图 / 角色立绘的候选扩展名，按优先级 */
const IMG_EXT = ['png', 'webp', 'jpg', 'jpeg'];

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 找 `<dir>/<base>.<ext>`，返回相对任务根的路径；没有返回 null */
async function findImage(taskDir, relDir, base) {
  for (const ext of IMG_EXT) {
    const rel = `${relDir}/${base}.${ext}`;
    if (await exists(path.join(taskDir, rel))) return rel;
  }
  return null;
}

/** 角色立绘：优先 立绘/立绘.*，否则 立绘/ 里第一张图（按名排序，稳定） */
async function findPortrait(taskDir, charRel) {
  const dir = `${charRel}/立绘`;
  const named = await findImage(taskDir, dir, '立绘');
  if (named) return named;
  try {
    const files = (await fs.readdir(path.join(taskDir, dir), { withFileTypes: true }))
      .filter(e => e.isFile() && IMG_EXT.includes(e.name.split('.').pop().toLowerCase()))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
    return files.length ? `${dir}/${files[0]}` : null;
  } catch { return null; }
}

/**
 * 递归扫 `世界/`，吐出嵌套节点的**平列表**。
 *
 * 平列表加 parent 字段，不是嵌套对象树：manifest 的既有形状就是平的
 * （artifacts 也是平列表，层级从路径前缀推），保持一致；而且前端要按 parent
 * 分组渲染、按 path 寻址，平列表两件事都直接做得到，嵌套树反而要先拍平。
 *
 * 节点类型靠**内容证据**（NODE_EVIDENCE），不看文件夹名。所以世界里的文件夹
 * 想叫什么叫什么，重命名不会弄坏东西。没有证据文件的文件夹（比如角色文件夹
 * 底下的 `立绘/`）不是节点，跳过且不再往下递归。
 *
 * 软链目录不算节点（`dirent.isDirectory()` 对软链是 false，不跟随）。因此没有
 * 环的风险，代价是软链指向的地方在地图上不可见 —— 世界状态就该是实打实的
 * 文件树，一个角色同时出现在两处正是「一个事实多份算法」，不给这个口子。
 *
 * @returns {{nodes: Array, truncated: string[]}} truncated = 撞到深度上限被
 *   截断的目录。**必须往外报**：静默截断跟静默丢子树是同一类错误，世界少了
 *   一块而没有任何地方吭声。
 *
 * 阶段 1 只读不写：不读任何 .md 的内容（20 个角色就是 20 次文件读，而这个
 * 扫描每次列任务清单都要跑一遍），只 stat 和 readdir。角色的稳定 id 要等到
 * 阶段 3 真做 mv 时再读 frontmatter，那时才有人依赖它。
 */
async function scanWorld(taskDir) {
  const nodes = [];
  const truncated = [];

  const evidenceOf = async (rel) => {
    for (const c of NODE_EVIDENCE) {
      if (await exists(path.join(taskDir, rel, c.file))) return c;
    }
    return null;
  };

  /** @returns {boolean} 这个目录之下（不含自身）有没有扫出节点 */
  const walk = async (relDir, parentRel, depth) => {
    if (depth > MAX_DEPTH) { truncated.push(relDir); return false; }
    let entries = [];
    try {
      entries = (await fs.readdir(path.join(taskDir, relDir), { withFileTypes: true }))
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return false; }

    let produced = false;
    for (const e of entries) {
      const rel = `${relDir}/${e.name}`;
      const ev = await evidenceOf(rel);

      if (ev) {
        const node = {
          type: ev.type, path: rel, name: e.name, parent: parentRel, depth,
          file: `${rel}/${ev.file}`, implicit: false,
        };
        if (ev.type === 'place') node.background = await findImage(taskDir, rel, '背景');
        if (ev.type === 'character') node.portrait = await findPortrait(taskDir, rel);
        nodes.push(node);
        produced = true;
        // 角色不装别的节点（契约），不递归。地点和容器往下走。
        if (ev.type !== 'character') await walk(rel, rel, depth + 1);
        continue;
      }

      // 没有证据文件：先往下看一层再决定。
      //
      // 底下有节点 → 这一层是**隐式地点**。agent 建 `世界/王城/皇宫/大殿/地点.md`
      // 却忘了给皇宫写 地点.md 是很自然的手滑，此时把整棵子树静默丢掉（大殿和
      // 里面的人从画布和 describe 里一起消失）是最坏的结果：世界少了一块，
      // 而没有任何地方报错。补一个 implicit 节点既不丢结构，又让「这一层还没
      // 声明」显式可见，world-craft 可以据此提醒补 地点.md。
      //
      // 底下没节点 → 这是 `立绘/` 这类内部目录，忽略。
      if (await walk(rel, rel, depth + 1)) {
        nodes.push({
          type: 'place', path: rel, name: e.name, parent: parentRel, depth,
          file: null, implicit: true,
          background: await findImage(taskDir, rel, '背景'),
        });
        produced = true;
      }
    }
    return produced;
  };

  await walk(WORLD_DIR, null, 0);
  // 隐式节点是后序补的，排一遍让平列表读起来仍是树的顺序
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  return { nodes, truncated };
}

export default {
  id: 'world',
  entryFile: ENTRY,
  view: 'world',
  injectFit: false,               // 没有翻页语义，不注入整屏 fit script
  // 入口是 markdown，内容是文件夹树。screenshot / read_page / query_elements
  // 这些工具全都先 resolveCanvasTarget 再喂 playwright，对 world 是把一份 .md
  // 当网页开，在 1 核机器上白烧一次 chromium 还给不出有用结果。空数组是**声明**
  // 不是遗漏，requireBrowsable 靠它挡。
  capabilities: [],
  exportFormats: ['handoff'],     // 阶段 6 加 'book'（仿书是导出格式，不是窗）
  referenceDoc: { file: 'world-reference', title: '世界形态技术参考' },

  /**
   * 判定：任务根有世界书，或 marker 声明。
   *
   * marker 声明也认，是为了挡住 detectTaskKind 里 deck 的 `hasLooseHtml` 兜底
   * ——world 任务里出现散装 .html（导出预览、agent 随手写的试作）不该把整个
   * 任务判成 deck。world 在 KIND_ORDER 最前 + 这里认 marker，两个一起才挡得住。
   *
   * 反向的保险（2026-08-01 复查加的）：**已经声明是别的形态、且还没有地图的
   * 任务，光有一份 世界.md 不足以翻案。** 场景很具体：一个写小说设定的 deck
   * 任务，agent 顺手写了份「世界.md」当设定稿，整个任务就会翻成 world，画布上
   * 那些 deck 卡**静默消失**，而且 bindTaskToSession 还会把 marker 回填成
   * world 加深粘性，用户只能靠删文件恢复。
   *
   * 这不违背「文件优先、marker 兜底」：那条规矩讲的是文件证据与 marker 打架时
   * 信文件，而这里是**两份文件证据互相打架**（canvas.html 对 世界.md），
   * marker 只是被拿来当裁判。真要把一个 deck 改造成 world 也不会被卡住 ——
   * 建出 `世界/` 就是最明确的文件证据，立刻认。
   */
  async detect(taskDir, marker) {
    if (marker?.kind === 'world') return true;
    if (!(await exists(path.join(taskDir, ENTRY)))) return false;
    if (marker?.kind && marker.kind !== 'world') {
      return exists(path.join(taskDir, WORLD_DIR));
    }
    return true;
  },

  // 源即状态，产物根 = 任务根
  async artifactRoot() { return ''; },

  /**
   * 实例发现。
   *
   * 阶段 0：一个 world 任务 = 一个产物，就是这个世界本身。不像 deck / site 那样
   * 一个任务能装多份平等产物——世界只有一个，`世界/` 里的地点和角色是这个世界的
   * **内部结构**，不是并列的产物。阶段 1 会让它们作为嵌套节点出现在 manifest 里，
   * 但形态上仍然从属于这一条。
   */
  async discoverInstances(taskDir, marker) {
    return (await this.detect(taskDir, marker)) ? [{ root: '' }] : [];
  },

  async instanceManifest(taskDir) {
    // `世界/` 递归扫出来的嵌套节点（平列表带 parent）。这就是地图。
    const { nodes, truncated } = await scanWorld(taskDir);
    return {
      kind: 'world',
      root: '',
      srcRoot: '',
      entry: ENTRY,
      entryRel: ENTRY,
      file: null,        // 目录型产物（同 site 的目录站），不是单文件
      pages: [],
      single: false,
      title: null,       // 前端用任务名
      nodes,
      truncated,
    };
  },

  /**
   * 每轮注入的产物清单里，这个世界的一行说明。
   *
   * 这一行是**注入预算纪律的载体**（见 plan 漏洞第 5 条）：它要给出 agent
   * 干活所需的最小事实，并且明说哪些文件不要全文读。阶段 0 先只报结构存在性，
   * 当前场景 / 在场名单要等阶段 1 的节点发现。
   */
  async describe(taskDir, artifact) {
    const parts = ['世界'];
    try {
      const { size } = await fs.stat(path.join(taskDir, ENTRY));
      parts.push(`世界书 ${size < 1024 ? `${size}B` : `${(size / 1024).toFixed(1)}KB`}`);
    } catch {
      parts.push('世界书还没写（先建 世界.md）');
    }

    const nodes = artifact?.nodes || [];
    const truncated = artifact?.truncated || [];
    if (!nodes.length) {
      // 一个节点都没有但有截断记录 = 整张地图都埋在深度上限之下。这时候说
      // 「地图还没铺」是错的，会让人去建一个已经存在的东西
      parts.push(truncated.length
        ? `地图全部埋在 ${MAX_DEPTH} 层之下被截断（${truncated.slice(0, 2).join('、')}），把层级摊平才看得见`
        : `地图还没铺（在 ${WORLD_DIR}/ 下建文件夹，放 地点.md 或 角色.md）`);
      return parts.join(' · ');
    }
    const places = nodes.filter(n => n.type === 'place');
    const chars = nodes.filter(n => n.type === 'character');
    parts.push(`${places.length} 个地点 / ${chars.length} 个角色`);

    // 在场名单：装在地点里的角色。装在容器里的是收纳态，不在场，不该进上下文。
    const containerPaths = nodes.filter(n => n.type === 'container').map(n => n.path);
    const stowed = (n) => containerPaths.some(c => n.parent === c || n.parent?.startsWith(`${c}/`));
    const onStage = chars.filter(n => !stowed(n));
    // parent 为 null 的角色是直接放在 `世界/` 根下的（还没建任何地点就先建了人），
    // 合法状态，不带括号即可 —— 这里以前 .split 不判空，一个根下角色就让整行
    // describe 抛异常，hooks 兜底成「读不到」，世界的每轮注入清单整个静默丢失
    parts.push(onStage.length
      ? `在场：${onStage.slice(0, 8).map(n => (n.parent ? `${n.name}(${n.parent.split('/').pop()})` : n.name)).join('、')}${onStage.length > 8 ? ' …' : ''}`
      : '当前没有角色在场');

    if (truncated.length) {
      parts.push(`${truncated.length} 处嵌套超过 ${MAX_DEPTH} 层被截断（${truncated.slice(0, 2).join('、')}），这些地方的角色不在地图上，把层级摊平`);
    }

    const implicit = nodes.filter(n => n.implicit);
    if (implicit.length) {
      parts.push(`${implicit.length} 层还没写 地点.md（${implicit.slice(0, 3).map(n => n.name).join('、')}${implicit.length > 3 ? ' …' : ''}），补上它们才算正式声明`);
    }

    // 这一行是注入预算纪律的载体（plan 漏洞第 5 条）：只报在场角色的位置，
    // 并明说哪些文件不要全文读。真正管住膨胀要靠 world-craft 加监控，
    // 但清单这一层先把话说在前面。
    parts.push('只读在场角色的 角色.md；背景故事与经历按需检索，勿全文读');
    return parts.join(' · ');
  },
};
