import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Send } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SANS, FONT_KAI, FONT_SIZE } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, GRAIN } from '../../lib/paper.js';
import { isImeEnter } from '../../lib/helpers.js';

/**
 * AnnotatePopover —— 就地标注（2026-08-13，E3）。
 *
 * 右键一个画布物件/文件夹 →「标注给 agent」→ 在点的位置浮出这张小纸：
 * 写一句话，按发送，agent 立刻起一轮来处理。取代旧的「让 agent 改它」
 * （那个只是往输入框里垫半句话，用户还得自己走到聊天栏把话说完 ——
 * 用户要的是"在东西上说完，agent 就来"）。
 *
 * 位置/portal/关闭规则照 ContextMenu：屏幕坐标 fixed、portal 到 body
 * （画布 section 的 isolation 会把 z-index 关在里面）、贴边翻转、
 * Esc / 点别处关掉。
 */

const POP_W = 264;

export default function AnnotatePopover({ x, y, target, onSubmit, onClose }) {
  const ref = useRef(null);
  const [text, setText] = useState('');
  const [flip, setFlip] = useState({ x: false, y: false });

  useEffect(() => {
    setFlip({ x: x + POP_W + 8 > window.innerWidth, y: y + 150 + 8 > window.innerHeight });
  }, [x, y]);

  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // 捕获阶段：画布自己的 Esc 是"回上一层"，不拦住的话关个浮层顺便换了层
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onClose();
    onSubmit(t);
  };

  return createPortal((
    <div
      ref={ref}
      data-no-pan
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: flip.x ? undefined : x,
        right: flip.x ? window.innerWidth - x : undefined,
        top: flip.y ? undefined : y,
        bottom: flip.y ? window.innerHeight - y : undefined,
        width: POP_W, zIndex: 9000,
        background: PAPER.paper, backgroundImage: GRAIN,
        borderRadius: 2, boxShadow: PAPER_SHADOW.near,
        padding: GAP.md,
        animation: 'ndPopIn 120ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      <div style={{
        fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: COLOR.sub,
        marginBottom: GAP.sm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        标注 · {target.typeLabel}「{target.title}」
      </div>
      <textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();   // 画布的单键换工具不能在打字时触发
          // 同 ChatComposer 的惯例：Enter 发送、Shift+Enter 换行（IME 守卫必带）
          if (e.key === 'Enter' && !e.shiftKey) {
            if (isImeEnter(e)) return;
            e.preventDefault();
            submit();
          }
        }}
        placeholder="想怎么改 / 想让它变成什么…"
        style={{
          width: '100%', resize: 'none', boxSizing: 'border-box',
          border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.sm,
          padding: GAP.sm, outline: 'none',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, lineHeight: 1.6,
          color: COLOR.text, background: COLOR.bgWhite,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', marginTop: GAP.sm, gap: GAP.sm }}>
        <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.xs, color: COLOR.sub, flex: 1 }}>
          发送后 agent 立刻来处理
        </span>
        <button
          onClick={submit}
          disabled={!text.trim()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.md}px`,
            border: 'none', borderRadius: RADIUS.sm,
            background: text.trim() ? COLOR.text : COLOR.borderLt,
            color: PAPER.paper, cursor: text.trim() ? 'pointer' : 'default',
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
          }}
        >
          <Send size={12} /> 发给 agent
        </button>
      </div>
    </div>
  ), document.body);
}
