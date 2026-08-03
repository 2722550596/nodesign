import { useState, useEffect } from 'react';
import { FormModal, FInput, FBtn } from '../ui/Form.jsx';
import { COLOR, GAP, RADIUS, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';
import { Elicit } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * ElicitationModal —— MCP 工具调 server.elicitInput() 时前端弹这个最小 modal
 * 收用户输入。当前 0 个 NoDesign MCP 工具用 elicit，此组件 future-proof：未来
 * 加新 MCP 工具想要表单输入时立即可用。
 *
 * SDK 端 MCPElicitInputRequest 结构（sdk.d.ts MCP elicitation request）：
 *   - message: string                          展示给用户的问题
 *   - requestedSchema?: JSONSchema             理想情况下应渲染成完整 form
 *
 * MVP 占位实现：
 *   - 显示 message 作为问题
 *   - 单个 textarea 让用户填任意文本
 *   - "提交"按 accept + content={ value: <text> }
 *   - "拒绝"按 decline，agent 会知道工具被拒
 *   - schema-driven 多字段表单：留给真有 elicit 工具时再做
 *
 * 关闭逻辑：
 *   - 关闭按钮 / 拒绝 都会 POST decline，让 SDK 那侧 await 解开（不留 dangling promise）
 *   - 60s 超时由后端管（onElicitation 那侧）—— 用户没操作时后端也会自动 decline
 */
export default function ElicitationModal({ projectId, request, onClose }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  // request 改变时重置输入框（不同 elicit 请求间）
  useEffect(() => { setValue(''); }, [request?.reqId]);

  if (!request) return null;

  const message = request.request?.message
    || request.request?.requestedSchema?.description
    || '工具请求输入';

  const submit = async (action, content) => {
    if (busy) return;
    setBusy(true);
    try {
      await Elicit.answer({
        pid: projectId,
        runId: request.runId,
        reqId: request.reqId,
        action,
        content,
      });
      onClose();
    } catch (err) {
      showToast(`提交失败：${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal title="工具请求输入" show={true} onClose={() => submit('decline')}>
      <div style={{
        marginBottom: GAP.lg,
        padding: GAP.md,
        background: 'rgba(43,33,23,0.03)',
        borderRadius: RADIUS.md,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text,
        lineHeight: 1.5,
      }}>
        {message}
      </div>
      <FInput
        label="你的回答"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="填入..."
        multiline
      />
      <div style={{ display: 'flex', gap: GAP.sm, marginTop: GAP.lg }}>
        <FBtn
          label={busy ? '提交中...' : '提交'}
          onClick={() => submit('accept', { value })}
          full
        />
        <FBtn label="拒绝" onClick={() => submit('decline')} />
      </div>
    </FormModal>
  );
}
