import { useEffect, useState } from 'react';
import { FileCode, Image as ImageIcon, FileText, Download, Globe } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, CANVAS, alpha } from '../../lib/theme.js';
import { Exports } from '../../lib/api.js';

/**
 * PickExportModal — 挑着导出（2026-07-28）
 *
 * 导出菜单原本只有"整包"四个格式。用户要的其实经常是"就那三张图"或"只要这份
 * deck"，所以这里列出当前任务真正产出的东西：任务目录里的文件 + deck 引用到的图。
 * 勾选后单个文件直接下，多个自动打成一个 zip。
 */

const KIND_ICON = { deck: FileCode, 'site-page': Globe, image: ImageIcon, file: FileText };

function sizeText(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function PickExportModal({ open, onClose, projectId, sessionId, onToast }) {
  const [items, setItems] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !projectId || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    Exports.items(projectId, sessionId)
      .then(({ items: list = [], kind = null }) => {
        if (cancelled) return;
        setItems(list);
        // deck：默认勾 deck 本身（最常见意图＝"把这份 deck 给我"）。
        // 站点：默认全勾 —— 只勾 .html 会漏掉 style.css 和图，用户下下来解压打开
        // 是一张没有样式的白页，还查不出是导出漏了。试作（_drafts/）不默认勾。
        setPicked(new Set(
          kind === 'site'
            ? list.filter(i => i.kind !== 'draft').map(i => i.path)
            : list.filter(i => i.kind === 'deck').map(i => i.path),
        ));
      })
      .catch(err => { if (!cancelled) onToast?.(`读取产物失败：${err.message}`, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, sessionId, onToast]);

  if (!open) return null;

  const toggle = (p) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });

  const total = items.filter(i => picked.has(i.path)).reduce((a, i) => a + (i.size || 0), 0);

  const download = async () => {
    if (picked.size === 0) return;
    setBusy(true);
    try {
      const { blob, filename } = await Exports.pick(projectId, sessionId, [...picked]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'export';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onToast?.(`已下载：${a.download}`, 'success');
      onClose?.();
    } catch (err) {
      onToast?.(`导出失败：${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal show={open} onClose={onClose} title="挑着导出" width={520}>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, marginBottom: GAP.md }}>
        当前任务的产物。选一个直接下，选多个打成一个 zip。
        <span style={{ marginLeft: GAP.sm }}>要自包含 HTML / PDF / PPTX 走上面的整包格式。</span>
      </div>

      {loading && <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>读取中…</div>}
      {!loading && items.length === 0 && (
        <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
          这个会话还没有产物。
        </div>
      )}

      <div style={{ maxHeight: '46vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: GAP.xxs }}>
        {items.map((it) => {
          const Icon = KIND_ICON[it.kind] || FileText;
          const on = picked.has(it.path);
          return (
            <label
              key={it.path}
              style={{
                display: 'flex', alignItems: 'center', gap: GAP.md,
                padding: `${GAP.sm}px ${GAP.md}px`,
                borderRadius: RADIUS.md, cursor: 'pointer',
                background: on ? alpha(CANVAS.brass, 0.10) : 'transparent',
                border: `1px solid ${on ? alpha(CANVAS.brass, 0.35) : 'transparent'}`,
              }}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(it.path)} style={{ accentColor: CANVAS.brass }} />
              <Icon size={13} color={COLOR.text4} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.name}
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{sizeText(it.size)}</span>
            </label>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: GAP.lg }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
          已选 {picked.size} 项 · {sizeText(total)}
        </span>
        <button
          onClick={download}
          disabled={picked.size === 0 || busy}
          style={{
            display: 'flex', alignItems: 'center', gap: GAP.sm,
            padding: `${GAP.sm}px 14px`, borderRadius: 7,
            border: 'none', background: picked.size === 0 || busy ? COLOR.borderMd : COLOR.text,
            color: COLOR.bgWhite, fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
            cursor: picked.size === 0 || busy ? 'not-allowed' : 'pointer',
          }}
        >
          <Download size={13} /> {busy ? '打包中…' : '下载'}
        </button>
      </div>
    </Modal>
  );
}
