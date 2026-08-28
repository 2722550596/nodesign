/**
 * lib/probe-pi.js — 模型插槽体检（M3a：裸 pi 探针，替代 ingress 时代的 slot-probe.js）。
 *
 * 配置页「体检」按钮打的就是它：对一行 API 模型，临时 spawn 一个**裸 pi**
 * （--mode rpc，只挂 providers.ts + nd-probe preset，不挂 Nodesign 工具扩展），
 * 发一句 'Reply OK' 等 agent_settled，回一张红绿表。
 *
 * 为什么不再穿进程内入口（model-ingress）：M3 起引擎链路是 pi-rp RPC，入口/转换层
 * 随 ingress 全家删除；体检要验的就是「pi 拿这行模型真能跑通一轮」，直接走 pi 才是
 * 真路径。nd-probe preset 把工具全 deny（tools.deny ["*"]），模型连工具 schema 都
 * 收不到，一发最小文本请求即够。
 *
 * 响应形状保持前端 ProbeResult 契约（SlotEditor.jsx 消费 checks[].{id,ok,label,
 * level,ms,note} 与顶层 error）：裸 pi 只发文本，checks 恒为一项 text。
 * 查不到路由的名字（resolveModelRoute 返 null）回一条错误 check，不 spawn。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModelRoute } from '../engine/agent/model-context.js';
import { piProviderModelFor } from '../engine/pi/model-map.js';
import { resolvePiBinary, createSessionProcess } from '../engine/pi/lifecycle.js';
import { PiRpcClient } from '../engine/pi/rpc-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Nodesign 侧 pi 资产目录（nd-probe preset 住这里；与 lifecycle.js AGENT_DIR 同路径）。 */
const AGENT_DIR = path.join(__dirname, '..', 'engine', 'pi', 'agent-dir');
/** 上游 providers 扩展（-e 显式挂载；读 models.json 注册，与 lifecycle.js PROVIDERS_EXT 同路径）。 */
const PROVIDERS_EXT = path.join(__dirname, '..', 'engine', 'pi', 'extensions', 'providers.ts');

/**
 * @param {string} appModel
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ appModel: string, mode: 'api', checks: Array<{ id, label, ok: boolean|null, level: 'core'|'info', ms: number, note: string }> }>}
 */
export async function probeModel(appModel, { timeoutMs = 45_000 } = {}) {
  const route = resolveModelRoute(appModel);
  if (!route) {
    return { appModel, mode: 'api', checks: [{ id: 'text', label: '文本', ok: false, level: 'core', ms: 0,
      note: `未知模型 ${appModel}：不在模型表里（或无 api 路由），体检无从谈起` }] };
  }
  const wire = piProviderModelFor(appModel);
  if (!wire) {
    return { appModel, mode: 'api', checks: [{ id: 'text', label: '文本', ok: false, level: 'core', ms: 0,
      note: '没有 pi-rp 扩展映射（models.json 未覆盖这行或上游缺钥匙）' }] };
  }

  // 临时空目录：pi 的 cwd（--config-dir .pi 是 join(cwd,·) 语义，目录里没有 .pi 无碍）
  // + --session-dir（探针不落可复用会话，跑完即删）
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-probe-'));
  const sessionDir = path.join(tmpdir, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  const args = [
    '--mode', 'rpc', '--approve',
    '--preset', 'nd-probe',                    // 工具全 deny 的最小 preset（显式选，autoActivate:false）
    '--provider', wire.provider,
    '--model', wire.model,
    '--config-dir', '.pi',                      // 相对 cwd（绝对会拼坏，M0 实测）
    '--session-dir', sessionDir,
    '--system-prompt', '',
    '-e', PROVIDERS_EXT,                        // 上游注册面（内置 + 外部插槽）
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
  ];
  // env：继承 process.env（NODESIGN_UPSTREAM_* 由 profile.js 加载的 .env 提供）
  // + PI_CODING_AGENT_DIR（找到 nd-probe preset）+ 关遥测
  const env = { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR, PI_TELEMETRY: '0' };

  const child = createSessionProcess({ binary: resolvePiBinary(), args, cwd: tmpdir, env });
  const client = new PiRpcClient({ child });

  // 事件收集：text_delta 累积文本；agent_settled / 进程退出 都算「见分晓」
  let text = '';
  let exitInfo = null;
  let settleResolve;
  const settledPromise = new Promise((resolve) => { settleResolve = resolve; });
  client.onEvent = (line) => {
    if (!line || typeof line !== 'object') return;
    if (line.type === 'message_update') {
      const ame = line.assistantMessageEvent;
      if (ame?.type === 'text_delta') text += ame.delta ?? '';
    } else if (line.type === 'agent_settled') {
      settleResolve('settled');
    }
  };
  client.onExit = (code, signal, err) => {
    exitInfo = { code, signal, err };
    settleResolve('exited');
  };

  const t0 = Date.now();
  let ok = false;
  let note = '';
  try {
    await client.start();
    const res = await client.prompt('Reply OK');
    if (!res.success) {
      note = `pi 拒绝 prompt：${res.error ?? 'unknown'}`;
    } else {
      const timer = setTimeout(() => settleResolve('timeout'), timeoutMs);
      const winner = await settledPromise;
      clearTimeout(timer);   // settled/exited 先到时别留悬空定时器（server 进程内会拖 shutdown）
      if (winner === 'settled') {
        ok = text.trim().length > 0;
        note = ok ? `答「${text.trim().slice(0, 40)}」` : 'settled 但没有文本输出';
      } else if (winner === 'exited') {
        note = `pi 进程退出（code=${exitInfo?.code} signal=${exitInfo?.signal}${exitInfo?.err ? `：${exitInfo.err.message}` : ''}）`;
      } else {
        note = `超时 ${Math.round(timeoutMs / 1000)}s 未 settled`;
      }
    }
  } catch (err) {
    note = err.message;
  } finally {
    await client.kill().catch(() => {});
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* 临时目录清不掉就算了 */ }
  }
  return { appModel, mode: 'api', checks: [{ id: 'text', label: '文本', ok, level: 'core', ms: Date.now() - t0, note }] };
}
