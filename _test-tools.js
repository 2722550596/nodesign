
import { runSession } from './server/engine/agent/session-loop.js';
import { AsyncQueue } from './server/lib/async-queue.js';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

async function testTools() {
  const sessionId = 'test-sid-' + Date.now();
  const workspaceRoot = path.join(os.tmpdir(), 'nd-test-tools');
  await fs.mkdir(workspaceRoot, { recursive: true });
  
  const eventBus = new EventEmitter();
  const inputQueue = new AsyncQueue();
  
  // 模拟一个简单的 session 启动，观察 SDK 抛出的工具列表
  // 我们不需要真正跑完，只需要看它初始化后的状态
  try {
    const promise = runSession({
      sessionId,
      sessionWorkspaceRoot: workspaceRoot,
      eventBus,
      inputQueue,
      skillId: 'deskskill-engine-mini',
    });
    
    // 给一点时间让 it start
    await new Promise(r => setTimeout(resolve, 2000));
    
    // 我们没法直接拿 SDK 实例，但可以通过 eventBus 观察消息
    // 或者直接看 stdout/stderr (虽然在 runSession 里被捕获了)
    
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    // cleanup
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

// testTools();
