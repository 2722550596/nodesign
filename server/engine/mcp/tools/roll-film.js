/**
 * mcp/tools/roll-film.js — roll_film MCP tool（2026-08-08，当晚改主力=5090 盒子）
 *
 * 自部署 MiniMax-H3 视频产线，后端两档：
 *   box（默认）  站主租的 5090 盒子（h3box.py video over SSH）。机时包在租金里
 *                （~¥0.2/条边际），服务器常驻模型留显存，8s 镜 ~3 分钟。
 *   modal        Modal H100+sage 主力镜像。余额太少（08-08 用户定）降为备用档，
 *                显式 NODESIGN_FILM_BACKEND=modal 才走 —— 绝不自动回退烧余额。
 * 两档同一套定档配方：Turbo 8 步 / 1344×768 / 单镜 ≤12.25s（294 帧），溢价档不暴露。
 *
 * 闸门按项目 owner 算（试用号拒），模式同 publish-site.js。
 * 视觉 QC 一律归用户：只回文本路径，不回 image block。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { Events } from '../../agent/events.js';
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import { boxConfig, runBox, sshArgs, scpArgs } from './h3box-ssh.js';

const H3_REPO = process.env.NODESIGN_H3_REPO || '/home/wangang-dev/projects/minimax-h3-modal';
const MODAL_BIN = process.env.NODESIGN_MODAL_BIN || path.join(os.homedir(), '.local/bin/modal');
const TIMEOUT_MS = Number(process.env.NODESIGN_FILM_TIMEOUT_MS) || 900_000;

/** H3 帧数约束：24fps 且 ≡5 (mod 17)；产线安全域 ≤294 帧（12.25s）。 */
function frameCount(durationS) {
  const f = Math.max(5, Math.round(durationS * 24));
  return f + ((5 - (f % 17)) % 17 + 17) % 17;
}

/** 边际成本估算（实测锚点插值，只进 caption/sidecar，不进账务表）。 */
function estCostUsd(d, backend) {
  const pts = backend === 'modal'
    ? [[5.17, 0.10], [8, 0.16], [10, 0.21], [12.25, 0.28]]
    : [[5.17, 0.015], [8, 0.02], [12.25, 0.03]];   // 盒子 ¥3/h 摊到墙钟
  if (d <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (d <= pts[i][0]) {
      const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
      return Math.round((y0 + (d - x0) * (y1 - y0) / (x1 - x0)) * 1000) / 1000;
    }
  }
  return pts[pts.length - 1][1];
}

function runModal(args, { cwd, signal }) {
  return new Promise((resolve) => {
    const child = spawn(MODAL_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, TIMEOUT_MS);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ code, out, err });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
  });
}

/**
 * 核心流程（从 tool handler 拆出来，方便不起 SDK 直接实弹测试）。
 * @returns {{content:[{type:'text',text:string}], isError?:true}}
 */
