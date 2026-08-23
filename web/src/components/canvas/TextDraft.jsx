/**
 * TextDraft —— 画布上的文字输入框（2026-08-23 从 BoardCanvas 抽出，并加就地编辑档）
 *
 * 两种用法：
 *   - 新建：双击空地落一张 260 宽的小纸卡，sans 字，⌘/Ctrl+Enter 落笔，Esc 取消，点别处=提交
 *   - 就地编辑（inPlace）：框的宽度 / 字体 / 字号 / 墨色跟被改的那块完全一致（世界尺寸 × 相机
 *     缩放），没有卡片外观，看起来就是在原位改字。板书（md）和手写字都走这条。
 * 坐标在视口空间（不在世界层里），所以尺寸都要乘相机缩放。
 */
import { useEffect, useRef, useState } from 'react';
import { GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';
import { PAPER, paperCard } from '../../lib/paper.js';
import { POP_IN } from '../../lib/board-geometry.js';

export default function TextDraft({ screen, onCommit, onCancel, placeholder = '写点什么…（⌘/Ctrl+Enter 落笔）', initial = '', inPlace = null }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  // 「点别处 = 提交」靠 onBlur 实现，但**创建它的那一次点击自己就会触发 blur**：
  // mousedown 开框 → 自动聚焦 → 同一次点击的 mouseup 把焦点抢回画布 → blur →
  // 当成"写完了"，空内容，框当场消失。所以 blur 要等这一拍过去才算数。
  const settledRef = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    // 就地编辑：光标放到末尾，高度撑到内容
    if (inPlace && ref.current) { const el = ref.current; el.selectionStart = el.selectionEnd = el.value.length; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
    const t = setTimeout(() => { settledRef.current = true; }, 150);
    return () => clearTimeout(t);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const autoGrow = (el) => { if (!inPlace || !el) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  return (
    <div
      data-no-pan
      onPointerDown={(e) => e.stopPropagation()}
      style={inPlace ? {
        position: 'absolute', left: screen.x, top: screen.y, zIndex: 420,
        width: Math.max(120, inPlace.width),
        // 原位：没有卡片，只一道极淡的底色和描边提示"在编辑"
        background: 'rgba(255,254,246,0.82)', borderRadius: 6,
        boxShadow: '0 0 0 1px rgba(176,140,79,0.45)',
        padding: '4px 6px',
      } : {
        position: 'absolute', left: screen.x, top: screen.y,
        zIndex: 420, width: 260,
        ...paperCard('near'), padding: GAP.sm,
        animation: POP_IN,
      }}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => { setValue(e.target.value); autoGrow(e.target); }}
        onBlur={() => { if (settledRef.current) onCommit(value); else ref.current?.focus(); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(value); }
        }}
        placeholder={placeholder}
        rows={inPlace ? 1 : 3}
        style={{
          width: '100%', border: 'none', outline: 'none', resize: 'none', display: 'block',
          background: 'transparent', color: inPlace?.color || PAPER.ink,
          fontFamily: inPlace?.fontFamily || FONT_SANS,
          fontSize: inPlace?.fontSize || FONT_SIZE.sm, lineHeight: 1.6,
          overflow: 'hidden',
        }}
      />
    </div>
  );
}
