import { DECK_EMBED_W } from './board-geometry.js';

/**
 * 形态能力表 —— 每种画布物件「是什么、能做什么」写在一张表里。
 *
 * ## 为什么要有这张表
 *
 * 2026-08-07 清点：BoardCanvas 里散着 49 处 `o.type === '…'` 分支，分布在
 * 五件互不相干的事情上 —— 归属派生、打开行为、hover 工具条、卡体渲染、
 * 收纳带兜底。**每加一种形态就要在十几个地方补 if**，而画布升级要加的
 * annotation / group 至少两种，arrow 还要另开一层。再不立表就是一百多处分支。
 *
 * 思路取自 tldraw 的 `ShapeUtil`：每种形状用一张显式的能力表声明自己
 * （`canBind` / `canResize` / `canEdit` / `getGeometry` / `component`…），
 * 调用方问表，不写分支。**抄的是这个思路，不是它的代码** —— tldraw 是专有
 * 许可证，产品里不能出现它的源码。
 *
 * ## 两条轴
 *
 * - `backing`：这个物件的真相在**磁盘**还是只在 **board.json**。
 *   现有七种全是 `file`（产物即真相，路径派生归属），只有 `doc` 例外（它是
 *   记忆/品牌/指引三张卡的画布分身）。**annotation 会是第一个真正的 canvas
 *   物件**：agent 写在画布上的说明文字不对应任何文件，删了也不该动磁盘。
 *   凡是「加入上下文」「打开原始文件」「按路径派生归属」这类动作，都只对
 *   `file` 成立，所以这条轴必须显式写出来，不能靠有没有 `path` 猜。
 * - `variant`：同一种 type 因为自身属性走不同行为。目前只有一例 ——
 *   `.md` 文件也是 `file`，但它能进阅读器（2026-08-03 加的路由）。
 *   放在表里当变体，而不是在调用点写 `type === 'file' && isMarkdown(o)`。
 *
 * ## 不在这张表里的东西
 *
 * 卡体的 JSX 仍在 BoardCanvas 的 `BoardObject` 里。渲染下沉是下一步，
 * 先把**行为**收敛掉 —— 行为是纯函数，可以单测锁死，改起来零视觉风险。
 */

/** 能渲染的 markdown（`.md` / `.markdown`）。 */
export function isMarkdown(o) {
  return /\.(md|markdown)$/i.test(o?.ext || o?.name || o?.path || '');
}

/**
 * 形态注册表。
 *
 * 字段：
 * - `label`        中文名，给调试和无障碍标签用
 * - `backing`      `'file'` = 磁盘产物 / `'canvas'` = 只活在 board.json
 * - `size`         收起态尺寸（布局系统按矩形做避让，尺寸必须可预知）
 * - `sizeExpanded` 展开态尺寸；有这项即代表 `expandable`
 * - `reader`       双击/「阅读」进哪个阅读器：`'memory'` 走 Memory.read、
 *                  `'file'` 拉原始文件正文、`'note'` 剥 frontmatter 后读、
 *                  `null` 没有阅读器
 * - `primary`      双击的默认动作：`'read'|'detail'|'expand'|'openFile'`
 * - `actions`      hover 工具条按钮，**顺序即渲染顺序**
 * - `legacyBucket` 没有工作区可归时掉进桌面底部收纳带的哪一摞
 */
