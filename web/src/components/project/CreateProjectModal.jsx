import { useState, useEffect } from 'react';
import Modal, { ModalFooter, modalInput, modalLabel, modalHint, modalInputFocus } from '../ui/Modal.jsx';
import { GAP } from '../../lib/theme.js';
import { useProjectStore } from '../../stores/projectStore.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * CreateProjectModal — 新建标准项目（Anthropic Projects 风格）
 *
 * 极简版：只填项目名 + 描述。提交后落 Hub（不直接进 Workspace）—— 让 Hub
 * 成为「持久能力的家」：用户在 Hub 配置 Memory / Instructions / Files，
 * 然后在 Hub 的输入框起第一个 session。
 *
 * 闪聊（一句话开聊）走另一条路：Home 顶部大输入框 → 自动建 kind=quick
 * 的项目 + 首跑 → 跳 Workspace。详见 Home.jsx 的 QuickEntry。
 */
export default function CreateProjectModal({ show, onClose, onCreated }) {
  const createProject = useProjectStore(s => s.createProject);
  const showToast = useGlobalStore(s => s.showToast);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (show) {
      setName('');
      setDescription('');
      setSubmitting(false);
    }
  }, [show]);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const proj = await createProject({
        name: name.trim() || '未命名项目',
        description: description.trim() || undefined,
        kind: 'project',
      });
      onCreated?.(proj);
      onClose?.();
    } catch (err) {
      showToast(`创建失败：${err.message}`, 'error');
      setSubmitting(false);
    }
  };

  return (
    <Modal show={show} onClose={onClose} title="新建项目" width={520}>
      <div style={{ padding: `${GAP.lg}px ${GAP.xl}px ${GAP.xl}px` }}>

        <Section label="项目名">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="例如：Space Colony 歌词视觉"
            style={modalInput}
            {...modalInputFocus}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </Section>

        <Section label="项目描述（可选 · 只给你自己看的备忘）">
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="例如：这首歌的整套视觉，页面和图都放这里"
            rows={3}
            maxLength={2000}
            style={{ ...modalInput, resize: 'vertical', lineHeight: 1.7 }}
            {...modalInputFocus}
          />
        </Section>

        <div style={{ ...modalHint, marginTop: GAP.lg }}>
          创建后会进入项目主页，在那里配置项目指引、上传参考素材，再起第一个会话。
        </div>
      </div>

      <ModalFooter
        onCancel={onClose}
        onConfirm={submit}
        confirmLabel={submitting ? '创建中…' : '创建并打开'}
        confirmDisabled={submitting}
      />
    </Modal>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: GAP.xl }}>
      <div style={modalLabel}>{label}</div>
      {children}
    </div>
  );
}
