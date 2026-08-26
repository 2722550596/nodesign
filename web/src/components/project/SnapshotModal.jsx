import { useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { timeAgo } from '../../lib/helpers.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Canvas } from '../../lib/api.js';

/**
 * SnapshotModal — 项目版本历史（git history 的真实前端）
 *
 * 2026-08-25 从 P0 mock 转真：服务端每轮 agent turn 结束 / 用户改画布 /
 * 移动重命名资产都会自动 git commit（projects/workspace.js commitWorkspace），
 * 这里列的就是 git log，恢复 = git checkout + 新 commit（非破坏，可再滚回）。
 *
 * 设计意图来自 projectStore：『快照 = git commit，恢复 = git checkout
 * （C9 加 history UI）』—— C9 就是本面板。
 *
 * 注意：gitignore 掉的内容（画布布局 board.json、.nd/、assets/generated 等）
 * 不会随回滚变动 —— 回滚只动"产物"，不动布局和演出记录。
 */
function prettyMessage(message) {
  // 'turn success: <ISO>' / 'turn cancelled: <ISO>' / 'user-edit: <ISO>' / 'revert to <short>'
  const turn = message.match(/^turn (success|cancelled):/);
  if (turn) return turn[1] === 'success' ? 'agent 完成一轮' : 'agent 轮次被取消';
  const edit = message.match(/^(user|agent)-edit:/);
  if (edit) return `${edit[1] === 'user' ? '手动' : 'agent'}编辑画布`;
  if (/^revert to /.test(message)) return '回滚操作';
  if (/^(move|rename):/.test(message)) return '资产移动/重命名';
  return message;
}

export default function SnapshotModal({ show, onClose, project, onRestored }) {
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyHash, setBusyHash] = useState(null);

  useEffect(() => {
    if (!show || !project) return;
    let cancelled = false;
    setLoading(true);
    Canvas.history(project.id)
      .then(({ entries = [] } = {}) => { if (!cancelled) setEntries(entries); })
      .catch((err) => {
        if (!cancelled) showToast(`版本历史加载失败：${err?.message || err}`, 'error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [show, project, showToast]);

  async function handleRestore(entry) {
    if (!project || busyHash) return;
    if (!(await confirm({
      title: '恢复此版本',
      message: `恢复到 ${entry.hash.slice(0, 7)}（${timeAgo(entry.date)}）？\n\n这会撤销此后对产物的所有改动，并生成一个新的回滚记录（可再次回滚）。画布布局不会变动。`,
      confirmLabel: '恢复',
      danger: true,
    }))) return;
    setBusyHash(entry.hash);
    try {
      await Canvas.revert(project.id, entry.hash);
      showToast(`已恢复到 ${entry.hash.slice(0, 7)}`, 'success');
      onRestored?.(entry);
      // 回滚本身会落一个新 commit —— 刷新列表让用户看到回滚记录
      const fresh = await Canvas.history(project.id);
      setEntries(fresh.entries || []);
    } catch (err) {
      showToast(`恢复失败：${err?.message || err}`, 'error');
    } finally {
      setBusyHash(null);
    }
  }

  return (
    <Modal show={show} onClose={onClose} title="版本历史" width={560}>
      <div style={{ padding: GAP.xl }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: GAP.sm,
          marginBottom: GAP.md,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          lineHeight: 1.6,
        }}>
          <History size={12} style={{ flexShrink: 0 }} />
          每轮工作结束自动保存一个版本。恢复 = 回到该版本并生成新的回滚记录，
          可随时再滚回来。画布布局与演出记录不随回滚变动。
        </div>

        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          textTransform: 'uppercase', letterSpacing: '0.05em',
          marginBottom: GAP.sm,
        }}>
          版本 ({entries.length})
        </div>

        {loading ? (
          <div style={{
            padding: GAP.xl, textAlign: 'center',
            border: `1px dashed ${COLOR.borderMd}`, borderRadius: RADIUS.lg,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          }}>
            加载中…
          </div>
        ) : entries.length === 0 ? (
          <div style={{
            padding: GAP.xl, textAlign: 'center',
            border: `1px dashed ${COLOR.borderMd}`, borderRadius: RADIUS.lg,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          }}>
            还没有版本记录。agent 每完成一轮会自动保存一个。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm, maxHeight: 360, overflowY: 'auto' }}>
            {entries.map((entry) => (
              <HistoryRow
                key={entry.hash}
                entry={entry}
                busy={busyHash === entry.hash}
                onRestore={() => handleRestore(entry)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function HistoryRow({ entry, busy, onRestore }) {
  const author = entry.author === 'agent' ? 'agent' : '用户';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: GAP.md,
      padding: `${GAP.sm}px ${GAP.md}px`,
      background: COLOR.bgCard,
      border: `1px solid ${COLOR.borderLt}`,
      borderRadius: RADIUS.md,
    }}>
      <span style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        flexShrink: 0, width: 52,
      }}>
        {entry.hash.slice(0, 7)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {prettyMessage(entry.message)}
        </div>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          marginTop: 2,
        }}>
          {timeAgo(entry.date)} · {author}
        </div>
      </div>
      <button
        onClick={onRestore}
        disabled={busy}
        title="恢复到该版本（撤销其后的所有产物改动）"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: `${GAP.xs}px ${GAP.md}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
          color: COLOR.text2, background: COLOR.bgWhite,
          border: `1px solid ${COLOR.border}`,
          borderRadius: RADIUS.md,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.6 : 1,
          flexShrink: 0,
        }}
      >
        <RotateCcw size={11} />
        {busy ? '恢复中…' : '恢复此版本'}
      </button>
    </div>
  );
}
