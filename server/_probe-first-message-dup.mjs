/**
 * _probe-first-message-dup.mjs — 复现「新会话第一条用户消息在转录里变成两份相同 text block」
 *
 * 走的是**生产那条路**：composeUserMessage（turn.js 用的那个）→ sdkUserMessage
 * → inputQueue.push（新会话起手）→ runSession → CLI 转录。
 *
 * 跑：DB_PATH=/tmp/xxx/probe.db node --env-file-if-exists=.env server/_probe-first-message-dup.mjs
 * 判据：转录里 query 起手那条 user message 的 content 有几个 text block（应为 1）。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { composeUserMessage } from './api/turn-compose.js';
import { runSession } from './engine/agent/session-loop.js';
import { EventBus } from './engine/agent/events.js';
import { createRun, _truncateRunsTable } from './engine/runs/store.js';
import { AsyncQueue } from './lib/async-queue.js';
import { closeQuerySession } from './engine/runs/active-runs.js';

const CHAT = '你好！';

function transcriptDirFor(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-probe-dup-'));
  const sessionId = '00000000-0000-4000-8000-00000000d0d1';
  const projectId = 'proj_probedup_0001';
  const sessionRoot = path.join(tmpRoot, 'sessions', sessionId);
  fs.mkdirSync(path.join(sessionRoot, '.claude', 'projects'), { recursive: true });

  _truncateRunsTable();

  // ==== 生产那条路：turn.js 就是这样拼首条消息的 ====
  const { blocks } = await composeUserMessage(CHAT, [], sessionRoot);
  console.log(`[probe] composeUserMessage → ${blocks.length} block(s):`);
  for (const b of blocks) console.log(`  - ${b.type}: ${JSON.stringify((b.text || '').slice(0, 60))}`);

  const sdkUserMessage = { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null };

  const bus = new EventBus();
  const inputQueue = new AsyncQueue();
  inputQueue.push(sdkUserMessage);   // 新会话起手：turn.js startNewRunSession 就是这句

  const run = createRun({ skillId: 'deskskill-engine-mini', brief: CHAT, projectId });
  const done = new Promise((resolve) => {
    bus.subscribe('*', (e) => { if (e.type === 'run.done' || e.type === 'run.error') resolve(e); });
  });

  const sessionPromise = runSession({
    sessionId, projectId, sessionWorkspaceRoot: sessionRoot, eventBus: bus,
    inputQueue, skillId: 'deskskill-engine-mini', initialRunId: run.id,
  }).catch((err) => { console.error('[probe] runSession threw:', err.message); });

  const ev = await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 120s')), 120000)),
  ]);
  console.log(`[probe] run finished: ${ev.type}`);

  closeQuerySession(sessionId, 'probe_done');
  await sessionPromise.catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // ==== 读 CLI 转录，看起手那条 user message ====
  const dir = transcriptDirFor(sessionRoot);
  console.log(`[probe] transcript dir: ${dir}`);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { /* */ }
  if (!files.length) { console.log('[probe] 没找到转录 jsonl'); process.exit(3); }
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== 'user') continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      const texts = content.filter((c) => c.type === 'text');
      if (!texts.some((t) => String(t.text).includes(CHAT))) continue;
      console.log(`\n[probe] ==== ${f} 起手 user message ====`);
      console.log(`[probe] text block 数 = ${texts.length}`);
      console.log(JSON.stringify(content, null, 0).slice(0, 600));
      process.exit(texts.length === 1 ? 0 : 2);
    }
  }
  console.log('[probe] 转录里没找到起手 user message');
  process.exit(3);
}

main().catch((err) => { console.error('[probe] uncaught:', err); process.exit(1); });
