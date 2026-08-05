import { useState, useEffect, useRef } from 'react';
import Modal, { ModalFooter, modalInput, modalInputFocus } from './Modal.jsx';
import { GAP, FONT_SIZE } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';
import { isImeEnter } from '../../lib/helpers.js';

/**
 * 站内输入对话框（替代 window.prompt）
 *
 * 通常通过 useGlobalStore.prompt({ ... }) 命令式调用，由 <GlobalDialogs /> 渲染。
 * 也可独立 import 用作受控组件。
 *
 * @param {string} initialValue   预填值
 * @param {fn}     validate(v)    返 null/undefined 表示通过；返 string 显示错误并禁用确认
 * @param {bool}   multiline      true → textarea，false → input
 */
export default function PromptDialog({
  show,
  title = '请输入',
  message = '',
  initialValue = '',
  placeholder = '',
  confirmLabel = '确认',
  cancelLabel = '取消',
  validate,
  multiline = false,
  onConfirm,
  onCancel,
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef(null);

  // show 切到 true 时重置 value 并 focus
  useEffect(() => {
    if (show) {
      setValue(initialValue);
      // Modal 入场后再 focus
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select?.();
      }, 50);
      return () => clearTimeout(t);
    }
  }, [show, initialValue]);

  const error = validate ? validate(value) : null;
  const submit = () => { if (!error) onConfirm?.(value); };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !multiline && !e.shiftKey) {
      if (isImeEnter(e)) return;
      e.preventDefault();
      submit();
    }
  };

  return (
    <Modal show={show} onClose={onCancel} title={title} width={460}>
      <div style={{ padding: `${GAP.lg}px ${GAP.xl}px ${GAP.xl}px` }}>
        {message && (
          <div style={{
            fontSize: FONT_SIZE.xl, color: PAPER.ink2,
            lineHeight: 1.85, marginBottom: GAP.lg, whiteSpace: 'pre-wrap',
          }}>
            {message}
          </div>
        )}
        {multiline ? (
          <textarea
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={placeholder}
            rows={4}
            {...modalInputFocus}
            style={{
              ...modalInput, resize: 'vertical', lineHeight: 1.7,
              borderBottomColor: error ? PAPER.red : PAPER.hair,
            }}
          />
        ) : (
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder}
            {...modalInputFocus}
            style={{ ...modalInput, borderBottomColor: error ? PAPER.red : PAPER.hair }}
          />
        )}
        {error && (
          <div style={{
            marginTop: GAP.sm,
            fontSize: FONT_SIZE.md, color: PAPER.red,
          }}>{error}</div>
        )}
      </div>
      <ModalFooter
        onCancel={onCancel}
        onConfirm={submit}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        confirmDisabled={!!error}
      />
    </Modal>
  );
}
