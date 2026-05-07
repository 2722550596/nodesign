import { ClipboardList } from 'lucide-react';
import { COLOR, GAP, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Plan } from '../../lib/api.js';

// 服务器报"run not active"（run 已结束）= 切 store 即可，不算错；下次 turn 用新 mode。
// 其他错误（SDK 拒切 mode / 网络抖到失败 / 500）→ 回滚 store + toast 让用户重试。
const RUN_INACTIVE_RE = /404|RUN_NOT_ACTIVE|run not active/i;

/**
 * 深度对齐 toggle —— SDK 原生 plan mode 开关。
 *
 * 三处入口共用：ChatComposer（session 内）/ QuickEntry（首页快速对话）/ HubInput（项目 Hub）。
 * 行为：点击切 store 里的 planModeEnabled（localStorage 持久化）。
 *
 * 可选：syncToActiveRun=true 时，如有活跃 run 调 /permission-mode 把当前 query 的
 * permissionMode 同步切（ChatComposer 用）。无 active run 自然跳过 API，下一 turn
 * 走新的 initialPermissionMode。
 *
 * UX 守卫：plan banner / approval card 弹时 store 里 planModeRequest / planForApproval
 * 真值，本组件自动锁住 toggle 防双向操作打架。
 */
export default function PlanModeToggle({ disabled = false, syncToActiveRun = false }) {
  const planModeEnabled = useGlobalStore(s => s.planModeEnabled);
  const setPlanModeEnabled = useGlobalStore(s => s.setPlanModeEnabled);
  const activeRun = useGlobalStore(s => s.activeRun);
  const planModeRequest = useGlobalStore(s => s.planModeRequest);
  const planForApproval = useGlobalStore(s => s.planForApproval);
  const showToast = useGlobalStore(s => s.showToast);
  const locked = !!planModeRequest || !!planForApproval;
  const isDisabled = disabled || locked;

  const handleClick = async () => {
    if (isDisabled) return;
    const prev = planModeEnabled;
    const next = !planModeEnabled;
    setPlanModeEnabled(next);
    if (syncToActiveRun && activeRun?.pid && activeRun?.runId) {
      try {
        await Plan.grantViaPermissionMode({
          pid: activeRun.pid,
          runId: activeRun.runId,
          mode: next ? 'plan' : 'bypassPermissions',
        });
      } catch (err) {
        const msg = err?.message || String(err || '');
        if (RUN_INACTIVE_RE.test(msg)) {
          // run 已结束：保留 store 切换，下次 turn 自然用新 mode
          return;
        }
        // 真失败（SDK 拒切 / 5xx / 网络）→ 回滚 store 让 UI 跟 SDK 真相一致 + 提示
        setPlanModeEnabled(prev);
        showToast(`切换深度对齐失败：${msg || '未知错误'}`, 'error');
      }
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={isDisabled}
      title={
        locked
          ? '审批进行中，请先在弹窗里做选择'
          : planModeEnabled
            ? 'plan-mode 已开：agent 会先写 design plan 让你审批 / 编辑后再执行（点击关闭）'
            : 'plan-mode 关：agent 跑默认流程，复杂 brief 想先 review plan 再开（点击开启）'
      }
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: `4px ${GAP.sm}px`,
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
        color: planModeEnabled ? COLOR.btnText : COLOR.text2,
        background: planModeEnabled ? COLOR.warn : 'transparent',
        border: `1px solid ${planModeEnabled ? COLOR.warn : COLOR.borderMd}`,
        borderRadius: 6,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.5 : 1,
        transition: 'all 0.15s',
      }}
    >
      <ClipboardList size={11} />
      {planModeEnabled ? '深度对齐已开' : '深度对齐'}
    </button>
  );
}