export async function rollFilm(
  { workspaceRoot, sharedRoot, projectId, sessionId, ctx },
  { prompt, duration, name, seed, first_frame, last_frame, steps },
) {
  const asText = (text, isError = false) =>
    ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
  try {
    const project = getProject(projectId);
    if (!project) return asText('错误：项目不存在', true);
    const owner = project.ownerId ? getUserById(project.ownerId) : null;
    if (!owner) return asText('错误：找不到项目归属用户', true);
    if (owner.lifetimeCostLimitUsd != null) {
      return asText('试用账号不能使用自部署视频产线 —— 想用可以找站主换正式邀请码。原话转告用户，不要重试。', true);
    }

    const frames = frameCount(duration);
    if (frames > 294) {
      return asText(`${frames} 帧超出产线安全域 294 帧（12.25s）。拆成多镜。`, true);
    }

    // 关键帧锚：本地确认存在（两条后端都要）
    const anchors = {};
    for (const [slot, p] of [['first_frame', first_frame], ['last_frame', last_frame]]) {
      if (!p) continue;
      const abs = path.resolve(workspaceRoot || process.cwd(), p);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) throw new Error('not a file');
      } catch {
        return asText(`${slot} 找不到：${p}（先用 paint_still / generate_image 生成关键帧）`, true);
      }
      anchors[slot] = abs;
    }

    const backend = (process.env.NODESIGN_FILM_BACKEND || 'box').toLowerCase();
    const jobId = `film-${Date.now().toString(36)}`;
    const job = { name: jobId, prompt, seed, duration, width: 1344, height: 768 };
    if (steps) job.steps = steps;

    const t0 = Date.now();
    let localMp4;   // 成片的本地临时路径

    if (backend === 'modal') {
      Object.assign(job, anchors);
      const jobsPath = path.join(os.tmpdir(), `nd-${jobId}.json`);
      await fs.writeFile(jobsPath, JSON.stringify([job]));
      const r = await runModal(['run', 'h3_comfy.py', '--jobs-file', jobsPath],
        { cwd: H3_REPO, signal: ctx?.abortController?.signal });
      fs.unlink(jobsPath).catch(() => { /* */ });
      if (r.code !== 0) {
        return asText(`Modal 产线失败（exit ${r.code}）：\n${(r.err || r.out).slice(-1200)}`, true);
      }
      const outRepo = path.join(H3_REPO, 'outputs');
      const hits = (await fs.readdir(outRepo)).filter((f) => f.startsWith(`${jobId}_`) && f.endsWith('.mp4'));
      if (!hits.length) return asText(`产线跑完但没找到成片。尾部输出：\n${r.out.slice(-800)}`, true);
      localMp4 = path.join(outRepo, hits[0]);
    } else {
      // ── 主力：5090 盒子 ──────────────────────────────────────────────
      const box = boxConfig();
      if (!box) {
        return asText('视频盒子未配置（站主没开机或没设 NODESIGN_H3BOX_SSH）。转告用户；备用 Modal 档要站主设 NODESIGN_FILM_BACKEND=modal 才开。', true);
      }
      const signal = ctx?.abortController?.signal;
      const mk = await runBox(box, 'ssh', [...sshArgs(box), 'mkdir -p nd_jobs'], { timeoutMs: 30_000, signal });
      if (mk.code !== 0) {
        return asText(`盒子连不上（没开机/地址过期）：\n${(mk.err || '').slice(-400)}\n转告用户。`, true);
      }
      // 关键帧推上盒子，job 里引用盒子侧路径（h3box 会 expanduser）
      for (const [slot, abs] of Object.entries(anchors)) {
        const remote = `nd_jobs/${jobId}-${slot}${path.extname(abs) || '.png'}`;
        const up = await runBox(box, 'scp', [...scpArgs(box), abs, `${box.target}:${remote}`], { timeoutMs: 60_000, signal });
        if (up.code !== 0) return asText(`关键帧上传失败：\n${up.err.slice(-400)}`, true);
        job[slot] = `~/${remote}`;
      }
      const jobsLocal = path.join(os.tmpdir(), `nd-${jobId}.json`);
      await fs.writeFile(jobsLocal, JSON.stringify([job]));
      const upJ = await runBox(box, 'scp', [...scpArgs(box), jobsLocal, `${box.target}:nd_jobs/${jobId}.json`], { timeoutMs: 30_000, signal });
      fs.unlink(jobsLocal).catch(() => { /* */ });
      if (upJ.code !== 0) return asText(`任务上传失败：\n${upJ.err.slice(-400)}`, true);

      const gen = await runBox(box, 'ssh',
        [...sshArgs(box), `python3 ~/h3box.py video ~/nd_jobs/${jobId}.json`],
        { timeoutMs: TIMEOUT_MS, signal });
      if (gen.code !== 0 || !gen.out.includes('success')) {
        return asText(`盒子产线失败（exit ${gen.code}）：\n${(gen.err || gen.out).slice(-1200)}`, true);
      }
      const pullDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-film-'));
      const pull = await runBox(box, 'scp',
        [...scpArgs(box), `${box.target}:outputs/${jobId}_*.mp4`, pullDir], { timeoutMs: 120_000, signal });
      const got = pull.code === 0 ? (await fs.readdir(pullDir)).filter((f) => f.endsWith('.mp4')) : [];
      if (!got.length) return asText(`成片取回失败：\n${pull.err.slice(-400)}`, true);
      localMp4 = path.join(pullDir, got[0]);
    }

    const wallS = Math.round((Date.now() - t0) / 1000);
    const outDir = path.join(sharedRoot || workspaceRoot, 'assets', 'generated');
    await fs.mkdir(outDir, { recursive: true });
    const fileName = `${name}-${jobId.slice(5)}.mp4`;
    const absOut = path.join(outDir, fileName);
    await fs.rename(localMp4, absOut).catch(async () => {
      await fs.copyFile(localMp4, absOut); await fs.unlink(localMp4).catch(() => { /* */ });
    });
    const sizeBytes = (await fs.stat(absOut)).size;
    const cost = estCostUsd(duration, backend);
    const backendLabel = backend === 'modal' ? 'Modal H100+sage' : '5090 盒子 sage2';

    try {
      const metaDir = path.join(outDir, '.meta');
      await fs.mkdir(metaDir, { recursive: true });
      await fs.writeFile(path.join(metaDir, `${path.parse(fileName).name}.json`), JSON.stringify({
        prompt, kind: 'film', durationS: duration, frames, seed,
        model: backend === 'modal' ? 'minimax-h3-turbo8-h100-sage' : 'minimax-h3-turbo8-5090-sage2',
        estCostUsd: cost, wallClockS: wallS,
        firstFrame: first_frame || null, lastFrame: last_frame || null,
        sessionId: ctx?.sessionId || sessionId || null,
        runId: ctx?.runId || null,
        ts: new Date().toISOString(),
      }, null, 2));
    } catch (e) {
      console.warn(`[roll-film] meta sidecar write failed: ${e.message}`);
    }

    // MCP 工具写盘不走 PostToolUse 那条自动 file_changed —— 必须手动发才当场上墙
    try { ctx?.emit?.(Events.fileChanged(absOut, 'add')); } catch { /* fail-safe */ }

    const agentRelPath = path.posix.join('assets', 'generated', fileName);
    return asText([
      `Shot "${name}" done: ${agentRelPath}`,
      `${duration}s (${frames} frames) seed=${seed} ${(sizeBytes / 1e6).toFixed(1)}MB via ${backendLabel}`,
      `wall ${Math.floor(wallS / 60)}m${wallS % 60}s, est cost ~$${cost}`,
      `Do not open or inspect the file — hand the path to the user for review.`,
    ].join('\n'));
  } catch (err) {
    return asText(`roll_film 失败：${err.message}`, true);
  }
}

