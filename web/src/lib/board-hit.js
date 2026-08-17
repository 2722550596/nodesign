/**
 * 「这次按下落在哪」—— 全画布唯一的命中判据（2026-08-07）。
 *
 * ## 为什么必须只有一份
 *
 * 画布上想吃左键的有三方：相机（拖空白平移）、工具（画一笔 / 写字 / 标注）、
 * 物件（拖着挪位置）。每一方都要回答「我该不该接管这次按下」，判据是排除法。
 * 这份清单被抄散之后连着栽了三次，症状都**不抛异常、不打日志**：
 *
 *   1. 相机漏了工具栏 → 点工具栏被当成拖画布，相机 setPointerCapture，
 *      按钮的 click 再也不完整（按钮点了没反应）。
 *   2. 工具也漏了工具栏 → 拿着画笔点工具栏会在按钮上起一笔并抢走指针捕获，
 *      之后镜头彻底卡死。
 *   3. 收敛成一张表之后**收过头**：把物件也排除了，于是评论工具点不了卡片 ——
 *      而"点卡片"正是它的全部意义。
 *
 * 第 3 次说明这不是一张表而是**两层**：
 *
 * - **界面控件（chrome）**：工具栏、卡上的小按钮、工作区头上的按钮。
 *   三方都要躲开 —— 它们是 UI，不是画布内容。
 * - **画布物件（object）**：卡片、工作区。**只有相机要躲开**；工具本来就该
 *   能在卡片上落笔（在图上画个圈、给卡片写批注）。
 */

/** 界面控件：谁都不许把这里当画布 */
export const CHROME_SELECTOR = [
  '[data-board-action]',     // 卡上的小按钮
  '[data-zone-action]',      // 工作区头上的按钮
  '[data-floating-toolbar]', // 浮动工具栏整条
  '[data-tool-btn]',         // 工具栏按钮
  '[data-no-pan]',           // 通用逃生舱
].join(',');

/**
 * 画布物件：相机要躲开，工具不用。
 *
 * `[data-phantom]` 是生图占位卡（2026-08-17 起可拖 —— 拖它就是指定这张图
 * 待会儿落在哪）。它不在 board.json 里，但对着这三方它就是一个画布物件：
 * 按在它身上是要挪它，不是要拖画布。
 */
export const OBJECT_SELECTOR = '[data-board-object],[data-board-zone],[data-phantom]';

/** 落在界面控件上（工具栏、按钮…）。**三方都该先问这一句**。 */
export function onChrome(e) {
  return !!e?.target?.closest?.(CHROME_SELECTOR);
}

/** 落在画布物件上（卡片 / 工作区）。 */
export function onObject(e) {
  return !!e?.target?.closest?.(OBJECT_SELECTOR);
}

/** 落在真正的空地上（既不是控件也不是物件）—— 相机平移的判据。 */
export function onBlankCanvas(e) {
  return !onChrome(e) && !onObject(e);
}
