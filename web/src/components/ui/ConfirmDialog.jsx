import Modal, { ModalFooter } from './Modal.jsx';
import { GAP, FONT_SIZE } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';

/**
 * 站内确认对话框（替代 window.confirm）
 *
 * 通常通过 useGlobalStore.confirm({ ... }) 命令式调用，由 <GlobalDialogs /> 渲染。
 * 也可独立 import 用作受控组件。
 */
export default function ConfirmDialog({
  show,
  title = '确认',
  message = '',
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal show={show} onClose={onCancel} title={title} width={420}>
      <div style={{
        padding: `${GAP.lg}px ${GAP.xl}px ${GAP.xl}px`,
        fontSize: FONT_SIZE.xl, color: PAPER.ink2,
        lineHeight: 1.85, whiteSpace: 'pre-wrap',
      }}>
        {message}
      </div>
      <ModalFooter
        onCancel={onCancel}
        onConfirm={onConfirm}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        danger={danger}
      />
    </Modal>
  );
}
