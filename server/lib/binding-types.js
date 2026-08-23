/**
 * 关系线的语义词汇表 —— 画布上一条线「是什么意思」的**唯一真相**。
 *
 * ## 为什么关系要单独存一张表
 *
 * 北极星是「任务文件夹能排出登录墙那种版面」。手摆之所以好看，是因为每张纸的
 * 位置在回答「它和旁边那张什么关系」。而系统此前只知道每个产物的**尺寸和
 * mtime** —— 关系数据不到位，再好的布局算法也只能排出「错落有致的网格」。
 *
 * 所以关系是 board.json 里的一等公民，跟 objects / zones 平级：
 *
 *   bindings: { "<id>": { type, from, to, label?, by? } }
 *
 * 端点 `from` / `to` 是 **object id 或 zone id**（用户明确要求文件夹之间也能连线）。
 * 线本身不存坐标 —— 端点一移动，线自己跟着走。这是 tldraw `TLBinding` 的思路：
 * 关系是独立记录，不是形状的属性，箭头形状本身不存端点坐标。**抄的是思路，
 * 不是代码**（tldraw 是专有许可证）。
 *
 * ## 为什么是这五种
 *
 * 挑的标准是「这条关系能不能改变布局决定」。能影响摆放的才收，纯装饰的不收。
 * 每一种都对应创作过程里一件真实发生的事：
 *
 * - **改自**：一个产物是另一个的下一版。这是版本谱系，最该被看见的一条 ——
 *   用户翻旧版找的就是它。
 * - **批注**：一段文字在说某个东西。annotation 形态存在的理由。
 * - **顺序**：分镜、章节、流程的先后。它决定读序，也就决定排布方向。
 * - **取材**：这张图用在那个 deck 里 / 这份资料喂给了那篇稿。跨任务的引用。
 * - **对照**：并列比较（proto-暖调 vs proto-冷调）。无向，且**明确要求并排**，
 *   是唯一一条直接给布局下指令的关系。
 *
 * ## 明确不做成线的：「成组」
 *
 * 「这几件属于同一批」的正确画法是**圈一个框**，不是两两连线 —— n 个成员
 * 两两连线是 n(n-1)/2 条，五件就是十条，画面直接糊掉。成组用已有的 zone
 * （工作区 / 文件夹）表达，agent 建文件夹收纳就是在表达成组。
 */

/**
 * 词汇表。`directed` 决定渲染时画不画箭头，也决定 from/to 能不能互换。
 * `label` 是没写自定义文字时线上显示的默认词。
 */
export const BINDING_TYPES = {
  'derives-from': { label: '改自', directed: true },
  annotates: { label: '批注', directed: true },
  flow: { label: '接着', directed: true },
  ref: { label: '取材', directed: true },
  contrast: { label: '对照', directed: false },
  // 关联（2026-08-14，手动连线上线时加）：五种预定义都不合身时的逃生舱。
  // 含义由线上的 label 定义（用户写一句，agent 逐字读）。收它不违反
  // 「纯装饰不收」——它对布局说「摆近点」（affinity），对 agent 说 label 那句话。
  link: { label: '关联', directed: false },
};

/** 词汇表 id 列表，校验和 parity 断言都用它。 */
export const BINDING_TYPE_IDS = Object.keys(BINDING_TYPES);

/**
 * 材质（2026-08-23 黑板）：与语义正交的第二个轴。
 *   ink     墨线 —— 版面线的默认材质，安静
 *   pencil  手绘 —— 铅笔抖动，像人顺手拉的一笔
 *   yarn    丝线 —— 侦探板上的红线 + 图钉，推理态、声量大
 * 前端 board-bindings.js 的 BINDING_MATERIALS 必须与这份 id 一一对应（parity 测试）。
 */
export const BINDING_MATERIALS = ['ink', 'pencil', 'yarn'];
export function isBindingMaterial(m) {
  return BINDING_MATERIALS.includes(m);
}

export function isBindingType(t) {
  return Object.prototype.hasOwnProperty.call(BINDING_TYPES, t);
}
