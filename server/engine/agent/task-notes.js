/**
 * task-notes.js — 子代理任务的持久便签（2026-07-31）
 *
 * 以前 Task 子代理只有舞台便利贴（StageLayer 的 React 态卡片）：不能拖、
 * 刷新即失、能不能沉淀成 notes/ 全看 agent 自觉。这里把它做成结构性的：
 * 每次 task_started 往 `notes/子任务.md` 追加一面（同一套
 * `\n---\n` 分面便签约定，桌面上渲成可翻页、可拖拽的真便签），
 * task_notification 到达时把那一面的状态从「进行中」改成终态并补结果摘要。
 *
 * 面与任务的对应靠隐藏 HTML 注释锚 `<!--task:<task_id>-->`（渲染时不可见，
 * note-faces 分面照常）。
 *
 * 2026-08-07：便签落点从 `tasks/<任务>/notes/` 变成 `notes/`。以前这里有一整段
 * "定位当前会话属于哪个任务"的逻辑（活跃产物 → tasks/ 下唯一目录 → 定位不到
 * 就静默跳过），任务层拆掉之后落点是确定的，那段连同它的静默失败一起没了。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Events } from './events.js';

const NOTE_FILE = '子任务.md';

const STATUS_LABEL = {
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

/** 同文件读改写按 workspaceRoot 串行化（并发 Task 是常态，别互相吃写入） */
const writeLocks = new Map();
function withNoteLock(key, fn) {
  const prev = writeLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

function hhmm() {
  // 展示给用户的时刻，跟服务器时区无关，按 +08 给
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/**
 * task_started → 追加一面。fire-and-forget（调用方 .catch），失败不影响 turn。
 * @param {import('./context.js').AgentContext} ctx
 * @param {{ task_id: string, description?: string, subagent_type?: string, task_type?: string }} msg
 */
export async function noteTaskStarted(ctx, msg) {
  const root = ctx?.workspace?.root?.();
  if (!root || !msg?.task_id) return;

  const agentType = msg.subagent_type || msg.task_type || '子代理';
  const face = [
    `# ⚙ ${agentType}`,
    '',
    (msg.description || '').trim() || '(无描述)',
    '',
    `- 状态：进行中`,
    `- ${hhmm()}`,
    `<!--task:${msg.task_id}-->`,
  ].join('\n');

  const noteFile = path.join(root, 'notes', NOTE_FILE);
  await withNoteLock(noteFile, async () => {
    await fs.mkdir(path.dirname(noteFile), { recursive: true });
    let prev = '';
    try { prev = await fs.readFile(noteFile, 'utf8'); } catch { /* 首条 */ }
    if (prev.includes(`<!--task:${msg.task_id}-->`)) return;   // 重放防重
    const next = prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n---\n\n${face}\n` : `${face}\n`;
    await fs.writeFile(noteFile, next, 'utf8');
  });
  // MCP/系统消息写盘不走 PostToolUse file_changed 直发，自己补一发刷新画布。
  // ⚠️ 发工作区相对路径不发 noteFile（绝对）——绝对路径会在前端孵出 home 影子文件夹
  ctx.emit?.(Events.fileChanged(path.posix.join('notes', NOTE_FILE), 'change'));
}

/**
 * task_notification → 把对应面的「进行中」改成终态 + 补结果摘要。
 * 找不到锚（比如任务是在别的会话/无任务期启动的）就静默跳过。
 * @param {import('./context.js').AgentContext} ctx
 * @param {{ task_id: string, status?: string, summary?: string }} msg
 */
export async function noteTaskFinished(ctx, msg) {
  const root = ctx?.workspace?.root?.();
  if (!root || !msg?.task_id) return;

  const noteFile = path.join(root, 'notes', NOTE_FILE);
  const marker = `<!--task:${msg.task_id}-->`;
  let changed = false;
  await withNoteLock(noteFile, async () => {
    let text = '';
    try { text = await fs.readFile(noteFile, 'utf8'); } catch { return; }
    if (!text.includes(marker)) return;
    const faces = text.split('\n---\n');
    const idx = faces.findIndex(f => f.includes(marker));
    if (idx < 0) return;
    let face = faces[idx].replace(/- 状态：进行中/, `- 状态：${STATUS_LABEL[msg.status] || msg.status || '结束'}`);
    const summary = (msg.summary || '').trim();
    if (summary) {
      const brief = summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
      face = face.replace(marker, `- 结果：${brief}\n${marker}`);
    }
    if (face === faces[idx]) return;
    faces[idx] = face;
    await fs.writeFile(noteFile, faces.join('\n---\n'), 'utf8');
    changed = true;
  });
  if (changed) ctx.emit?.(Events.fileChanged(path.posix.join('notes', NOTE_FILE), 'change'));   // 同上：相对路径
}
