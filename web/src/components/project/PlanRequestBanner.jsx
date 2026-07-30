/**
 * PlanRequestBanner — Phase C：agent in-loop 主动请求进 plan mode
 *
 * 触发：run.plan_mode_requested 事件（agent 调 mcp__nodesign__request_plan_mode）
 *   → ProjectWorkspace setPlanModeRequest({ reason, estimatedPages?, taskKind? })
 *   → 本横幅显示
 *
 * 设计：
 *   - **不是 modal**：横幅悬浮在 chat 区上方，不挡聊天。SDK 还没切 mode，
 *     用户可以继续看 agent 跑、看 chat、思考。
 *   - **2 个动作**：
 *     - 「进入 plan 模式」→ Plan.grantViaPermissionMode → SDK 切 plan →
 *       agent 下一 turn 自然进 plan-instructions 流程（写 plan + ExitPlanMode）→
 *       触发 run.plan_for_approval → 接力 PlanReviewCard
 *     - 「不需要」→ 单纯 dismiss（agent MCP 工具的返回文本已说"无 mode
 *       通知就当用户拒绝、按原计划继续"，不需要后端回执）
 *   - **自动消失**：若收到 plan_for_approval（说明已切 mode 走流程）→ clear
 */
import { useEffect } from 'react';
import { Lightbulb, Check, X } from 'lucide-react';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Plan } from '../../lib/api.js';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';

const TASK_LABEL = {
  deck: '幻灯片',
  landing: '落地页',
  dashboard: '看板',
  report: '报告',
  other: '设计',
};

export default function PlanRequestBanner() {
  // 只订阅"会触发渲染"的 state；actions 一律走 getState() 规避 HMR 时
  // store 重建带来的引用变化（zustand 5 + Vite HMR + useEffect 三方相
  // 互作用下，把 action 放进 deps 容易触发死循环）
  const planModeRequest = useGlobalStore((s) => s.planModeRequest);
  const planForApproval = useGlobalStore((s) => s.planForApproval);
  const activeRun = useGlobalStore((s) => s.activeRun);

  // 一旦 plan_for_approval 来了（说明用户已批准 → SDK 切 mode → agent 真的
  // 进了 plan 流程并提交 plan），banner 任务完成自动消失
  useEffect(() => {
    if (planForApproval && planModeRequest) {
      useGlobalStore.getState().clearPlanModeRequest();
    }
  }, [planForApproval, planModeRequest]);

  if (!planModeRequest) return null;

  const { reason, estimatedPages, taskKind, toolUseId } = planModeRequest;
  const taskLabel = taskKind ? TASK_LABEL[taskKind] || '任务' : '任务';

  // 阻塞态（2026-05-07）：agent 工具 await 用户决定。前端必须 POST decide 端点
  // 解阻塞，否则工具一直挂着，整个 turn 卡死。
  const handleApprove = async () => {
    const { showToast, clearPlanModeRequest } = useGlobalStore.getState();
    if (!activeRun?.pid || !activeRun?.runId) {
      showToast('当前无活跃 run，无法切到 plan mode', 'error');
      clearPlanModeRequest();
      return;
    }
    if (!toolUseId) {
      showToast('plan request 缺 toolUseId，无法解阻塞', 'error');
      clearPlanModeRequest();
      return;
    }
    try {
      // 先切 SDK permissionMode（让 agent 下一 turn 进 plan-mode reminder）
      await Plan.grantViaPermissionMode({
        pid: activeRun.pid,
        runId: activeRun.runId,
        mode: 'plan',
      });
      // 再解阻塞 agent 工具（让它能 return）
      await Plan.decidePlanRequest({
        pid: activeRun.pid,
        runId: activeRun.runId,
        toolUseId,
        approved: true,
      });
      showToast('已切到 plan 模式，等待 agent 提交计划…', 'info');
    } catch (err) {
      showToast(`切换失败：${err.message}`, 'error');
    } finally {
      // 立即清 banner——不再依赖"agent 必须立即 ExitPlanMode 来 plan_for_approval"。
      // 实际场景：agent 可能在 plan mode 下 AskUserQuestion / generate_image 探索小样
      // 多轮才 ExitPlanMode，期间 banner 会一直卡在屏上。
      // chat 区 streaming + toast 已经给用户"切换中"反馈，banner 不需要再持留。
      clearPlanModeRequest();
    }
  };

  const handleDismiss = async () => {
    const { showToast, clearPlanModeRequest } = useGlobalStore.getState();
    // 立即清 banner（用户已决定）+ 后台解阻塞 agent 工具（让它 return 并继续）
    clearPlanModeRequest();
    if (activeRun?.pid && activeRun?.runId && toolUseId) {
      try {
        await Plan.decidePlanRequest({
          pid: activeRun.pid,
          runId: activeRun.runId,
          toolUseId,
          approved: false,
        });
      } catch { /* dismiss 路径失败也不阻塞 UX，agent 工具会因 abort/timeout 自然 reject */ }
    }
    showToast('已忽略 plan 请求，agent 继续按原计划', 'info');
  };

  return (
    <div style={{
      position: 'absolute',
      top: GAP.md,
      left: GAP.md,
      right: GAP.md,
      zIndex: 50,
      background: 'linear-gradient(135deg, #FFF8E1 0%, #FFF3D6 100%)',
      border: `1px solid ${COLOR.warn}55`,
      borderRadius: 10,
      boxShadow: '0 6px 24px rgba(0,0,0,0.08)',
      padding: `${GAP.md}px ${GAP.lg}px`,
      display: 'flex',
      alignItems: 'flex-start',
      gap: GAP.md,
      animation: 'planReqSlide 220ms cubic-bezier(0.25,1,0.5,1)',
    }}>
      <style>{`
        @keyframes planReqSlide {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div style={{
        flexShrink: 0,
        width: 32, height: 32,
        borderRadius: 8,
        background: '#fff',
        border: `1px solid ${COLOR.warn}55`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Lightbulb size={16} color={COLOR.warn} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: FONT_MONO, fontSize: 10, color: COLOR.warn,
          letterSpacing: '0.06em', marginBottom: 4,
        }}>
          AGENT 请求进入 PLAN 模式
        </div>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 600,
          color: COLOR.text, marginBottom: 4,
        }}>
          {`这看起来是个有点复杂的${taskLabel}`}
          {estimatedPages != null && (
            <span style={{
              marginLeft: 8,
              fontSize: 11, fontFamily: FONT_MONO, fontWeight: 400,
              color: COLOR.text3,
              padding: '2px 6px',
              border: `1px solid ${COLOR.borderMd}`,
              borderRadius: 4,
            }}>
              ~{estimatedPages} 页
            </span>
          )}
        </div>
        <div style={{
          fontFamily: FONT_SANS, fontSize: 12, color: COLOR.text2,
          lineHeight: 1.55,
        }}>
          {reason}
        </div>
        <div style={{
          marginTop: 4,
          fontFamily: FONT_SANS, fontSize: 11, color: COLOR.sub,
        }}>
          进 plan 后 agent 会先写一份 markdown 计划给你 review；不进就照原节奏继续做。
        </div>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        flexShrink: 0,
      }}>
        <button
          onClick={handleApprove}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 14px',
            fontFamily: FONT_SANS, fontSize: 12, fontWeight: 600,
            color: COLOR.btnText,
            background: COLOR.btn,
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          <Check size={13} /> 进入 plan
        </button>
        <button
          onClick={handleDismiss}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 14px',
            fontFamily: FONT_SANS, fontSize: 12,
            color: COLOR.text2,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 6,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          <X size={13} /> 不需要
        </button>
      </div>
    </div>
  );
}
