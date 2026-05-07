import { useState, useEffect, useRef } from 'react';
import Modal, { ModalFooter } from './Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';

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
      e.preventDefault();
      submit();
    }
  };

  return (
    <Modal show={show} onClose={onCancel} title={title} width={460}>
      <div style={{ padding: `${GAP.lg}px ${GAP.xl}px ${GAP.xl}px` }}>
        {message && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2,
            lineHeight: 1.6, marginBottom: GAP.md, whiteSpace: 'pre-wrap',
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
            style={{
              width: '100%', padding: `${GAP.sm}px ${GAP.md}px`,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, color: COLOR.text,
              background: 'rgba(0,0,0,0.02)',
              border: `1px solid ${error ? COLOR.error : COLOR.borderMd}`,
              borderRadius: 8, outline: 'none', resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        ) : (
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder}
            style={{
              width: '100%', padding: `${GAP.sm + 1}px ${GAP.md}px`,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text,
              background: 'rgba(0,0,0,0.02)',
              border: `1px solid ${error ? COLOR.error : COLOR.borderMd}`,
              borderRadius: 8, outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        )}
        {error && (
          <div style={{
            marginTop: GAP.sm,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.error,
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
