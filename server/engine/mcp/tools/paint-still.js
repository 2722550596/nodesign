/**
 * mcp/tools/paint-still.js — paint_still MCP tool（2026-08-08；批量制+FLUX.2 同晚补上）
 *
 * 站主本地 GPU 盒子生图。一次调用 = 一批（1-16 张，串行渲、出一张上墙一张）。
 * 三档模型：noobai（danbooru 标签，商用可）/ anima（自然语言，非商用）/
 * krea2（Krea 2 Turbo 12B 审美向，自然语言，个人免费；08-08 FLUX.2 因效果差下架）。
 * 配方 = 08-08 实测/官方模板。盒子不在线就明说，不静默降级。
 * 落盘/缩略图/事件照 generate-image.js；视觉 QC 一律归用户，只回文本路径。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import sharp from 'sharp';
import { Events } from '../../agent/events.js';
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import {
  THUMBNAIL_MAX_DIM, THUMBNAIL_QUALITY, enqueueWarm, warmSpecsFor,
} from '../../../lib/image-variant.js';
import { boxConfig, shq, runBox, sshArgs, scpArgs } from './h3box-ssh.js';

const SSH_TIMEOUT_MS = Number(process.env.NODESIGN_H3BOX_TIMEOUT_MS) || 240_000;
// krea2 bf16 24G 全驻卡；换模型后的首张要付一次装载（~1 分钟），给足余量
const TIMEOUT_BY_MODEL = { noobai: SSH_TIMEOUT_MS, anima: SSH_TIMEOUT_MS, krea2: 400_000 };

async function makeThumbnail(rawBuf) {
  try {
    const meta = await sharp(rawBuf).metadata();
    const w = meta.width || 0; const h = meta.height || 0;
    let pipeline = sharp(rawBuf);
    if (Math.max(w, h) > THUMBNAIL_MAX_DIM) {
      pipeline = pipeline.resize({
        width: w >= h ? THUMBNAIL_MAX_DIM : null,
        height: h > w ? THUMBNAIL_MAX_DIM : null,
        fit: 'inside', withoutEnlargement: true,
      });
    }
    const buf = await pipeline.webp({ quality: THUMBNAIL_QUALITY }).toBuffer();
    return { buf, mimeType: 'image/webp' };
  } catch (err) {
    console.warn(`[paint-still] thumbnail failed (${err.message})`);
    return null;
  }
}

/** 单张落盘 + 缩略图 + sidecar + 上墙事件；返回 caption 行 */
async function landStill({ imgBuf, still, seed, outDir, ctx, sessionId, wallS }) {
  const finalName = `still-${still.jobId}-${still.name}`;
  const fileName = `${finalName}.png`;
  const absOut = path.join(outDir, fileName);
  await fs.writeFile(absOut, imgBuf);

  const thumbDir = path.join(outDir, '.thumbnails');
  await fs.mkdir(thumbDir, { recursive: true });
  const thumb = await makeThumbnail(imgBuf);
  let thumbAgentRelPath = null;
  if (thumb) {
    await fs.writeFile(path.join(thumbDir, `${finalName}.thumb.webp`), thumb.buf);
    thumbAgentRelPath = path.posix.join('assets', 'generated', '.thumbnails', `${finalName}.thumb.webp`);
  }
  fs.stat(absOut)
    .then((st) => enqueueWarm(absOut, st, warmSpecsFor()))
    .catch(() => { /* 预热失败下次请求现编 */ });

  try {
    const metaDir = path.join(outDir, '.meta');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(path.join(metaDir, `${finalName}.json`), JSON.stringify({
      prompt: still.prompt, negative: still.negative || null, provider: 'h3box',
      model: still.model, seed, size: still.size,
      sessionId: ctx?.sessionId || sessionId || null,
      runId: ctx?.runId || null,
      ts: new Date().toISOString(),
    }, null, 2));
  } catch (e) { console.warn(`[paint-still] meta sidecar failed: ${e.message}`); }

  // 发**工作区相对路径**（fileChanged 的正字法，hooks 同款）——发绝对路径的话
  // 前端寻址/版本记账全部静默失配（2026-08-14 普查改）
  try { ctx?.emit?.(Events.fileChanged(path.posix.join('assets', 'generated', finalName), 'add')); } catch { /* fail-safe */ }
  try {
    ctx?.emit?.({
      type: 'run.image_generated',
      path: path.posix.join('assets', 'generated', fileName),
      thumbnailPath: thumbAgentRelPath,
      absPath: absOut,
      sizeBytes: imgBuf.length,
      thumbnailSizeBytes: thumb?.buf.length || null,
      prompt: still.prompt, assetRole: null, aspectRatio: null, imageSize: still.size,
      model: `h3box-${still.model}`, referenceImageCount: 0, accompanyText: null,
    });
  } catch { /* fail-safe */ }

  return `[${still.name}] assets/generated/${fileName} — ${still.model} ${still.size} seed=${seed} ${(imgBuf.length / 1024).toFixed(0)}KB ${wallS}s`;
}

