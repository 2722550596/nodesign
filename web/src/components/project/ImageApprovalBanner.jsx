/**
 * ImageApprovalBanner — Phase Image-1：generate_image 完成后用户 approve gate
 *
 * 触发：run.image_generated 事件 → ProjectWorkspace setPendingImageApproval(...)
 *      → 本横幅显示
 *
 * P2 升级：request_image_approval MCP 工具调起时多张候选并排展示（paths 数组）。
 *
 * 设计：
 *   - **不是 modal**：右下角浮卡，不挡聊天 + 不挡 canvas
 *   - **3 个动作**：
 *     - 「OK 用」    → Image.approve → 后端注 system reminder："这张图可作 anchor"
 *     - 「重生 →    展开 textarea 写反馈 → Image.regenerate → 后端注 system reminder："用户要 conversational editing 改 X"
 *     - 「忽略」    → Image.dismiss → 不喂 agent，banner 消失
 *   - **30s 自动 dismiss**（可选）：用户没响应 = 默认放过
 *   - **路径走 /api/projects/:pid/sessions/:sid/assets/<rest>** 取 thumbnail（canvas.js 已加 endpoint）
 */
import { useEffect, useState } from 'react';
import { Image as ImageIcon, Check, RefreshCw, X } from 'lucide-react';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Image as ImageApi } from '../../lib/api.js';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';

const ROLE_LABEL = {
  cover: '封面图', hero: 'Hero 图', bg: '背景图', frame: '相框嵌入',
  icon: '图标', decoration: '装饰', portrait: '人像', illustration: '插画',
  'quote-backdrop': '引言衬底', 'section-divider': '章节扉页', pattern: '纹理',
};

