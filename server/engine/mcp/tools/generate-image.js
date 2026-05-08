/**
 * mcp/tools/generate-image.js — generate_image MCP tool
 *
 * 调用 Gemini 3.1 Flash Image Preview（Nano Banana 2）通过 NoDesk passthrough
 * 网关 → DMXAPI 落点。给主 agent 的"画图"能力，让 deck/landing 类产物里
 * 能塞 hero / cover / bg / icon / decoration / portrait / illustration
 * / quote-backdrop / section-divider / pattern。
 *
 * 调用约定（agent 端）：
 *   mcp__nodesign__generate_image
 *     prompt: string                自然描述场景（不堆关键词）
 *     aspectRatio?: enum            14 种官方比例，default '16:9'
 *     imageSize?: '512'|'1K'|'2K'|'4K'  default '1K'
 *     referenceImages?: string[]    workspace 相对路径，max 14
 *                                   （Gemini 3.1 Flash 文档：人物 ≤4、物体 ≤10）
 *     assetRole?: enum              落档语义类，影响 default 命名 + emit 字段
 *     outputName?: string           不带后缀；default `gen-${ts}-${role}`
 *     thinkingLevel?: 'minimal'|'high'  default 'minimal'（latency 优先）
 *     responseModalities?: array    default ['IMAGE']
 *
 * 返回 CallToolResult：
 *   content: [
 *     { type: 'text', text: 'Generated <name>.png at assets/generated/<name>.png ...' },
 *     { type: 'image', data: <base64>, mimeType: 'image/png' },
 *   ]
 *
 * 落地：
 *   优先 <sharedRoot>/assets/generated/<name>.png（跨 session 复用 + 软链让
 *   sessions/<sid>/assets/ 直接看见），fallback <workspaceRoot>/assets/generated/。
 *   从 sessions/<sid>/canvas.html 引用即 `assets/generated/<name>.png`。
 *
 * 网关：
 *   POST <NODESIGN_GATEWAY_URL>/default/passthrough
 *   Authorization: Bearer <NODESIGN_GATEWAY_KEY>
 *   body 顶层注入 channel="DMX" + channel_url=<DMXAPI base>/v1beta/models/<model>:generateContent
 *   剩下字段是 Gemini 标准 generateContent 协议（contents / generationConfig）
 *
 *   不复用 binary-fixup-proxy：那个只接 /v1/messages（Anthropic 协议），
 *   Gemini 走 /v1beta/...。MCP tool 在 server 进程内跑，直接 fetch 最干净。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import sharp from 'sharp';

// 图片压缩配置（env 可调）。Gemini 3.1 Flash 默认输出 1080×1920+ PNG → 单图 6-8MB。
// 不压缩的后果：① iframe 加载 canvas.html 引用的图慢 ② WS 推 base64 给 chat 缩略图
// 单条消息 8MB+ ③ build-standalone 导出 deck inline 后 HTML 25MB 浏览器卡。
// 长边 1920 对设计 deck 视口足够（桌面最多 1080p / 4K 物理像素 2160）；用户极端
// 要求大图可 env 提到 3840。无 alpha PNG 自动转 JPEG 让单图小 5-10x。
const IMAGE_MAX_DIM = Number(process.env.NODESIGN_IMAGE_MAX_DIM) || 1920;
const JPEG_QUALITY = Number(process.env.NODESIGN_IMAGE_JPEG_QUALITY) || 85;

/**
 * 压缩 image buf：长边 ≤ IMAGE_MAX_DIM；JPEG/WebP 用 JPEG_QUALITY；PNG 检测 alpha
 * 决定保留 PNG（有透明）还是转 JPEG（无透明，照片性质 5-10x 缩小）。fail-soft：
 * sharp 抛错时返原 buf 不阻塞 generate_image。
 *
 * @param {Buffer} rawBuf
 * @param {string} mimeType
 * @returns {Promise<{ buf: Buffer, mimeType: string, ext: string|null }>}
 *   ext 非 null 时表示真做了压缩（可能跟原 mime 不同，如 PNG→JPEG）；null 表示
 *   未识别 mime 直接透传，调用方走原 fallback ext 逻辑。
 */
