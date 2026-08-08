/**
 * mcp/tools/paint-still.js — paint_still MCP tool（2026-08-08）
 *
 * 站主本地 GPU 盒子（租用 5090 等）上的动漫生图：NoobAI-XL（danbooru 标签，
 * 商用可）/ Anima（自然语言，非商用许可）。通过 SSH 调盒子上的 h3box.py，
 * 配方 = 08-08 实测定档（28 步，~20-40s/张）。盒子不在线就明说，agent 转
 * 告用户或退回 generate_image —— 不静默降级。
 *
 * 落盘/缩略图/事件全套照抄 generate-image.js（同一面产物墙）。
 * 视觉 QC 一律归用户（08-08 用户定）：不回 image block，只回文本路径。
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

/**
 * @param {object} deps
 */
export function makePaintStillTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }) {
  return tool(
    'paint_still',
    `Generate an anime-style illustration on the owner's local GPU box
(self-hosted, ~20-40s per image, 28 steps, no per-image cost).

Two models:
- "noobai" (default): prompt in danbooru tags, comma-separated, e.g.
  "1girl, silver hair, witch hat, black robe, riding broom, cloud sea, sunrise,
  wide shot, cinematic lighting, depth of field". Quality tags are prepended
  automatically. Commercially safe.
- "anima": natural-language English prompt, strong aesthetics.
  NON-COMMERCIAL license — never use it for work the user will sell.

Use this for anime/illustration needs and video keyframes (1344x768 matches the
video lane). For photoreal or general-purpose images use generate_image instead.
Requires the box to be online: if the tool reports it unreachable, tell the user
and fall back to generate_image — do not retry blindly.

Output lands at assets/generated/<name>.png. DO NOT visually inspect the result
— no Read, no screenshot, no vision checker. Quality control is the user's job:
reference the file by its path and move on.`,
    {
      prompt: z.string().describe('danbooru tags (noobai) or natural English (anima)'),
      model: z.enum(['noobai', 'anima']).default('noobai'),
      negative: z.string().optional().describe('extra negative prompt (defaults are sane)'),
      size: z.string().regex(/^\d{3,4}x\d{3,4}$/).default('1344x768')
        .describe('WxH; 1344x768 for video keyframes'),
      seed: z.number().int().optional().describe('omit for a fresh random seed'),
      name: z.string().regex(/^[\w-]{1,40}$/).default('still').describe('output slug'),
    },
    async ({ prompt, model, negative, size, seed, name }) => {
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

        const theSeed = seed ?? (Date.now() % 1_000_000);
        const jobId = `nd${Date.now().toString(36)}`;
        const remoteCmd = [
          'python3 ~/h3box.py image',
          `-p ${shq(prompt)}`,
          `--model ${model}`,
          `--seed ${theSeed}`,
          `--size ${size}`,
          `--name ${jobId}`,
          negative ? `--neg ${shq(negative)}` : '',
        ].filter(Boolean).join(' ');

        const t0 = Date.now();
        const gen = await runBox(box, 'ssh', [...sshArgs(box), remoteCmd],
          { timeoutMs: SSH_TIMEOUT_MS, signal: ctx?.abortController?.signal });
        if (gen.code !== 0) {
          const reason = gen.code === 255 ? '盒子连不上（没开机/地址过期）' : `生成失败 exit ${gen.code}`;
          return asText(`${reason}：\n${(gen.err || gen.out).slice(-600)}\n转告用户，可改用 generate_image。`, true);
        }
        const remotePaths = gen.out.split('\n').map((l) => l.trim())
          .filter((l) => l.includes('/outputs/') && /\.(png|webp|jpg)$/.test(l));
        if (!remotePaths.length) {
          return asText(`盒子跑完但没报出文件路径。输出尾部：\n${gen.out.slice(-600)}`, true);
        }

        const tmpLocal = path.join(os.tmpdir(), `${jobId}${path.extname(remotePaths[0])}`);
        const pull = await runBox(box, 'scp',
          [...scpArgs(box), `${box.target}:${remotePaths[0]}`, tmpLocal], { timeoutMs: 60_000 });
        if (pull.code !== 0) {
          return asText(`取图失败：\n${pull.err.slice(-400)}`, true);
        }
        const imgBuf = await fs.readFile(tmpLocal);
        fs.unlink(tmpLocal).catch(() => { /* */ });

        // 落盘 + 缩略图 + sidecar + 事件：与 generate-image 同一面墙同一套仪式
        const outDir = path.join(sharedRoot || workspaceRoot, 'assets', 'generated');
        await fs.mkdir(outDir, { recursive: true });
        const finalName = `still-${jobId}-${name}`;
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
            prompt, negative: negative || null, provider: 'h3box', model,
            seed: theSeed, size,
            sessionId: ctx?.sessionId || sessionId || null,
            runId: ctx?.runId || null,
            ts: new Date().toISOString(),
          }, null, 2));
        } catch (e) {
          console.warn(`[paint-still] meta sidecar write failed: ${e.message}`);
        }

        try { ctx?.emit?.(Events.fileChanged(absOut, 'add')); } catch { /* fail-safe */ }
        try {
          ctx?.emit?.({
            type: 'run.image_generated',
            path: path.posix.join('assets', 'generated', fileName),
            thumbnailPath: thumbAgentRelPath,
            absPath: absOut,
            sizeBytes: imgBuf.length,
            thumbnailSizeBytes: thumb?.buf.length || null,
            prompt, assetRole: null, aspectRatio: null, imageSize: size,
            model: `h3box-${model}`, referenceImageCount: 0, accompanyText: null,
          });
        } catch { /* fail-safe */ }

        const wallS = Math.round((Date.now() - t0) / 1000);
        return asText([
          `Painted ${fileName} at assets/generated/${fileName}`,
          `(${model}, ${size}, seed=${theSeed}, ${(imgBuf.length / 1024).toFixed(0)} KB, ${wallS}s)`,
          model === 'anima' ? 'License note: anima output is non-commercial.' : null,
          'Do not open or inspect the image — hand the path to the user for review.',
        ].filter(Boolean).join('\n'));
      } catch (err) {
        return asText(`paint_still 失败：${err.message}`, true);
      }
    },
  );
}
