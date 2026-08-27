/**
 * task-store —— TaskCreate/TaskUpdate/TaskList 的纯逻辑存储（per-turn，agent_start 时 reset）。
 *
 * SDK 时代 agent-shared.js 的忠实移植：pi 扩展侧本 store 就是真相源，
 * 工具改完 store 后把 mirror()（不带 id，对齐 SDK run.todo.updated 形状）
 * 经 sidecar /emit 上报，board-tasklist.js 消费落板书。
 *
 * id 容错：模型回传的 taskId 实测有 "t1" / "1" / "#1" 三种形态（TaskCreate
 * 返回文本里写的是编号），normId 一律归一成 store key —— 三种都命中。
 *
 * 零依赖：不 import 任何 server/ 模块，vitest 直接测。
 */

export const TASK_STATUSES = ['pending', 'in_progress', 'completed'];

export function createTaskStore() {
  /** @type {Map<string, {content: string, status: string, activeForm?: string}>} 插入序即展示序 */
  const rows = new Map();
  let seq = 0;

  /** taskId 归一："t1" / "1" / "#1" → "t1"；非字符串/空 → 原样（查不到就 miss） */
  function normId(id) {
    const s = String(id ?? '').trim();
    const m = s.match(/^#?t?(\d+)$/i);
    return m ? `t${m[1]}` : s;
  }

  function create(subject, activeForm) {
    const content = (typeof subject === 'string' && subject.trim()) ? subject : '(未命名任务)';
    const id = `t${++seq}`;
    const row = { content, status: 'pending' };
    if (activeForm !== undefined) row.activeForm = activeForm;
    rows.set(id, row);
    return id;
  }

  function update(id, patch = {}) {
    const row = rows.get(normId(id));
    if (!row) return false;
    if (patch.status === 'deleted') {
      rows.delete(normId(id));
      return true;
    }
    if (patch.status !== undefined && TASK_STATUSES.includes(patch.status)) row.status = patch.status;
    if (patch.activeForm !== undefined) row.activeForm = patch.activeForm;
    if (patch.subject !== undefined) row.content = patch.subject;
    return true;
  }

  function remove(id) {
    return rows.delete(normId(id));
  }

  function reset() {
    rows.clear();
    seq = 0;
  }

  function list() {
    return [...rows.entries()].map(([id, row]) => ({ id, ...row }));
  }

  function mirror() {
    return [...rows.values()].map((row) => ({ ...row }));
  }

  return {
    create,
    update,
    remove,
    reset,
    list,
    mirror,
    get size() { return rows.size; },
  };
}