/** 核心流程（从 handler 拆出，便于不起 SDK 直接实弹测试） */
export async function paintStills(
  { workspaceRoot, sharedRoot, projectId, sessionId, ctx },
  { stills },
) {
  const asText = (text, isError = false) =>
    ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
  try {
    const box = boxConfig();
    if (!box) {
      return asText('本地生图盒子未配置（站主没开机或没设 NODESIGN_H3BOX_SSH）。转告用户，改用 generate_image。', true);
    }
    const project = getProject(projectId);
    if (!project) return asText('错误：项目不存在', true);
    const owner = project.ownerId ? getUserById(project.ownerId) : null;
    if (owner?.lifetimeCostLimitUsd != null) {
      return asText('试用账号不能使用本地生图盒子 —— 改用 generate_image。', true);
    }
    if (owner?.role !== 'admin' && !owner?.allowLocalGen) {
      return asText('本地生图盒子是批准制 —— 该账号还没被站主开通，改用 generate_image。', true);
    }

    const outDir = path.join(sharedRoot || workspaceRoot, 'assets', 'generated');
    await fs.mkdir(outDir, { recursive: true });
    const signal = ctx?.abortController?.signal;
    const batch = Date.now().toString(36);
    const lines = []; const failed = [];

    for (let i = 0; i < stills.length; i++) {
      const still = stills[i];
      still.jobId = `${batch}p${i}`;
      const seed = still.seed ?? ((Date.now() + i * 7919) % 1_000_000);
      const remoteCmd = [
        'python3 ~/h3box.py image',
        `-p ${shq(still.prompt)}`,
        `--model ${still.model}`,
        `--seed ${seed}`,
        `--size ${still.size}`,
        `--name ${still.jobId}`,
        still.negative ? `--neg ${shq(still.negative)}` : '',
        still.lora ? `--lora ${shq(still.lora)} --lora-strength ${still.lora_strength ?? 0.8}` : '',
      ].filter(Boolean).join(' ');

      const t0 = Date.now();
      const gen = await runBox(box, 'ssh', [...sshArgs(box), remoteCmd],
        { timeoutMs: TIMEOUT_BY_MODEL[still.model] || SSH_TIMEOUT_MS, signal });
      let failMsg = null; let imgBuf = null;
      if (gen.code !== 0) {
        failMsg = gen.code === 255 ? `盒子连不上（没开机/地址过期）：${(gen.err || '').slice(-300)}`
          : `生成失败 exit ${gen.code}：${(gen.err || gen.out).slice(-500)}`;
      } else {
        const remotePaths = gen.out.split('\n').map((l) => l.trim())
          .filter((l) => l.includes('/outputs/') && /\.(png|webp|jpg)$/.test(l));
        if (!remotePaths.length) failMsg = `盒子跑完但没报出文件路径：${gen.out.slice(-400)}`;
        else {
          const tmpLocal = path.join(os.tmpdir(), `${still.jobId}${path.extname(remotePaths[0])}`);
          const pull = await runBox(box, 'scp',
            [...scpArgs(box), `${box.target}:${remotePaths[0]}`, tmpLocal], { timeoutMs: 60_000 });
          if (pull.code !== 0) failMsg = `取图失败：${pull.err.slice(-300)}`;
          else {
            imgBuf = await fs.readFile(tmpLocal);
            fs.unlink(tmpLocal).catch(() => { /* */ });
          }
        }
      }
      const wallS = Math.round((Date.now() - t0) / 1000);
      if (imgBuf) {
        lines.push(await landStill({ imgBuf, still, seed, outDir, ctx, sessionId, wallS }));
      } else {
        failed.push(`[${still.name}] ${failMsg}`);
        break;   // 串行批中途失败即停：后张大概率同因，别空烧
      }
      if (signal?.aborted) break;
    }

    const head = `Batch done ${lines.length}/${stills.length} stills`;
    const lic = lines.some((l) => / anima /.test(l))
      ? 'License note: anima outputs are non-commercial.' : null;
    const tail = 'Do not open or inspect the images — hand the paths to the user for review.';
    if (failed.length) {
      return asText([head, ...lines, 'FAILED（批在此中断）：', ...failed, lic, tail]
        .filter(Boolean).join('\n'), lines.length === 0);
    }
    return asText([head, ...lines, lic, tail].filter(Boolean).join('\n'));
  } catch (err) {
    return asText(`paint_still 失败：${err.message}`, true);
  }
}

