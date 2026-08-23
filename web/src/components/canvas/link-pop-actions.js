/**
 * link-pop-actions —— 连线浮层的落盘动作（2026-08-23 从 BoardCanvas 抽出）
 *
 * LinkPopover 只管选语义/材质/写一句 label；这里把它的结果变成 bindings 的
 * 本地态更新 + PATCH。抽出来的直接原因是行数棘轮，但它本来也该单独住：
 * 同一份「创建 / 改 / 删一条线」逻辑以后右键菜单、快捷键都会用。
 */
import { Assets } from '../../lib/api.js';

export function submitLinkPop({ linkPop, bindings, setBindings, projectId }, { type, label, material }) {
  const mat = material && material !== 'ink' ? { material } : {};
  if (linkPop.mode === 'edit') {
    const old = bindings[linkPop.bindingId];
    if (!old) return;
    const b = { ...old, type, by: old.by || 'user', ...mat };
    if (label) b.label = label; else delete b.label;
    if (!mat.material) delete b.material;
    setBindings(prev => ({ ...prev, [linkPop.bindingId]: b }));
    Assets.patchBoard(projectId, { bindings: { [linkPop.bindingId]: b } }).catch(() => {});
    return;
  }
  const id = `b:${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
  const b = { type, from: linkPop.from.id, to: linkPop.to.id, by: 'user', ...(label ? { label } : {}), ...mat };
  setBindings(prev => ({ ...prev, [id]: b }));
  Assets.patchBoard(projectId, { bindings: { [id]: b } }).catch(() => {});
}

export function deleteLinkPop({ linkPop, setBindings, projectId }) {
  setBindings(prev => { const n = { ...prev }; delete n[linkPop.bindingId]; return n; });
  Assets.patchBoard(projectId, { bindings: { [linkPop.bindingId]: null } }).catch(() => {});
}
