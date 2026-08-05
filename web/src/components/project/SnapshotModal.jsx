import { useState } from 'react';
import { Camera, RotateCcw, Trash2, Edit2, Plus } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { timeAgo, isImeEnter } from '../../lib/helpers.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * SnapshotModal — 项目版本快照管理
 *
 * Claude_design §11：自然语言触发的 checkpoint，让用户在尝试新方向前保存当前状态。
 * P2：metadata-only mock；P3 后端起来后 saveSnapshot 真存 HTML+spec 快照。
 */
export default function SnapshotModal({ show, onClose, project, onSave, onRestore, onDelete, onRename }) {
  const [newLabel, setNewLabel] = useState('');

  if (!project) return null;
  const snapshots = project.snapshots || [];

  const handleSave = () => {
    onSave?.(newLabel.trim() || `快照 ${snapshots.length + 1}`);
    setNewLabel('');
  };

  return (
    <Modal show={show} onClose={onClose} title="项目快照" width={560}>
      <div style={{ padding: GAP.xl }}>

        {/* 新建快照 */}
        <div style={{
          padding: GAP.lg,
          background: COLOR.bgCard,
          border: `1px solid ${COLOR.borderLt}`,
          borderRadius: RADIUS.xl,
          marginBottom: GAP.xl,
        }}>
          <div style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            textTransform: 'uppercase', letterSpacing: '0.05em',
            marginBottom: GAP.sm,
          }}>
            保存当前状态
          </div>
          <div style={{ display: 'flex', gap: GAP.sm }}>
            <input
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="快照名（例如：探索两栏布局前）"
              onKeyDown={e => { if (e.key === 'Enter' && !isImeEnter(e)) handleSave(); }}
              style={{
                flex: 1,
                padding: `${GAP.sm}px ${GAP.md}px`,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
                color: COLOR.text,
                background: COLOR.bgWhite,
                boxShadow: PAPER_SHADOW.far,
                borderRadius: RADIUS.md,
                outline: 'none',
              }}
            />
            <button
              onClick={handleSave}
              style={{
                padding: `${GAP.sm}px ${GAP.lg}px`,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
                color: COLOR.btnText, background: COLOR.btn,
                border: `1px solid ${COLOR.btn}`,
                borderRadius: RADIUS.md,
                cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              }}
            >
              <Camera size={12} /> 保存
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          textTransform: 'uppercase', letterSpacing: '0.05em',
          marginBottom: GAP.sm,
        }}>
          历史快照 ({snapshots.length})
        </div>

        {snapshots.length === 0 ? (
          <div style={{
            padding: GAP.xl, textAlign: 'center',
            border: `1px dashed ${COLOR.borderMd}`,
            borderRadius: RADIUS.lg,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          }}>
            还没有快照。试试在尝试新方向前保存一个。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm, maxHeight: 320, overflowY: 'auto' }}>
            {snapshots.map(sn => (
              <SnapshotRow
                key={sn.id}
                snapshot={sn}
                onRestore={() => onRestore?.(sn)}
                onDelete={() => onDelete?.(sn)}
                onRename={(label) => onRename?.(sn.id, label)}
              />
            ))}
          </div>
        )}

        <div style={{
          marginTop: GAP.lg,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          lineHeight: 1.5,
        }}>
          ⓘ P2 mock：当前只存 metadata，恢复也只是 toast。P3 后端起来后真存 HTML + spec 快照可回滚。
        </div>
      </div>
    </Modal>
  );
}

function SnapshotRow({ snapshot, onRestore, onDelete, onRename }) {
  const prompt = useGlobalStore(s => s.prompt);
  const confirm = useGlobalStore(s => s.confirm);

  const handleRename = async () => {
    const next = await prompt({
      title: '重命名快照',
      initialValue: snapshot.label,
      placeholder: '快照名',
    });
    if (next && next.trim() && next !== snapshot.label) onRename(next.trim());
  };

  const handleDelete = async () => {
    if (await confirm({
      title: '删除快照',
      message: `删除快照「${snapshot.label}」？`,
      confirmLabel: '删除',
      danger: true,
    })) onDelete();
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: GAP.md,
      padding: `${GAP.md}px ${GAP.lg}px`,
      background: COLOR.bgWhite,
      boxShadow: PAPER_SHADOW.far,
      borderRadius: 2,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: RADIUS.md,
        background: COLOR.bgCard,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Camera size={12} color={COLOR.text4} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{snapshot.label}</div>
        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 1 }}>
          {timeAgo(snapshot.createdAt)} · {snapshot.summary}
        </div>
      </div>

      <button onClick={handleRename} style={iconBtn} title="重命名"><Edit2 size={11} /></button>
      <button onClick={onRestore} style={iconBtn} title="恢复（mock）"><RotateCcw size={11} /></button>
      <button
        onClick={handleDelete}
        style={iconBtnDanger}
        title="删除"
      ><Trash2 size={11} /></button>
    </div>
  );
}

const iconBtn = {
  width: 26, height: 26, borderRadius: RADIUS.sm,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  color: COLOR.sub,
  background: 'transparent',
  cursor: 'pointer',
  flexShrink: 0,
};
const iconBtnDanger = { ...iconBtn };