/**
 * @param {object} deps
 */
export function makeRollFilmTool(deps) {
  return tool(
    'roll_film',
    `Generate one video shot (picture + native audio track) on the owner's
self-hosted MiniMax-H3 production lane (RTX 5090 box, SageAttention, Turbo
8-step, 24fps). Max 12.25s per shot — longer stories are made of multiple
shots assembled later.

Call ONLY when the user explicitly asks for video. A shot takes roughly 3-6
minutes wall clock: tell the user the camera is rolling before you call, never
fire speculatively, never auto-retry a shot you already got back. Requires the
GPU box to be online — if the tool reports it unreachable, relay that to the
user and stop; there is no automatic fallback.

The prompt must follow the H3 three-field English format (a cookbook is
injected into context on your first call — read it before writing prompts).
For multi-shot films keep character/style blocks verbatim identical across
shots and reuse ONE seed film-wide. Keyframe anchors (first_frame /
last_frame) accept paths like "assets/generated/kf1.png" — generate them with
paint_still or generate_image first, ideally 1344x768.

The clip lands at assets/generated/<name>.mp4 and shows up in the task folder.
DO NOT visually inspect the result — no Read, no screenshot, no vision
checker. Quality control is the user's job: report the file path and move on.`,
    {
      prompt: z.string().describe('H3 three-field English prompt (see injected cookbook)'),
      duration: z.number().min(5.2).max(12.25).default(8)
        .describe('seconds, 5.2-12.25; actual length snaps to the frame grid'),
      name: z.string().regex(/^[\w-]{1,40}$/).describe('shot slug, e.g. "s01-cloud-sea"'),
      seed: z.number().int().default(1101).describe('one seed film-wide for multi-shot work'),
      first_frame: z.string().optional().describe('keyframe anchor path relative to cwd'),
      last_frame: z.string().optional().describe('keyframe anchor path relative to cwd'),
      steps: z.number().int().min(4).max(8).optional()
        .describe('default 8 (best quality); 4 = fast draft with visible loss'),
    },
    (args) => rollFilm(deps, args),
  );
}
