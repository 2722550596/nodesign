/**
 * useMeasuredSize —— 文字类物件的真实高度回写（2026-08-23）
 *
 * 手写字 / md 节点 / 板书的 `layout.h` 是服务端落位时**估**的（字数 × 行高），渲染
 * 出来的真高度可能差一倍（08-23 实测：估 123px 渲 60px）。估值被三处消费：关系线端点
 * （箭头起点落到字下面一截空白）、排布避让（行距撑成两倍）、read_board 的尺寸。所以
 * 渲染完量一下真值，差超过 6px 就回写 layout —— 写一次就稳了，估值只管"第一次落在哪"。
 *
 * 量的是元素 offsetHeight：它在相机变换的容器里，offset* 是布局尺寸，不受 transform
 * 影响，单位就是世界像素。旋转/缩放过的墨类不回写（那两个字段让 box 不等于布局尺寸）。
 */
import { useEffect, useRef } from 'react';

export function useMeasuredSize(ref, o, onMeasured, deps = []) {
  const last = useRef(0);
  useEffect(() => {
    if (!onMeasured || !ref.current) return;
    if (o?.data?.rotation || (o?.data?.scale && o.data.scale !== 1)) return;
    const el = ref.current;
    const measure = () => {
      const h = Math.round(el.offsetHeight);
      if (!h || h === last.current) return;
      last.current = h;
      if (Math.abs(h - (o.pos?.h || 0)) > 6) onMeasured(o.id, { h });
    };
    // 字体/KaTeX/mermaid 异步到位：量两拍
    measure();
    const t = setTimeout(measure, 600);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => { clearTimeout(t); ro?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o?.id, o?.pos?.w, ...deps]);
}
