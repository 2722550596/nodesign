import { useState, useEffect, useCallback } from 'react';
import { Lock, Pencil, Trash2, Paperclip, ChevronDown, ChevronRight } from 'lucide-react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Memory } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

// 模块级常量空数组：给 useGlobalStore selector 当 fallback。
// 字面量 `[]` 每次 selector 调用都是新引用 → React 19 useSyncExternalStore
// 在 render 后再 getSnapshot 检测到 snapshot 引用变化 → 强制 re-render →
// 又新 `[]` → 死循环 ("Maximum update depth exceeded")。zustand 5 经典坑。
const EMPTY_RECALL_HISTORY = [];

/**
 * MemoryCard —— Hub 右栏卡片：项目级 agent memory 概要
 *
 * mount 列所有 agent 的 memory 概要（含 _root 顶层 + 各 agentType 子目录）。
 * 点铅笔弹 modal 编辑（用户可覆盖 agent 写的长期记忆）；点 🗑 删整个 agent
 * 子目录。
 *
 * 数据落 shared/.claude/agent-memory/，agent 通过软链 / additionalDirectories
 * 跨 session 共享读写。
 */
export default function MemoryCard({ projectId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const addPendingMemoryRecall = useGlobalStore(s => s.addPendingMemoryRecall);
  const recallHistory = useGlobalStore(s => s.recallHistoryByProject[projectId] || EMPTY_RECALL_HISTORY);
  const [memory, setMemory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingType, setEditingType] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * 主动 recall：把 agentType 的 memory 全文加进 pendingMemoryRecalls store。
   * ProjectHub composer 提交时会自动 prepend 到 chat 文本。
   */
  const handleAttach = useCallback(async (agentType) => {
    const at = agentType || '_root';
    try {
      const result = await Memory.read(projectId, at);
      const content = (result?.content || '').trim();
      if (!content) {
        showToast(`「${agentType || 'main'}」memory 是空的`, 'warn');
        return;
      }
      addPendingMemoryRecall({ agentType: agentType || null, content });
      showToast(`已加到下条消息：${agentType || 'main'} memory`, 'success');
    } catch (err) {
      showToast(`读取失败：${err.message}`, 'error');
    }
  }, [projectId, addPendingMemoryRecall, showToast]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await Memory.list(projectId);
      // 过滤 'brand' agentType — 它由独立的 BrandCard 管理（同一份后端文件夹但
      // 概念上是「品牌档案」，不是 agent 自由记忆，避免在两个 card 重复出现）
      const filtered = (result?.memory || []).filter(m => m.agentType !== 'brand');
      setMemory(filtered);
    } catch (err) {
      console.warn('[MemoryCard] list failed:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (agentType) => {
    const label = agentType || 'main agent';
    if (!(await confirm({
      title: '删除 memory',
      message: `删除「${label}」的 memory？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await Memory.remove(projectId, agentType || '_root');
      showToast('已删除', 'info');
      await refresh();
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  return (
    <>
      <div style={cardStyle}>
        <div style={cardHeader}>
          <span style={cardTitle}>记忆</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: `1px ${GAP.sm}px`,
              background: 'rgba(45,36,24,0.05)',
              borderRadius: RADIUS.sm,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            }}>
              <Lock size={10} /> 仅你可见
            </span>
            <button
              onClick={() => setEditingType('_root')}
              title="编辑顶层 memory（main agent）"
              style={iconBtnStyle}
            >
              <Pencil size={13} />
            </button>
          </div>
        </div>

        {loading && <div style={emptyHint}>加载中…</div>}

        {!loading && memory.length === 0 && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            lineHeight: 1.55,
          }}>
            agent 在 session 中按需记录的长期记忆。还没有内容。
          </div>
        )}

        {!loading && memory.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
            {memory.map(m => (
              <MemoryRow
                key={m.agentType || '_root'}
                entry={m}
                onEdit={() => setEditingType(m.agentType || '_root')}
                onDelete={() => handleDelete(m.agentType)}
                onAttach={() => handleAttach(m.agentType)}
              />
            ))}
          </div>
        )}

        {/* SDK 自动 recall 历史（折叠区）。recallHistory 来自 globalStore，
            每次 run.memory_recall 事件追加一条。in-memory，重启清空。 */}
        {recallHistory.length > 0 && (
          <div style={{
            marginTop: GAP.sm,
            paddingTop: GAP.sm,
            borderTop: `1px dashed ${COLOR.borderLt}`,
          }}>
            <button
              onClick={() => setHistoryOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: GAP.xs,
                padding: 0,
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
              }}
            >
              {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              最近自动召回 · {recallHistory.length}
            </button>
            {historyOpen && (
              <div style={{ marginTop: GAP.xs, display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
                {recallHistory.slice(0, 10).map((h, i) => (
                  <div key={i} style={{
                    fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                    lineHeight: 1.5,
                    padding: `${GAP.xxs}px ${GAP.sm}px`,
                    background: 'rgba(43,33,23,0.02)',
                    borderRadius: RADIUS.sm,
                  }}>
                    <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>
                      {h.mode || 'recall'}
                    </span>
                    {' · '}
                    {(h.memories || []).map(m => m.path || m.scope || '?').join(', ').slice(0, 80)}
                    {(h.memories || []).length === 0 && '(无 memories 字段)'}
                  </div>
                ))}
                {recallHistory.length > 10 && (
                  <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
                    …还有 {recallHistory.length - 10} 条
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <MemoryEditModal
        show={!!editingType}
        onClose={() => setEditingType(null)}
        projectId={projectId}
        agentType={editingType}
        onSaved={() => refresh()}
      />
    </>
  );
}

function MemoryRow({ entry, onEdit, onDelete, onAttach }) {
  const [hover, setHover] = useState(false);
  // 'auto' = SDK 自己攒的自动记忆（autoMemoryDirectory 指到这里），
  // 'main' = 用户 / agent 手写的那份偏好
  const label = entry.agentType === 'auto' ? 'agent 自动记忆' : (entry.agentType || '手写偏好');
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: `${GAP.xs + 1}px ${GAP.sm}px`,
        borderRadius: RADIUS.md,
        background: hover ? 'rgba(43,33,23,0.025)' : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        marginBottom: GAP.xxs,
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
          color: COLOR.text,
          flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        }}>
          {formatSize(entry.size)}
        </span>
        {hover && (
          <>
            {onAttach && (
              <button onClick={onAttach} title="加到下条消息（让 agent 看到这段记忆）" style={miniBtn}>
                <Paperclip size={11} />
              </button>
            )}
            <button onClick={onEdit} title="编辑" style={miniBtn}>
              <Pencil size={11} />
            </button>
            <button onClick={onDelete} title="删除" style={miniBtn}>
              <Trash2 size={11} color={COLOR.error} />
            </button>
          </>
        )}
      </div>
      {entry.preview && (
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          lineHeight: 1.5,
          overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {entry.preview.replace(/\s+/g, ' ').trim()}
        </div>
      )}
    </div>
  );
}

function MemoryEditModal({ show, onClose, projectId, agentType, onSaved }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!show || !agentType) return;
    setLoading(true);
    Memory.read(projectId, agentType)
      .then(r => {
        setContent(r?.content || '');
        setInitialContent(r?.content || '');
      })
      .catch(err => showToast(`读取失败：${err.message}`, 'error'))
      .finally(() => setLoading(false));
  }, [show, projectId, agentType, showToast]);

  const dirty = content !== initialContent;
  const label = agentType === '_root' ? 'main agent' : agentType;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await Memory.write(projectId, agentType, content);
      onSaved?.();
      showToast('memory 已保存', 'success');
      onClose?.();
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal show={show} onClose={onClose} title={`记忆 — ${label || ''}`} width={680}>
      <div style={{ padding: `${GAP.md}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.md }}>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          lineHeight: 1.55,
        }}>
          agent 在 session 中按需写入的长期记忆，跨 session 共享。
          你可以手动覆盖这份内容（或删整个文件），下一轮 session agent 自动看到。
        </div>
        <textarea
          value={loading ? '加载中…' : content}
          disabled={loading}
          onChange={e => setContent(e.target.value)}
          placeholder="（空 — agent 还没记录任何 memory）"
          style={{
            width: '100%',
            minHeight: 360,
            padding: GAP.md,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
            color: COLOR.text, lineHeight: 1.55,
            background: COLOR.bgWhite,
            boxShadow: PAPER_SHADOW.far,
            borderRadius: 2,
            outline: 'none',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      </div>
      <ModalFooter
        onCancel={onClose}
        onConfirm={save}
        confirmDisabled={!dirty || saving || loading}
        confirmLabel={saving ? '保存中…' : '保存'}
      />
    </Modal>
  );
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const cardStyle = {
  background: COLOR.bgWhite,
  boxShadow: PAPER_SHADOW.far,
  borderRadius: 2,
  padding: GAP.lg,
};
const cardHeader = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: GAP.sm,
  marginBottom: GAP.sm,
};
const cardTitle = {
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
  color: COLOR.text,
};
const iconBtnStyle = {
  width: 24, height: 24, borderRadius: RADIUS.sm,
  background: 'transparent', border: 'none',
  color: COLOR.text2,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
};
const miniBtn = {
  width: 18, height: 18, borderRadius: RADIUS.xs,
  background: 'transparent', border: 'none', color: COLOR.sub,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
};
const emptyHint = {
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
};