/**
 * @param {object} deps
 */
export function makePaintStillTool(deps) {
  return tool(
    'paint_still',
    `Generate anime/illustration images on the owner's local GPU box. One call =
one batch of 1-16 stills rendered serially; each finished image lands on the
canvas immediately.

Models per still:
- "noobai" (default): danbooru tags, comma-separated ("1girl, silver hair,
  witch hat, cloud sea, sunrise, wide shot, cinematic lighting"). ~20-40s.
  Commercially safe. Best tag-level control for anime.
- "anima": natural-language English. ~20-40s. NON-COMMERCIAL license.
- "krea2": Krea 2 Turbo 12B — natural-language English, aesthetic-first
  training that avoids the flat "AI look"; strong photoreal/editorial vibes.
  8-step distilled, seconds per image once warm (first call after another
  model loads 24GB, ~1 min). Free for individuals/small teams. The negative
  field is a no-op for this model — describe what you want instead.

Use for anime needs and video keyframes (1344x768 matches the video lane).
For photoreal/general images use generate_image. Requires the box online —
if unreachable, tell the user and fall back to generate_image.

Ready-made LoRAs supported per still (lora + lora_strength) — the cookbook
lists the installed Krea 2 style pack; for others only use filenames the user
explicitly provides.

Outputs land at assets/generated/still-*.png. DO NOT visually inspect —
no Read, no screenshot, no vision checker. QC is the user's job: reference
files by path only.`,
    {
      stills: z.array(z.object({
        prompt: z.string().describe('danbooru tags (noobai) or natural English (anima/flux2)'),
        model: z.enum(['noobai', 'anima', 'krea2']).default('noobai'),
        negative: z.string().optional(),
        size: z.string().regex(/^\d{3,4}x\d{3,4}$/).default('1344x768'),
        seed: z.number().int().optional().describe('omit for fresh random per still'),
        name: z.string().regex(/^[\w-]{1,40}$/).default('still'),
        lora: z.string().optional().describe('LoRA filename in the box loras/ dir; only use names from the cookbook list or given by the user'),
        lora_strength: z.number().min(0).max(1.5).optional().describe('default 0.8'),
      })).min(1).max(16).describe('stills rendered serially in one batch'),
    },
    (args) => paintStills(deps, args),
  );
}
