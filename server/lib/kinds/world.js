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

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
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

  async instanceManifest() {
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
      nodes: [],         // 阶段 1 填：`世界/` 递归扫出来的嵌套节点
    };
  },

  /**
   * 每轮注入的产物清单里，这个世界的一行说明。
   *
   * 这一行是**注入预算纪律的载体**（见 plan 漏洞第 5 条）：它要给出 agent
   * 干活所需的最小事实，并且明说哪些文件不要全文读。阶段 0 先只报结构存在性，
   * 当前场景 / 在场名单要等阶段 1 的节点发现。
   */
  async describe(taskDir) {
    const parts = ['世界'];
    try {
      const { size } = await fs.stat(path.join(taskDir, ENTRY));
      parts.push(`世界书 ${size < 1024 ? `${size}B` : `${(size / 1024).toFixed(1)}KB`}`);
    } catch {
      parts.push('世界书还没写（先建 世界.md）');
    }
    parts.push(await exists(path.join(taskDir, WORLD_DIR))
      ? `地图在 ${WORLD_DIR}/`
      : `地图还没铺（建 ${WORLD_DIR}/ 开始）`);
    return parts.join(' · ');
  },
};