export const KINDS = {
  doc: {
    label: '文档',
    backing: 'canvas',
    size: { w: 200, h: 96 },
    reader: 'memory',
    primary: 'read',
    actions: ['add', 'read'],
    legacyBucket: 'doc',
  },

  deck: {
    label: '幻灯',
    backing: 'file',
    size: { w: 240, h: 88 },
    sizeExpanded: { w: DECK_EMBED_W, h: 28 + 360 },
    reader: null,
    primary: 'expand',
    // deck 卡自带常驻标题栏（编辑 / 内嵌渲染都在上面），外挂 hover 工具标
    // 是重复的第二套按钮 —— 2026-07-28 撤掉，deck 只留卡内那一套。
    actions: [],
    legacyBucket: 'deck',
  },

  site: {
    label: '站点',
    backing: 'file',
    size: { w: 240, h: 88 },
    // 站点没有固定比例，取 16:10 一屏做取景框，够看出版式和配色
    sizeExpanded: { w: DECK_EMBED_W, h: 28 + 400 },
    reader: null,
    primary: 'expand',
    actions: ['add'],
    legacyBucket: 'art',
  },

  world: {
    label: '世界',
    backing: 'file',
    size: { w: 240, h: 88 },
    // 展开态铺开地图（嵌套地点框 + 立绘）。高度给固定值不给自适应 ——
    // 布局系统按矩形做避让，尺寸得可预知；地图比框高就内部滚动。
    sizeExpanded: { w: DECK_EMBED_W, h: 28 + 420 },
    reader: null,
    primary: 'expand',
    actions: ['add'],
    legacyBucket: 'art',
  },

  image: {
    label: '图片',
    backing: 'file',
    size: { w: 200, h: 176 },
    reader: null,
    primary: 'detail',
    actions: ['add', 'detail'],
    legacyBucket: 'art',
  },

  note: {
    label: '便签',
    backing: 'file',
    size: { w: 200, h: 148 },
    reader: 'note',
    primary: 'read',
    actions: ['add', 'read', 'delete'],
    legacyBucket: 'art',
  },

  /**
   * 涂鸦 —— **第一个真正的画布原生物件**（2026-08-07）。
   *
   * 它不对应任何文件：笔画只活在 board.json 里（服务端 `CANVAS_NATIVE_KINDS`
   * 白名单登记）。所以 `backing: 'canvas'`，而这条轴带来的后果是具体的：
   * 不能加入上下文（没有 path 可给）、没有阅读器、删它不动磁盘、
   * **agent 读不到它**。
   *
   * 最后那条是设计取舍不是缺陷：涂鸦是用户给自己做的记号（圈一下、划条线），
   * 要说给 agent 听的话应该写文字（文字落盘成 .md，那条路是通的）。
   *
   * 尺寸由笔画包围盒定，不走这张表 —— 这里的 size 只是兜底。
   */
  scribble: {
    label: '涂鸦',
    backing: 'canvas',
    size: { w: 160, h: 120 },
    reader: null,
    primary: null,
    actions: ['delete'],
    legacyBucket: 'art',
  },

  file: {
    label: '文件',
    backing: 'file',
    size: { w: 224, h: 40 },
    reader: null,
    primary: 'openFile',
    actions: ['add', 'open'],
    legacyBucket: 'file',
    // `.md` 也是 file，但它能进阅读器：「阅读」是渲染过的（双击默认走这条），
    // 「打开」仍留着给原始文件。frontmatter 不剥 —— 便签的 `---` 头是会话
    // 元数据该藏，普通 md 的 frontmatter 是内容的一部分。
    variant: (o) => (isMarkdown(o)
      ? { reader: 'file', primary: 'read', actions: ['add', 'read', 'open'] }
      : null),
  },
};

/** 未知 type 一律按 file 处理（跟老的 `SIZES[o.type] || SIZES.file` 同口径）。 */
export function kindOf(o) {
  return KINDS[o?.type] || KINDS.file;
}

/** 形态能力 + 变体覆盖。**所有调用点都该问这个，不要直接读 KINDS。** */
export function traitsOf(o) {
  const k = kindOf(o);
  const v = k.variant?.(o);
  return v ? { ...k, ...v } : k;
}

/** 物件当前占的矩形（展开态取 sizeExpanded）。 */
export function sizeOf(o) {
  const k = kindOf(o);
  return (o?.pos?.expanded && k.sizeExpanded) || k.size;
}

/** 能不能展开成内嵌渲染态。 */
export function isExpandable(o) {
  return !!kindOf(o).sizeExpanded;
}

/** 真相在磁盘上吗（决定能否加入上下文 / 打开原始文件 / 按路径派生归属）。 */
export function isFileBacked(o) {
  return kindOf(o).backing === 'file';
}

/** hover 工具条要哪几个按钮，顺序即渲染顺序。 */
export function actionsOf(o) {
  return traitsOf(o).actions;
}

/**
 * 能不能加进上下文托盘。
 *
 * 单卡的「＋」和工作区头的「＋全部加入上下文」必须同一个判据 —— 重构前
 * 它们是两处各写各的 `o.type !== 'deck'`，改一处漏一处只是时间问题。
 */
export function canAddToContext(o) {
  return actionsOf(o).includes('add');
}

/** 双击的默认动作。 */
export function primaryOf(o) {
  return traitsOf(o).primary;
}

/** 进哪个阅读器（null = 没有阅读器）。 */
export function readerOf(o) {
  return traitsOf(o).reader;
}

/** 没有工作区可归时掉进收纳带的哪一摞。 */
export function legacyBucketOf(o) {
  return kindOf(o).legacyBucket;
}

/**
 * 尺寸表的兼容出口。
 *
 * 老代码按 `SIZES.deck` / `SIZES.deckExpanded` 这样取值，这里原样铺平一份，
 * 免得为了立表把十几个调用点一起改。新代码请用 `sizeOf(o)`。
 */
export const SIZES = Object.fromEntries([
  ...Object.entries(KINDS).map(([k, v]) => [k, v.size]),
  ...Object.entries(KINDS)
    .filter(([, v]) => v.sizeExpanded)
    .map(([k, v]) => [`${k}Expanded`, v.sizeExpanded]),
]);
