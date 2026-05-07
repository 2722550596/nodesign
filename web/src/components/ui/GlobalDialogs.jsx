import { useGlobalStore } from '../../stores/globalStore.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import PromptDialog from './PromptDialog.jsx';

/**
 * 根挂载组件 —— 监听 globalStore 的 confirmDialog / promptDialog state，
 * 渲染对应的 Modal。callsite 用 useGlobalStore.confirm({ ... }) / .prompt({ ... })
 * 命令式调用，await 拿结果。
 */
export default function GlobalDialogs() {
  const confirmDialog = useGlobalStore(s => s.confirmDialog);
  const promptDialog = useGlobalStore(s => s.promptDialog);
  const closeConfirmDialog = useGlobalStore(s => s.closeConfirmDialog);
  const closePromptDialog = useGlobalStore(s => s.closePromptDialog);

  return (
    <>
      <ConfirmDialog
        show={!!confirmDialog}
        title={confirmDialog?.title}
        message={confirmDialog?.message}
        confirmLabel={confirmDialog?.confirmLabel}
        cancelLabel={confirmDialog?.cancelLabel}
        danger={confirmDialog?.danger}
        onConfirm={() => closeConfirmDialog(true)}
        onCancel={() => closeConfirmDialog(false)}
      />
      <PromptDialog
        show={!!promptDialog}
        title={promptDialog?.title}
        message={promptDialog?.message}
        initialValue={promptDialog?.initialValue}
        placeholder={promptDialog?.placeholder}
        confirmLabel={promptDialog?.confirmLabel}
        cancelLabel={promptDialog?.cancelLabel}
        validate={promptDialog?.validate}
        multiline={promptDialog?.multiline}
        onConfirm={(v) => closePromptDialog(v)}
        onCancel={() => closePromptDialog(null)}
      />
    </>
  );
}