export default function ImageApprovalBanner() {
  // 只订阅会触发渲染的 state；actions 走 getState() 规避 HMR 引用变化引发死循环
  const pendingImageApproval = useGlobalStore((s) => s.pendingImageApproval);
  const activeRun = useGlobalStore((s) => s.activeRun);
  // pid + sid 走 pendingImageApproval payload（ProjectWorkspace 注入），
  // activeRun 没有 sid 字段 ({pid, runId})。
  const projectId = pendingImageApproval?.pid || activeRun?.pid;
  const sessionId = pendingImageApproval?.sid;

  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 新 approval 来时 reset
  useEffect(() => {
    if (pendingImageApproval) {
      setShowFeedback(false);
      setFeedback('');
      setSubmitting(false);
    }
  }, [pendingImageApproval?.ts]);

  if (!pendingImageApproval) return null;

  const { paths = [], role, prompt, intent, requestedByAgent } = pendingImageApproval;
  if (paths.length === 0) return null;

  const handleApprove = async () => {
    if (!activeRun?.pid || !activeRun?.runId) return;
    const { showToast, clearPendingImageApproval } = useGlobalStore.getState();
    setSubmitting(true);
    try {
      await ImageApi.approve({
        pid: activeRun.pid, runId: activeRun.runId,
        paths, role,
      });
      showToast('已告知 agent：这张可继续作 referenceImages 种子', 'success');
      clearPendingImageApproval();
    } catch (err) {
      setSubmitting(false);
      showToast(`Approve 失败：${err.message}`, 'error');
    }
  };

  const handleRegenerate = async () => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    if (!activeRun?.pid || !activeRun?.runId) return;
    const { showToast, clearPendingImageApproval } = useGlobalStore.getState();
    setSubmitting(true);
    try {
      await ImageApi.regenerate({
        pid: activeRun.pid, runId: activeRun.runId,
        paths, role, feedback: feedback.trim(),
      });
      showToast('已让 agent 用 conversational editing 重生', 'info');
      clearPendingImageApproval();
    } catch (err) {
      setSubmitting(false);
      showToast(`Regenerate 失败：${err.message}`, 'error');
    }
  };

  const handleDismiss = async () => {
    const { clearPendingImageApproval } = useGlobalStore.getState();
    if (activeRun?.pid && activeRun?.runId) {
      try {
        await ImageApi.dismiss({
          pid: activeRun.pid, runId: activeRun.runId,
          paths, role,
        });
      } catch { /* ignore — dismiss 静默 */ }
    }
    clearPendingImageApproval();
  };

  const assetUrl = (path) => {
    if (!projectId || !sessionId) return '';
    // path 形如 'assets/generated/x.jpg' → endpoint 接 'assets/' 之后的子路径
    const sub = path.startsWith('assets/') ? path.slice('assets/'.length) : path;
    return `/api/projects/${projectId}/sessions/${sessionId}/assets/${sub}`;
  };

  return (
    <div style={{
      position: 'absolute',
      bottom: GAP.lg,
      right: GAP.lg,
      width: 360,
      maxWidth: '92vw',
      zIndex: 50,
      background: '#fff',
      border: `1px solid ${COLOR.borderMd}`,
      borderRadius: 12,
      boxShadow: '0 12px 36px rgba(0,0,0,0.18)',
      overflow: 'hidden',
      animation: 'imgApprovalSlide 220ms cubic-bezier(0.25,1,0.5,1)',
    }}>
      <style>{`
        @keyframes imgApprovalSlide {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* header */}
      <div style={{
        padding: `${GAP.sm}px ${GAP.md}px`,
        background: 'linear-gradient(135deg, #FFF4E5 0%, #FFEAD0 100%)',
        borderBottom: `1px solid ${COLOR.borderLt}`,
        display: 'flex', alignItems: 'center', gap: GAP.xs,
      }}>
        <ImageIcon size={14} color={COLOR.text2} />
        <div style={{
          flex: 1,
          fontFamily: FONT_MONO, fontSize: 10, color: COLOR.text2,
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          {requestedByAgent ? 'Agent 请求确认' : '新生成图片'}
        </div>
        {role && (
          <div style={{
            padding: '2px 6px',
            fontSize: 10, fontFamily: FONT_MONO,
            color: COLOR.text3,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 4,
          }}>
            {ROLE_LABEL[role] || role}
          </div>
        )}
      </div>

      {/* thumbnails */}
      <div style={{
        padding: GAP.sm,
        display: 'grid',
        gridTemplateColumns: paths.length === 1 ? '1fr' : `repeat(${Math.min(paths.length, 3)}, 1fr)`,
        gap: GAP.xs,
        background: '#fafafa',
      }}>
        {paths.slice(0, 3).map((p, i) => (
          <a
            key={p + i}
            href={assetUrl(p)}
            target="_blank"
            rel="noreferrer"
            title={p}
            style={{
              display: 'block',
              aspectRatio: paths.length === 1 ? '16 / 9' : '1 / 1',
              background: '#eee',
              borderRadius: 6,
              overflow: 'hidden',
              border: `1px solid ${COLOR.borderLt}`,
            }}
          >
            <img
              src={assetUrl(p)}
              alt={p}
              style={{
                width: '100%', height: '100%',
                objectFit: 'cover',
                display: 'block',
              }}
            />
          </a>
        ))}
      </div>

      {/* prompt / intent 摘要 */}
      {(intent || prompt) && (
        <div style={{
          padding: `${GAP.xs}px ${GAP.md}px`,
          fontFamily: FONT_SANS, fontSize: 11,
          color: COLOR.text3,
          lineHeight: 1.5,
          maxHeight: 60,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          background: '#fff',
        }}>
          {intent || (prompt && prompt.slice(0, 120) + (prompt.length > 120 ? '…' : ''))}
        </div>
      )}

      {/* feedback textarea (regenerate 模式) */}
      {showFeedback && (
        <div style={{ padding: `${GAP.sm}px ${GAP.md}px`, background: '#fff' }}>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="哪里要改？例如：再暖一点，加些古典装饰，文字换成衬线"
            spellCheck={false}
            autoFocus
            style={{
              width: '100%',
              minHeight: 60,
              padding: GAP.xs,
              fontFamily: FONT_SANS,
              fontSize: 12,
              color: COLOR.text,
              border: `1px solid ${COLOR.borderMd}`,
              borderRadius: 6,
              resize: 'vertical',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}

      {/* buttons */}
      <div style={{
        padding: `${GAP.sm}px ${GAP.md}px`,
        borderTop: `1px solid ${COLOR.borderLt}`,
        display: 'flex', gap: GAP.xs,
        background: '#fff',
      }}>
        {!showFeedback && (
          <button
            onClick={handleApprove}
            disabled={submitting}
            style={{
              flex: 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              padding: '8px 12px',
              fontFamily: FONT_SANS, fontSize: 12, fontWeight: 600,
              color: COLOR.btnText, background: COLOR.btn,
              border: 'none', borderRadius: 6,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            <Check size={13} /> OK 用
          </button>
        )}
        <button
          onClick={handleRegenerate}
          disabled={submitting || (showFeedback && !feedback.trim())}
          style={{
            flex: showFeedback ? 1 : 1,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            padding: '8px 12px',
            fontFamily: FONT_SANS, fontSize: 12,
            color: showFeedback ? COLOR.btnText : COLOR.text2,
            background: showFeedback ? COLOR.btn : '#fff',
            border: `1px solid ${showFeedback ? COLOR.btn : COLOR.borderMd}`,
            borderRadius: 6,
            cursor: (submitting || (showFeedback && !feedback.trim())) ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.5 : 1,
          }}
        >
          <RefreshCw size={13} /> {showFeedback ? '提交反馈' : '重生'}
        </button>
        {!showFeedback && (
          <button
            onClick={handleDismiss}
            disabled={submitting}
            title="忽略：agent 默认按当前继续"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: '8px 10px',
              color: COLOR.text3, background: '#fff',
              border: `1px solid ${COLOR.borderMd}`,
              borderRadius: 6,
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
