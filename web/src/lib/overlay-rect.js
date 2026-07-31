/**
 * overlay-rect.js — iframe 内坐标 → overlay 层坐标
 *
 * 画布上所有贴着 iframe 内元素的浮层（选中圈、评论标记、拖拽幽灵、抓手、待应用
 * 移动标记、评论浮卡）都要做同一次换算。这里是唯一实现。
 *
 * 换算三件事：
 *   1. **缩放**：elRect 是 iframe **内部** viewport 坐标（不受外层 transform 影响），
 *      iframeRect 是外层 scale 之后的视觉盒。所以内部坐标要乘 zoom 才能对齐。
 *   2. **平移**：overlay 是 iframe.offsetParent 的 absolute 子元素，得换到那个坐标系。
 *   3. **容器滚动**（2026-07-30 修）：absolute 子元素的包含块是容器的 **padding box**，
 *      它跟着内容一起滚。只用"视觉差"（iframeRect - containerRect）当 left/top，
 *      容器每滚 N 像素浮层就偏 N 像素 —— 因为视觉差里已经扣过一次滚动量，
 *      浏览器渲染时又扣一次。把容器自己的 scrollLeft/scrollTop 加回来才对。
 *
 *      站点窗的取景框正是这么一个 `position:relative + overflow:auto` 容器，
 *      而且 iframe 按真实设备宽渲染（1440），装不下就会横向滚 —— 一滚圈就飞了。
 */

/**
 * @param {HTMLIFrameElement} iframe
 * @returns {{ x: number, y: number, iframeRect: DOMRect, containerRect: DOMRect } | null}
 *   x/y = iframe 内部原点 (0,0) 在 overlay 坐标系里的位置
 */
export function overlayBase(iframe) {
  if (!iframe) return null;
  const offsetParent = iframe.offsetParent;
  if (!offsetParent) return null;
  const iframeRect = iframe.getBoundingClientRect();
  const containerRect = offsetParent.getBoundingClientRect();
  return {
    x: iframeRect.left - containerRect.left + (offsetParent.scrollLeft || 0),
    y: iframeRect.top - containerRect.top + (offsetParent.scrollTop || 0),
    iframeRect,
    containerRect,
  };
}

/**
 * iframe 内部坐标 → overlay 坐标。
 * @param {{x:number,y:number}} base  overlayBase 的返回
 */
export function toOverlayXY(base, innerX, innerY, zoom = 1) {
  return { left: base.x + innerX * zoom, top: base.y + innerY * zoom };
}

/**
 * 贴着某个 iframe 内元素浮出的**卡片**该放哪（评论浮卡、拖后便签）。
 *
 * 跟 toOverlayXY 分开是因为卡片多两件事：默认贴元素右侧、放不下要翻边，
 * 以及**钳在 iframe 视觉盒之内**别飞到画布空白处。
 *
 * ⚠️ 钳位边界必须用 iframe 的**视觉盒**（overlay 坐标系里的 base.x ~
 * base.x + iframeRect.width），不能用外层容器的宽高。这是 2026-07-31 那个
 * "评论卡飘到别处"的第二层错：老代码坐标用 iframe 原点系、边界却用容器尺寸，
 * 两套坐标系混着比。
 *
 * @param {{x:number,y:number,iframeRect:{width:number,height:number}}} base
 * @param {{left:number,top:number,width:number}} elRect  iframe 内部坐标
 * @param {number} zoom
 * @param {{cardWidth:number, cardHeight:number, offset?:number}} opts
 * @returns {{left:number, top:number}} overlay 坐标
 */
export function placeFloatingCard(base, elRect, zoom, opts) {
  const offset = opts.offset ?? 12;
  const { cardWidth, cardHeight } = opts;
  const boxW = base.iframeRect?.width ?? 0;
  const boxH = base.iframeRect?.height ?? 0;

  // 元素视觉 bbox（overlay 坐标系）
  const elLeft = base.x + elRect.left * zoom;
  const elTop = base.y + elRect.top * zoom;
  const elWidth = elRect.width * zoom;

  // 视觉盒的左右/上下边界，同样在 overlay 坐标系
  const minX = base.x + offset;
  const maxX = base.x + boxW - offset;
  const minY = base.y + offset;
  const maxY = base.y + boxH - offset;

  // 默认贴右侧；右边放不下翻到左侧；左侧也放不下就贴住左边界
  let left = elLeft + elWidth + offset;
  if (left + cardWidth > maxX) left = elLeft - cardWidth - offset;
  if (left < minX) left = minX;

  let top = elTop;
  if (top + cardHeight > maxY) top = Math.max(minY, maxY - cardHeight);
  if (top < minY) top = minY;

  return { left, top };
}
