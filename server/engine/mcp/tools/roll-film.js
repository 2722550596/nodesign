/**
 * mcp/tools/roll-film.js — roll_film MCP tool（2026-08-08）
 *
 * 自部署 MiniMax-H3 视频产线。管线只有一条 = 08-08 定档的主力线路：
 * Modal H100 + SageAttention(int8) + Turbo 8 步，单镜 ≤12.25s（294 帧）。
 * 溢价档（flash 15s / B200）故意不暴露 —— agent 面前没有多余的旋钮。
 *
 * 花的是站主 Modal 余额（~$0.10-0.28/条），闸门按项目 owner 算（试用号拒），
 * 模式同 publish-site.js。产物落 assets/generated/ 上墙（视频以文件卡显示）。
 *
 * 视觉 QC 一律归用户（08-08 用户定）：工具只回文本路径，不回 image block，
 * 描述里写死不许 Read / 截图 / vision-checker。
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

const H3_REPO = process.env.NODESIGN_H3_REPO || '/home/wangang-dev/projects/minimax-h3-modal';
const MODAL_BIN = process.env.NODESIGN_MODAL_BIN || path.join(os.homedir(), '.local/bin/modal');
const TIMEOUT_MS = Number(process.env.NODESIGN_FILM_TIMEOUT_MS) || 900_000; // 冷容器+装载 ~3min + 采样 ≤3min，留一倍余量

/** H3 帧数约束：24fps 且 ≡5 (mod 17)；主力线路安全域 ≤294 帧（12.25s）。 */
function frameCount(durationS) {
  const f = Math.max(5, Math.round(durationS * 24));
  return f + ((5 - (f % 17)) % 17 + 17) % 17;
}

/** 边际成本估算（实测锚点线性插值，只进 caption/sidecar，不进任何账务表）。 */
function estCostUsd(d) {
  const pts = [[5.17, 0.10], [8, 0.16], [10, 0.21], [12.25, 0.28]];
  if (d <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (d <= pts[i][0]) {
      const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
      return Math.round((y0 + (d - x0) * (y1 - y0) / (x1 - x0)) * 100) / 100;
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
 * @param {object} deps
 */
export function makeRollFilmTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }) {
  return tool(
    'roll_film',
    `Generate one video shot (picture + native audio track) on the self-hosted
MiniMax-H3 production lane (Modal H100 + SageAttention, Turbo 8-step, 24fps).
Max 12.25s per shot — longer stories are made of multiple shots assembled later.

Call ONLY when the user explicitly asks for video. Every call spends real money
from the owner's Modal balance (~$0.10-0.28 per shot) and takes 4-8 minutes wall
clock: tell the user the camera is rolling before you call, never fire
speculatively, never auto-retry a shot you already got back.

The prompt must follow the H3 three-field English format (a cookbook is injected
into context on your first call — read it before writing prompts). For
multi-shot films keep character/style blocks verbatim identical across shots and
reuse ONE seed film-wide. Keyframe anchors (first_frame / last_frame) accept
paths like "assets/generated/kf1.png" — generate them with paint_still or
generate_image first, ideally 1344x768.

The clip lands at assets/generated/<name>.mp4 and shows up in the task folder.
DO NOT visually inspect the result — no Read, no screenshot, no vision checker.
Quality control is the user's job: report the file path and move on.`,
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
    async ({ prompt, duration, name, seed, first_frame, last_frame, steps }) => {
      const asText = (text, isError = false) =>
        ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
      try {
        // 闸门按项目 owner（MCP 工具拿不到 req.user，模式同 publish_site）
        const project = getProject(projectId);
        if (!project) return asText('错误：项目不存在', true);
        const owner = project.ownerId ? getUserById(project.ownerId) : null;
        if (!owner) return asText('错误：找不到项目归属用户', true);
        if (owner.lifetimeCostLimitUsd != null) {
          return asText('试用账号不能使用自部署视频产线 —— 想用可以找站主换正式邀请码。原话转告用户，不要重试。', true);
        }

        const frames = frameCount(duration);
        if (frames > 294) {
          return asText(`${frames} 帧超出主力线路安全域 294 帧（12.25s）。拆成多镜。`, true);
        }

        const job = {
          name, prompt, seed,
          duration, width: 1344, height: 768,
        };
        if (steps) job.steps = steps;
        for (const [slot, p] of [['first_frame', first_frame], ['last_frame', last_frame]]) {
          if (!p) continue;
          const abs = path.resolve(workspaceRoot || process.cwd(), p);
          try {
            const st = await fs.stat(abs);
            if (!st.isFile()) throw new Error('not a file');
          } catch {
            return asText(`${slot} 找不到：${p}（先用 paint_still / generate_image 生成关键帧）`, true);
          }
          job[slot] = abs;
        }

        const jobId = `film-${Date.now().toString(36)}`;
        job.name = jobId; // Modal 侧文件名用唯一 id，展示名保留在 name 参数里
        const jobsPath = path.join(os.tmpdir(), `nd-${jobId}.json`);
        await fs.writeFile(jobsPath, JSON.stringify([job]));

        const t0 = Date.now();
        const { code, out, err } = await runModal(
          ['run', 'h3_comfy.py', '--jobs-file', jobsPath], {
            cwd: H3_REPO, signal: ctx?.abortController?.signal,
          });
        fs.unlink(jobsPath).catch(() => { /* */ });
        const wallS = Math.round((Date.now() - t0) / 1000);
        if (code !== 0) {
          return asText(`视频产线失败（exit ${code}, ${wallS}s）：\n${(err || out).slice(-1200)}`, true);
        }

        // main() 把成片落在 <repo>/outputs/<jobId>_*.mp4
        const outRepo = path.join(H3_REPO, 'outputs');
        const hits = (await fs.readdir(outRepo)).filter((f) => f.startsWith(`${jobId}_`) && f.endsWith('.mp4'));
        if (!hits.length) {
          return asText(`产线跑完但没找到成片（${wallS}s）。尾部输出：\n${out.slice(-800)}`, true);
        }

        const outDir = path.join(sharedRoot || workspaceRoot, 'assets', 'generated');
        await fs.mkdir(outDir, { recursive: true });
        const fileName = `${name}-${jobId.slice(5)}.mp4`;
        const absOut = path.join(outDir, fileName);
        await fs.rename(path.join(outRepo, hits[0]), absOut);
        const sizeBytes = (await fs.stat(absOut)).size;
        const cost = estCostUsd(duration);

        // 语义 sidecar（同 generate-image：产物墙读它显来历）
        try {
          const metaDir = path.join(outDir, '.meta');
          await fs.mkdir(metaDir, { recursive: true });
          await fs.writeFile(path.join(metaDir, `${path.parse(fileName).name}.json`), JSON.stringify({
            prompt, kind: 'film', durationS: duration, frames, seed,
            model: 'minimax-h3-turbo8-h100-sage',
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
          `${duration}s (${frames} frames) seed=${seed} ${(sizeBytes / 1e6).toFixed(1)}MB`,
          `wall ${Math.floor(wallS / 60)}m${wallS % 60}s, est cost ~$${cost.toFixed(2)}`,
          `Do not open or inspect the file — hand the path to the user for review.`,
        ].join('\n'));
      } catch (err) {
        return asText(`roll_film 失败：${err.message}`, true);
      }
    },
  );
}