async function compressImageBuf(rawBuf, mimeType) {
  try {
    const meta = await sharp(rawBuf).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    let pipeline = sharp(rawBuf);
    if (longEdge > IMAGE_MAX_DIM) {
      pipeline = pipeline.resize({
        width: (meta.width || 0) >= (meta.height || 0) ? IMAGE_MAX_DIM : null,
        height: (meta.height || 0) > (meta.width || 0) ? IMAGE_MAX_DIM : null,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const lower = (mimeType || '').toLowerCase();
    if (lower === 'image/png' && !meta.hasAlpha) {
      // 无透明的 PNG（背景图 / 角色图照片）转 JPEG 大幅缩小
      const buf = await pipeline.flatten({ background: '#ffffff' })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
      return { buf, mimeType: 'image/jpeg', ext: '.jpg' };
    }
    if (lower === 'image/png') {
      // 有透明保留 PNG（agent 通常出于裁切角色等需求）
      const buf = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      return { buf, mimeType: 'image/png', ext: '.png' };
    }
    if (lower === 'image/jpeg' || lower === 'image/jpg') {
      const buf = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
      return { buf, mimeType: 'image/jpeg', ext: '.jpg' };
    }
    if (lower === 'image/webp') {
      const buf = await pipeline.webp({ quality: JPEG_QUALITY }).toBuffer();
      return { buf, mimeType: 'image/webp', ext: '.webp' };
    }
    // 未识别 mime（gif / 其他）：原样透传
    return { buf: rawBuf, mimeType, ext: null };
  } catch (err) {
    console.warn(`[generate-image] compress failed (${err.message}), keeping raw`);
    return { buf: rawBuf, mimeType, ext: null };
  }
}

const MODEL_ID = 'gemini-3.1-flash-image-preview';

// 14 种官方比例（Gemini 3.1 Flash Image Preview 文档）
const ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4',
  '21:9', '4:1', '1:4', '8:1', '1:8', '3:4', '4:3',
];

const IMAGE_SIZES = ['512', '1K', '2K', '4K'];

const ASSET_ROLES = [
  'hero', 'cover', 'bg', 'frame', 'icon', 'decoration',
  'portrait', 'illustration', 'quote-backdrop', 'section-divider', 'pattern',
];

const RESPONSE_MODALITIES = ['IMAGE', 'TEXT'];

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const DEFAULT_NODESK_URL = 'https://llm-gateway-api.nodesk.tech';
const DEFAULT_DMXAPI_BASE = 'https://www.dmxapi.cn';
const DEFAULT_CHANNEL = 'DMX';

const PASSTHROUGH_PATH = '/default/passthrough';
const GENERATE_CONTENT_PATH = `/v1beta/models/${MODEL_ID}:generateContent`;

/**
 * 把 referenceImages 路径解析到 sharedRoot/workspaceRoot 之一。防止 traversal。
 *
 * @param {string} relPath
 * @param {string} workspaceRoot
 * @param {string|null} sharedRoot
 * @returns {Promise<{ abs: string, mimeType: string }>}
 * @throws {Error} 路径越界 / 文件不存在 / 不支持的 mime
 */
async function resolveReferenceImage(relPath, workspaceRoot, sharedRoot) {
  if (path.isAbsolute(relPath)) {
    throw new Error(
      `referenceImages must be relative paths inside the workspace; got absolute: ${relPath}`,
    );
  }

  const candidates = [workspaceRoot];
  if (sharedRoot) candidates.push(sharedRoot);

  let absResolved = null;
  let baseUsed = null;
  for (const base of candidates) {
    const candidate = path.resolve(base, relPath);
    // 防 traversal：resolved path 必须在 base 之内（含 base 本身）
    if (candidate === base || candidate.startsWith(base + path.sep)) {
      absResolved = candidate;
      baseUsed = base;
      break;
    }
  }
  if (!absResolved) {
    throw new Error(
      `referenceImages path escapes workspace/shared roots: ${relPath}`,
    );
  }

  // 真实存在 + 可读
  await fs.access(absResolved);

  const ext = path.extname(absResolved).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    throw new Error(
      `Unsupported image format ${ext} (allowed: png/jpg/jpeg/webp/gif): ${relPath}`,
    );
  }
  return { abs: absResolved, mimeType, baseUsed };
}

/**
 * 调网关返回 Gemini 响应 body（已 parse）。
 *
 * @returns {Promise<object>} parsed JSON
 * @throws {Error} 401/HTTP 错误 / 网络错误
 */
async function callGateway(payload, { gatewayUrl, gatewayKey, channel, channelBase, signal }) {
  const passthroughUrl = gatewayUrl.replace(/\/$/, '') + PASSTHROUGH_PATH;
  const channelUrl = channelBase.replace(/\/$/, '') + GENERATE_CONTENT_PATH;

  const wrapped = {
    channel,
    channel_url: channelUrl,
    ...payload,
  };

  const res = await fetch(passthroughUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${gatewayKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(wrapped),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const snippet = text.slice(0, 400);
    const hint =
      res.status === 401 || res.status === 403
        ? ' (auth failed — check NODESIGN_GATEWAY_KEY)'
        : res.status === 429
          ? ' (rate limit / quota — try again later)'
          : '';
    throw new Error(`gateway HTTP ${res.status}${hint}: ${snippet}`);
  }
  return await res.json();
}

/**
 * 从 Gemini 响应里提第一张图（base64 PNG）。多张时只取第一。
 * 有些响应 model 会在 thought 阶段产中间图（thought:true）—— 跳掉那些，
 * 取 final（无 thought 标记的）image part。
 *
 * @returns {{ base64: string, mimeType: string, accompanyText: string }}
 * @throws {Error} 无 image part
 */
function extractFinalImage(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Gemini response has no parts');
  }
  let lastImage = null;
  let firstFinalImage = null;
  const accompanyTexts = [];
  for (const p of parts) {
    if (p.inlineData?.data) {
      lastImage = p.inlineData;
      if (!p.thought && !firstFinalImage) firstFinalImage = p.inlineData;
    } else if (p.inline_data?.data) {
      lastImage = p.inline_data;
      if (!p.thought && !firstFinalImage) firstFinalImage = p.inline_data;
    } else if (p.text && !p.thought) {
      accompanyTexts.push(p.text);
    }
  }
  const chosen = firstFinalImage || lastImage;
  if (!chosen) throw new Error('Gemini response has no image data');
  return {
    base64: chosen.data,
    mimeType: chosen.mimeType || chosen.mime_type || 'image/png',
    accompanyText: accompanyTexts.join('\n').trim(),
  };
}

function safeBaseName(s) {
  return String(s || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function buildOutputName(outputName, assetRole) {
  if (outputName) {
    const safe = safeBaseName(outputName);
    if (safe) return safe;
  }
  const ts = Date.now();
  const role = safeBaseName(assetRole || 'image');
  return `gen-${ts}-${role}`;
}

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot       agent cwd（sessions/<sid>/ 模式或老 runId 模式）
 * @param {string|null} [deps.sharedRoot]   project shared/，存在时优先落档于此
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeGenerateImageTool({ workspaceRoot, sharedRoot = null, ctx } = {}) {
  return tool(
    'generate_image',
    `Generate a high-quality image via Gemini 3.1 Flash Image Preview (Nano Banana 2).
Use this to add hero / cover / background / frame / icon / decoration / portrait
/ illustration / quote-backdrop / section-divider / pattern visuals to canvas.html.

Saves the image to assets/generated/<name>.png inside the workspace (visible
across sessions via the shared/ softlink). Returns the image as an inline
content block so you can vision-check it immediately.

PROMPT WRITING (Gemini official guide):
  - Describe the scene narratively, don't list keywords.
  - For photorealism use camera language: 85mm lens, wide-angle, macro,
    golden-hour lighting, three-point softbox, etc.
  - For icons / stickers: explicitly say "white background" (transparent is
    not supported).
  - For text-in-image: state the font style descriptively
    ("clean sans-serif", "bold serif headline").
  - Iterate over multi-turn rather than over-specifying once.

ASPECT RATIO defaults by use:
  - cover/hero/landscape: 16:9 or 21:9
  - portrait/avatar:      4:5 or 2:3
  - icon/sticker/pattern: 1:1
  - vertical banner:      9:16 / 1:4 / 1:8

IMAGE SIZE pricing (tokens scale with size):
  - 512:  747t (avatars, thumbnails)
  - 1K:   1120t (default, most decorations)
  - 2K:   1680t (hero, cover, full-bleed bg)
  - 4K:   2520t (use sparingly — only when print-grade detail matters)

REFERENCE IMAGES (max 14 per Gemini 3.1 Flash docs, ≤4 humans / ≤10 objects):
  Pass workspace-relative paths (e.g., 'assets/photo.jpg' or
  'assets/generated/prev.png'). Use cases:
  - Style transfer: pass an image, describe the new style
  - Character consistency: pass 1-2 portraits across multi-page deck
  - Composition / mockup: pass logo + model image, describe how they combine
  - Inpainting: pass the canvas screenshot, describe what to change

WHEN TO USE:
  - You're building a deck / landing / report and want real imagery
  - You need a backdrop that pure CSS gradient can't achieve
  - You want a sample image to align style with the user before batch-generating
  - You have user-uploaded reference and need to extend / restyle / combine

WHEN NOT TO USE:
  - Pure UI controls (buttons, form fields) — use Tailwind + shadcn instead
  - Data charts — use Recharts/ECharts/Mermaid via React mount
  - Simple inline icons (≤5 per page) — use lucide-react inline SVG

ALWAYS pair generation with mcp__nodesign__record_decision so the prompt + role
become part of the spec.json design history.`,
    {
      prompt: z
        .string()
        .min(4)
        .max(2000)
        .describe('Natural-language scene description. Describe, don\'t list keywords.'),
      aspectRatio: z
        .enum(ASPECT_RATIOS)
        .optional()
        .describe('Output aspect ratio; default 16:9. See doc for use-case mapping.'),
      imageSize: z
        .enum(IMAGE_SIZES)
        .optional()
        .describe('Resolution tier; default 1K. 4K only when print-grade detail required.'),
      referenceImages: z
        .array(z.string().min(1))
        .max(14)
        .optional()
        .describe('Workspace-relative paths to reference images. Max 14. Use for style transfer / character consistency / inpainting.'),
      assetRole: z
        .enum(ASSET_ROLES)
        .optional()
        .describe('Semantic role; affects default output name + UI badge. One of hero/cover/bg/frame/icon/decoration/portrait/illustration/quote-backdrop/section-divider/pattern.'),
      outputName: z
        .string()
        .max(64)
        .optional()
        .describe('Output filename without extension. Auto-generated if omitted (gen-<timestamp>-<role>).'),
      thinkingLevel: z
        .enum(['minimal', 'high'])
        .optional()
        .describe('Gemini thinking budget; "minimal" (default) for low latency, "high" for complex composition.'),
      responseModalities: z
        .array(z.enum(RESPONSE_MODALITIES))
        .min(1)
        .max(2)
        .optional()
        .describe('Output modalities; default ["IMAGE"]. Add "TEXT" if you want the model\'s commentary alongside the image.'),
    },
    async ({
      prompt,
      aspectRatio = '16:9',
      imageSize = '1K',
      referenceImages,
      assetRole,
      outputName,
      thinkingLevel = 'minimal',
      responseModalities = ['IMAGE'],
    }) => {
      // 1. env / 配置
      const gatewayUrl = process.env.NODESIGN_GATEWAY_URL || DEFAULT_NODESK_URL;
      const gatewayKey = process.env.NODESIGN_GATEWAY_KEY;
      if (!gatewayKey) {
        return {
          content: [{
            type: 'text',
            text: 'generate_image failed: NODESIGN_GATEWAY_KEY not set in env. Cannot reach NoDesk passthrough gateway.',
          }],
          isError: true,
        };
      }
      const channel = process.env.NODESIGN_GATEWAY_CHANNEL || DEFAULT_CHANNEL;
      const channelBase =
        process.env.NODESIGN_GATEWAY_CHANNEL_URL_BASE || DEFAULT_DMXAPI_BASE;

      // 2. 解析 referenceImages（fail-fast）
      const inlineImageParts = [];
      if (referenceImages && referenceImages.length > 0) {
        for (const rel of referenceImages) {
          let resolved;
          try {
            resolved = await resolveReferenceImage(rel, workspaceRoot, sharedRoot);
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `generate_image failed resolving referenceImages[${rel}]: ${err.message}`,
              }],
              isError: true,
            };
          }
          const buf = await fs.readFile(resolved.abs);
          inlineImageParts.push({
            inline_data: {
              mime_type: resolved.mimeType,
              data: buf.toString('base64'),
            },
          });
        }
      }

      // 3. 构建 Gemini generateContent payload
      const parts = [{ text: prompt }, ...inlineImageParts];
      const payload = {
        contents: [{ parts }],
        generationConfig: {
          responseModalities,
          imageConfig: {
            aspectRatio,
            imageSize,
          },
          thinkingConfig: {
            thinkingLevel: thinkingLevel === 'high' ? 'High' : 'Minimal',
            includeThoughts: false,
          },
        },
      };

      // 4. 调网关
      let response;
      try {
        response = await callGateway(payload, {
          gatewayUrl,
          gatewayKey,
          channel,
          channelBase,
          signal: ctx?.abortController?.signal,
        });
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `generate_image gateway error: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }

      // 5. 提图
      let extracted;
      try {
        extracted = extractFinalImage(response);
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text:
              `generate_image failed: ${err.message}. `
              + `Response keys: ${Object.keys(response || {}).join(', ')}. `
              + `Try refining the prompt or check gateway logs.`,
          }],
          isError: true,
        };
      }

      // 6. 落地 —— 扩展名跟 Gemini 返回的 mimeType 走（实测 Gemini 3.1
      // Flash Image 经常返 image/jpeg 而不是 png，硬写 .png 会让文件名
      // 和真实编码不一致）。
      const finalName = buildOutputName(outputName, assetRole);

      // 写盘前用 sharp 压缩：长边 ≤ 1920，无 alpha PNG 自动转 JPEG。原始 6-8MB
      // → ~500KB。CallToolResult / 写盘 / emit 都用压缩后的 buf 保持口径一致。
      // ext 优先用 compress 后的（可能 PNG→JPEG），fallback 原 mime 推断。
      const rawBuf = Buffer.from(extracted.base64, 'base64');
      const compressed = await compressImageBuf(rawBuf, extracted.mimeType);
      const imgBuf = compressed.buf;
      const finalMime = compressed.mimeType;
      const ext = compressed.ext || (() => {
        switch ((extracted.mimeType || '').toLowerCase()) {
          case 'image/jpeg': case 'image/jpg': return '.jpg';
          case 'image/webp': return '.webp';
          case 'image/gif':  return '.gif';
          case 'image/png':
          default:           return '.png';
        }
      })();
      const fileName = `${finalName}${ext}`;

      // Pick base: sharedRoot/assets/generated/ if available, else workspaceRoot/assets/generated/
      const useShared = !!sharedRoot;
      const outDir = path.join(
        useShared ? sharedRoot : workspaceRoot,
        'assets',
        'generated',
      );
      await fs.mkdir(outDir, { recursive: true });
      const absOut = path.join(outDir, fileName);
      await fs.writeFile(absOut, imgBuf);

      if (rawBuf.length !== imgBuf.length) {
        const ratio = (imgBuf.length / rawBuf.length * 100).toFixed(0);
        console.log(`[generate-image] compressed ${fileName} ${rawBuf.length}B → ${imgBuf.length}B (${ratio}%)`);
      }

      // Path the agent sees relative to its cwd (sessions/<sid>/) — when
      // sharedRoot is in play, sessions/<sid>/assets is a softlink to
      // shared/assets, so relative path is the same either way.
      const agentRelPath = path.posix.join('assets', 'generated', fileName);

      // 7. emit run.image_generated（前端可显 thumbnail / 加 timeline 节点）
      try {
        ctx?.emit?.({
          type: 'run.image_generated',
          path: agentRelPath,
          absPath: absOut,
          sizeBytes: imgBuf.length,
          prompt,
          assetRole: assetRole || null,
          aspectRatio,
          imageSize,
          referenceImageCount: inlineImageParts.length,
          accompanyText: extracted.accompanyText || null,
        });
      } catch { /* fail-safe */ }

      // 8. 返回 CallToolResult — text caption + image content block
      const captionParts = [
        `Generated ${fileName}`,
        `at ${agentRelPath}`,
        `(${aspectRatio}, ${imageSize}, ${(imgBuf.length / 1024).toFixed(1)} KB)`,
      ];
      if (assetRole) captionParts.push(`role=${assetRole}`);
      if (inlineImageParts.length > 0) {
        captionParts.push(`with ${inlineImageParts.length} reference image${inlineImageParts.length > 1 ? 's' : ''}`);
      }
      const caption = captionParts.join(' ');

      const content = [{ type: 'text', text: caption }];
      if (extracted.accompanyText) {
        content.push({ type: 'text', text: `Model commentary: ${extracted.accompanyText}` });
      }
      content.push({
        type: 'image',
        data: imgBuf.toString('base64'),  // 压缩后的 base64，让 chat 缩略图也是小体积
        mimeType: finalMime,
      });
      return { content };
    },
  );
}
