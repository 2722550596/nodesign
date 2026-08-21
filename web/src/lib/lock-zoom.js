/**
 * 关掉手机上的整页缩放（2026-08-21）。
 *
 * 用户报的症状是"老是误触放大缩小，然后就得左右滑"—— 双指一捏页面就放大了，
 * 放大之后视觉视口比布局视口窄，于是横向也得滑。这个站的版面是竖着读的，
 * 缩放帮不上忙，只会把人卡在半张页面里。
 *
 * ## 为什么光改 viewport meta 不够
 *
 * `user-scalable=no` / `maximum-scale=1` 从 iOS 10 起被 Safari **无视**（无障碍考虑）。
 * Safari 的双指缩放走的是私有的 `gesture*` 事件，只能一条条 preventDefault。
 * Chrome/Android 认 meta，这几条监听在那儿是空转 —— 两边都留着才两边都关得掉。
 * 双击放大是第三条路，meta 和 gesture 都管不着，靠 `touch-action: manipulation`。
 *
 * ## 只对手指设备生效
 *
 * 桌面 Safari 的触控板捏合也发 gesture 事件，但桌面上缩放是正经功能（而且用户明确
 * 说过桌面端不要这些改动）。所以整段挂在 `(pointer: coarse)` 后面。
 * 注意：浏览器菜单里的「放大」和 ⌘+ 是**浏览器缩放**，跟这里无关，一个字节都碰不到。
 */
export function lockZoom() {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  if (!window.matchMedia('(pointer: coarse)').matches) return () => {};

  const stop = (e) => e.preventDefault();
  const kinds = ['gesturestart', 'gesturechange', 'gestureend'];
  // passive:false 是必须的：默认 passive 的监听里 preventDefault 会被浏览器忽略并警告
  for (const k of kinds) document.addEventListener(k, stop, { passive: false });
  const prevTouchAction = document.body.style.touchAction;
  document.body.style.touchAction = 'manipulation';

  return () => {
    for (const k of kinds) document.removeEventListener(k, stop);
    document.body.style.touchAction = prevTouchAction;
  };
}
