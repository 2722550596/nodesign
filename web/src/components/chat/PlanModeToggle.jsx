import { ClipboardList } from 'lucide-react';
import { COLOR, GAP, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Plan } from '../../lib/api.js';

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
  const locked = !!planModeRequest || !!planForApproval;
  const isDisabled = disabled || locked;

  const handleClick = async () => {
    if (isDisabled) return;
    const next = !planModeEnabled;
    setPlanModeEnabled(next);
    if (syncToActiveRun && activeRun?.pid && activeRun?.runId) {
      try {
        await Plan.grantViaPermissionMode({
          pid: activeRun.pid,
          runId: activeRun.runId,
          mode: next ? 'plan' : 'bypassPermissions',
        });
      } catch {
        // query 不 active（404）/ 网络抖动：silent；下一 turn 自然用新 mode
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
