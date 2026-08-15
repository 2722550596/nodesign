/**
 * PreToolUse 默认值矫正族 —— 透明改 tool_input，agent 无感，结果更有用。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 */

import { guardGrepInput } from './pre-performance-log-guard.js';

/**
 * PreToolUse(Agent) 强制前台 —— 透明改 input，不 hard deny。
 *
 * ⚠️ 2026-08-03 修：**默认值翻了面，这个 hook 之前形同虚设。**
 *
 * 老 SDK：`run_in_background` 不传 = 前台，所以只需拦 `=== true`。
 * 新 SDK（sdk-tools.d.ts AgentInput 原文）："Agents run in the background by
 * default; you will be notified when one completes. **Set to false** to run this
 * agent synchronously when you need its result before continuing."
 *
 * 也就是说**不传 = 后台**。模型自然写法就是不传（探针实测 bg=undefined），于是：
 * 主 agent 只拿到一句 "Async agent launched successfully"，报告永远不回来。
 * 真实事故：2026-08-03 一个 explorer 烧了 38k tokens / 20 次工具调用 / 108 秒查
 * 完时局资料，主 agent 收到的 tool_result 里一个字都没有，只好自己重搜四轮，
 * 还跟用户说了句"研究员跑完了但报告没回传到我这儿"。
 *
 * 所以判据从"等于 true 才改"改成"**不是显式 false 就补 false**"。
 * 显式传了 false 的（模型自己知道要前台）原样放过，不重复改也不发提示。
 *
 * 为什么 NoDesign 一定要前台：创作的核心反馈环是 agent 看 explorer /
 * vision-checker 传回的素材 URL 与 critique → 据此改产物 → 再自检。
 * fire-and-forget 等于把这个环剪断，agent 拿不到结果只能盲写。
 * forwardSubagentText 已开，前台等的时候用户看得见子代理实时进度，不会卡死。
 *
 * 兜底另有一层：DEFAULT_TOOL_ALLOWLIST 里挂了 `TaskOutput`，万一还是漏成后台
 * （比如 isolation:'remote' 强制后台），主 agent 能凭 task_id 把报告捞回来。
 */
export function makePreToolUseAgentForceForegroundHandler() {
  return async (input) => {
    const t = input?.tool_input;
    if (!t || typeof t !== 'object') return {};
    // 显式前台，不动
    if (t.run_in_background === false) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...t, run_in_background: false },
        additionalContext:
          'NoDesign 工作台已把这次派遣改成前台（run_in_background: false），'
          + '你会在这次 tool_result 里直接拿到子代理的完整报告。'
          + '子代理默认是后台跑的，那样报告不会回到你手里——创作需要你看见素材和'
          + 'critique 才能改产物，所以这里一律前台。下次派遣请自己显式写 '
          + '`run_in_background: false`。',
      },
    };
  };
}

/**
 * PreToolUse(Grep) handler：改 Grep 的入参。**Grep 的输入改写只许有这一个
 * handler** —— 两个 handler 各自返回 updatedInput，后跑的那个是拿原始
 * tool_input 拼的，会把前一个的改动抹掉。所以下面两件事合在一处做。
 *
 * ① 缺省 output_mode 改成 'content'。
 *    SDK 默认 'files_with_matches' 只返回文件名，agent 还得再 Read 一遍，多一个
 *    turn。设计场景下 grep 几乎都是想看实际文本，'content' 是更合理的默认。
 *    显式传了 'files_with_matches' / 'count' 就不动（agent 知道自己在干嘛）。
 *
 * ② 演出记录排除（2026-08-15）：工作区里有演出文件夹时，没指定 glob 的 Grep
 *    自动带上 `!{对话.jsonl,…}`。搜索照跑，只是搜不到台词 —— 拒工具会打断正经
 *    搜索，改输入不会。agent 自己的 glob 会命中记录才拒。详见
 *    hooks/pre-performance-log-guard.js。
 *
 * 不发 additionalContext —— ① 对 agent 透明；② 只在真拒的时候才需要解释。
 */
export function makePreToolUseGrepContentDefaultHandler({ workspaceRoot } = {}) {
  return async (input) => {
    const t = input?.tool_input;
    if (!t || typeof t !== 'object') return {};
    let 隐私 = {};
    try { 隐私 = await guardGrepInput(t, workspaceRoot); } catch { 隐私 = {}; }
    if (隐私.deny) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 隐私.deny,
        },
      };
    }
    const 补默认 = !t.output_mode || t.output_mode === '';
    if (!隐私.glob && !补默认) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...t,
          ...(补默认 ? { output_mode: 'content' } : {}),
          ...(隐私.glob ? { glob: 隐私.glob } : {}),
        },
      },
    };
  };
}
