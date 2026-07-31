/**
 * kinds/world.js — world 形态（世界 / 小说 / RP）
 *
 * 形态契约见 kinds/index.js。world 跟 deck、site 的本质区别是**源就是状态本身**：
 * deck 和 site 的任务目录装的是「要交付的东西」，world 的任务目录装的是「这个
 * 世界现在的样子」——世界书、地图、角色、关系、正文/场记。产物根永远是任务根，
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
 * ── 阶段 0 边界 ──
 * 本文件当前只实现到「注册表挂得上、判定不误伤」：discoverInstances 只吐世界
 * 根一条，不递归扫 `世界/`。嵌套节点发现是阶段 1。这样做是为了让「KIND_ORDER
 * 把 world 放最前」这个**动了所有任务判定次序**的改动能单独回归、单独验收。
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
 * 阶段 1 只读不写：不读任何 .md 的内容（20 个角色就是 20 次文件读，而这个
 * 扫描每次列任务清单都要跑一遍），只 stat 和 readdir。角色的稳定 id 要等到
 * 阶段 3 真做 mv 时再读 frontmatter，那时才有人依赖它。
 */
async function scanWorld(taskDir) {
  const nodes = [];

  const evidenceOf = async (rel) => {
    for (const c of NODE_EVIDENCE) {
      if (await exists(path.join(taskDir, rel, c.file))) return c;
    }
    return null;
  };

  /** @returns {boolean} 这个目录之下（不含自身）有没有扫出节点 */
  const walk = async (relDir, parentRel, depth) => {
    if (depth > MAX_DEPTH) return false;
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
  return nodes.sort((a, b) => a.path.localeCompare(b.path));
}

export default {
  id: 'world',
  entryFile: ENTRY,
  view: 'world',
  injectFit: false,               // 没有翻页语义，不注入整屏 fit script
  exportFormats: ['handoff'],     // 阶段 6 加 'book'（仿书是导出格式，不是窗）
  referenceDoc: { file: 'world-reference', title: '世界形态技术参考' },

  /**
   * 判定：任务根有世界书，或 marker 声明。
   *
   * marker 也认，是为了挡住 detectTaskKind 里 deck 的 `hasLooseHtml` 兜底
   * ——world 任务里出现散装 .html（导出预览、agent 随手写的试作）不该把整个
   * 任务判成 deck。world 在 KIND_ORDER 最前 + 这里认 marker，两个一起才挡得住。
   */
  async detect(taskDir, marker) {
    if (marker?.kind === 'world') return true;
    return exists(path.join(taskDir, ENTRY));
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
      // `世界/` 递归扫出来的嵌套节点（平列表带 parent）。这就是地图。
      nodes: await scanWorld(taskDir),
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
    if (!nodes.length) {
      parts.push(`地图还没铺（在 ${WORLD_DIR}/ 下建文件夹，放 地点.md 或 角色.md）`);
      return parts.join(' · ');
    }
    const places = nodes.filter(n => n.type === 'place');
    const chars = nodes.filter(n => n.type === 'character');
    parts.push(`${places.length} 个地点 / ${chars.length} 个角色`);

    // 在场名单：装在地点里的角色。装在容器里的是收纳态，不在场，不该进上下文。
    const containerPaths = nodes.filter(n => n.type === 'container').map(n => n.path);
    const stowed = (n) => containerPaths.some(c => n.parent === c || n.parent?.startsWith(`${c}/`));
    const onStage = chars.filter(n => !stowed(n));
    parts.push(onStage.length
      ? `在场：${onStage.slice(0, 8).map(n => `${n.name}(${n.parent.split('/').pop()})`).join('、')}${onStage.length > 8 ? ' …' : ''}`
      : '当前没有角色在场');

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
