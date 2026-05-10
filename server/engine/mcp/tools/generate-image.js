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
import { removeBackground as rembgRemove, isAvailable as rembgIsAvailable } from './helpers/rembg.js';

// Thumbnail 配置（env 可调）。**原图不动**——保留 Gemini 输出的全分辨率（通常
// 1080×1920+ PNG，6-8MB）让用户最终交付不损失质量。仅生成低清 thumbnail 给
// chat 缩略图 + WS 推送用，避免单条 message 8MB+ 让浏览器 parse 卡。
// 长边 512 + JPEG q80 → ~50KB，chat / WS 流畅。原图通过 HTTP /api/.../assets/...
// 按需加载（iframe 引用原图，用户点查看大图也加载原图）。
const THUMBNAIL_MAX_DIM = Number(process.env.NODESIGN_THUMBNAIL_MAX_DIM) || 512;
const THUMBNAIL_QUALITY = Number(process.env.NODESIGN_THUMBNAIL_QUALITY) || 80;

/**
 * 用 sharp 生成低清 thumbnail（不动原图）。
 * 长边 ≤ THUMBNAIL_MAX_DIM；统一 JPEG 输出（小 + 兼容性好）；有 alpha 平铺白底
 * 让 JPEG 不丢透明边角的视觉信息。fail-soft：sharp 抛错返 null 让调用方降级。
 *
 * @param {Buffer} rawBuf
 * @returns {Promise<{ buf: Buffer, mimeType: string }|null>}
 */
async function makeThumbnail(rawBuf) {
  try {
    const meta = await sharp(rawBuf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    let pipeline = sharp(rawBuf);
    const longEdge = Math.max(w, h);
    if (longEdge > THUMBNAIL_MAX_DIM) {
      pipeline = pipeline.resize({
        width: w >= h ? THUMBNAIL_MAX_DIM : null,
        height: h > w ? THUMBNAIL_MAX_DIM : null,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    if (meta.hasAlpha) {
      pipeline = pipeline.flatten({ background: '#ffffff' });
    }
    const buf = await pipeline.jpeg({ quality: THUMBNAIL_QUALITY, mozjpeg: true }).toBuffer();
    return { buf, mimeType: 'image/jpeg' };
  } catch (err) {
    console.warn(`[generate-image] thumbnail failed (${err.message}), chat will use raw or skip`);
    return null;
  }
}

// Model 路由：默认 flash (NB2)；anchor 类关键图（cover / character bible
// identity sheet / brand mockup hero）可升 pro 拿 commercial-grade 质量。
// Pro 比 Flash 慢 + 贵 ~2-3×，但质量提升对"会被复用为 referenceImages 种子"
// 的图值得——种子错了下游全漂、整个 deck 返工成本更高。
// spike 实测 NoDesk + DMXAPI 两个 model id 都通。
const MODELS = {
  flash: 'gemini-3.1-flash-image-preview',
  pro: 'gemini-3-pro-image-preview',
};
const DEFAULT_MODEL = 'flash';

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
  // PDF：NB2 支持文档输入（generateContent inline_data application/pdf）。
  // spike 实测 NoDesk + DMXAPI 透传通，且 NB2 真读 PDF 文本生成准确数据
  // 可视化（Q3 sales report PDF → 4 stat card 信息图，数字一一对上）。
  // 用例详见 cookbook § K Document-to-visual。
  '.pdf': 'application/pdf',
};

const DEFAULT_NODESK_URL = 'https://llm-gateway-api.nodesk.tech';
const DEFAULT_DMXAPI_BASE = 'https://www.dmxapi.cn';
const DEFAULT_CHANNEL = 'DMX';

const PASSTHROUGH_PATH = '/default/passthrough';
// model id 在 callGateway 时动态拼，因为支持 flash / pro 路由
const generateContentPathFor = (modelId) => `/v1beta/models/${modelId}:generateContent`;

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
      `Unsupported reference format ${ext} (allowed: png/jpg/jpeg/webp/gif/pdf): ${relPath}`,
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
async function callGateway(payload, { gatewayUrl, gatewayKey, channel, channelBase, modelId, signal }) {
  const passthroughUrl = gatewayUrl.replace(/\/$/, '') + PASSTHROUGH_PATH;
  const channelUrl = channelBase.replace(/\/$/, '') + generateContentPathFor(modelId);

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

REFERENCES (max 14 per Gemini 3.1 Flash docs, ≤4 character / ≤10 object):
  Pass workspace-relative paths (e.g., 'assets/photo.jpg' or
  'assets/generated/prev.png'). Image formats: png/jpg/jpeg/webp/gif.
  PDF documents (.pdf) also accepted — NB2 reads PDF text + tables and can
  generate accurate visualizations from them (research reports, brand
  guidelines, outlines). See cookbook § K Document-to-visual.
  Use cases:
  - Style transfer: pass an image, describe the new style
  - Character consistency: pass 1-2 portraits across multi-page deck
  - Composition / mockup: pass logo + model image, describe how they combine
  - Inpainting: pass the canvas screenshot, describe what to change
  - Document → infographic: pass a PDF, describe the target visualization

GROUNDING (useGrounding: true, opt-in):
  Lets NB2 invoke Google Image Search during generation for real-world
  visual fidelity. Best for landmarks / cities / real products / nature /
  specific brand contexts. Adds ~60-90s latency. Auto-skipped by model
  for people/character queries (Google guardrail) — those return same as
  vanilla generation. See cookbook § L Image Search Grounding.

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
        .describe('Workspace-relative paths to references (png/jpg/webp/gif image OR .pdf document). Max 14 (≤4 character + ≤10 object). Use for style transfer / character consistency / inpainting / document-to-visual (cookbook § E + § K).'),
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
      model: z
        .enum(['flash', 'pro'])
        .optional()
        .describe('NB2 model tier; "flash" (default, gemini-3.1-flash-image-preview) for most images. "pro" (gemini-3-pro-image-preview, ~2-3× slower & costlier) only for anchor shots that become referenceImages seeds for downstream pages — cover hero / character bible identity sheet / brand mockup hero. See cookbook § H model routing.'),
      useGrounding: z
        .boolean()
        .optional()
        .describe('Enable Google Image Search grounding for real-world subjects (landmarks / cities / products / nature / specific brands). Default false. When true, model can pull real images from web during generation to anchor visual fidelity. Adds ~60-90s latency. Model auto-skips for people/character queries (Google guardrail). Sources saved to <name>.grounding.json sidecar. See cookbook § L.'),
      removeBackground: z
        .boolean()
        .optional()
        .describe('Auto-remove background after generation, output transparent RGBA PNG. Uses rembg (U²-Net ML segmentation, server-side). Adds ~5-10s on first call (onnxruntime cold start) + ~1-2s subsequent. Output forced to .png regardless of Gemini-returned mime. Use for icons / characters / objects / logos / products to overlay onto existing canvas content (esp. when canvas bg color clashes with NB2 default fill). Limitations: heuristic segmentation — clean cuts on subjects with clear visual boundaries; subjects with thin transparent elements (glass / smoke / wispy hair) may have soft / inaccurate edges.'),
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
      model = DEFAULT_MODEL,
      useGrounding = false,
      removeBackground = false,
    }) => {
      const modelId = MODELS[model];
      if (!modelId) {
        return {
          content: [{
            type: 'text',
            text: `generate_image failed: unknown model '${model}'. Use 'flash' or 'pro'.`,
          }],
          isError: true,
        };
      }
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
        // Image Search Grounding：opt-in。NB2 自决要不要真用（人物 query
        // 模型自动跳过，Google guardrail；地标/产品/真实场景才会触发）。
        ...(useGrounding ? { tools: [{ googleSearch: {} }] } : {}),
      };

      // 4. 调网关
      let response;
      try {
        response = await callGateway(payload, {
          gatewayUrl,
          gatewayKey,
          channel,
          channelBase,
          modelId,
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
      // 和真实编码不一致）。removeBackground=true 时强制 .png（RGBA 必须 PNG）。
      const finalName = buildOutputName(outputName, assetRole);
      const geminiExt = (() => {
        switch ((extracted.mimeType || '').toLowerCase()) {
          case 'image/jpeg': case 'image/jpg': return '.jpg';
          case 'image/webp': return '.webp';
          case 'image/gif':  return '.gif';
          case 'image/png':
          default:           return '.png';
        }
      })();

      // 6a. 抠背景（可选）——rembg U²-Net 跑在 server/.venv-rembg/，spawn python
      // subprocess。fail-soft：rembg 失败 / 不可用 → 落原图，warning 注 text 让
      // agent 知道走了降级（决定要不要重生 / 改 prompt / 接受原图）。
      let imgBuf = Buffer.from(extracted.base64, 'base64');
      let ext = geminiExt;
      let rembgWarning = '';
      if (removeBackground) {
        const rembgCheck = await rembgIsAvailable();
        if (!rembgCheck.available) {
          rembgWarning = ` (removeBackground requested but rembg unavailable: ${rembgCheck.reason}; saved original with bg)`;
          console.warn(`[generate-image] rembg skipped: ${rembgCheck.reason}`);
        } else {
          const t0 = Date.now();
          const rgba = await rembgRemove(imgBuf);
          const elapsed = Date.now() - t0;
          if (rgba) {
            imgBuf = rgba;
            ext = '.png';  // RGBA 必须 PNG
            console.log(`[generate-image] rembg removed bg in ${elapsed}ms (${rgba.length}B)`);
          } else {
            rembgWarning = ' (removeBackground failed in subprocess; saved original with bg — see server logs)';
          }
        }
      }
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
      // 原图不压缩——保留 Gemini 输出的全分辨率给最终交付（导出 / iframe 引用）
      await fs.writeFile(absOut, imgBuf);

      // 额外生成 thumbnail（仅给 chat 缩略图 / WS 推送用，原图保留）
      // 落到 .thumbnails/ 子目录，agent 通常不引用（隐藏目录命名暗示），但能被
      // /api/.../assets/.thumbnails/foo.thumb.jpg 路径访问（assets endpoint 不限子树）
      const thumbDir = path.join(outDir, '.thumbnails');
      await fs.mkdir(thumbDir, { recursive: true });
      const thumbName = `${finalName}.thumb.jpg`;
      const absThumb = path.join(thumbDir, thumbName);
      const thumb = await makeThumbnail(imgBuf);
      if (thumb) {
        await fs.writeFile(absThumb, thumb.buf);
        console.log(`[generate-image] saved ${fileName} ${imgBuf.length}B + thumb ${thumb.buf.length}B`);
      } else {
        console.log(`[generate-image] saved ${fileName} ${imgBuf.length}B (thumb skipped)`);
      }
      const thumbAgentRelPath = thumb ? path.posix.join('assets', 'generated', '.thumbnails', thumbName) : null;

      // Path the agent sees relative to its cwd (sessions/<sid>/) — when
      // sharedRoot is in play, sessions/<sid>/assets is a softlink to
      // shared/assets, so relative path is the same either way.
      const agentRelPath = path.posix.join('assets', 'generated', fileName);

      // 6.5 提 grounding metadata（仅 useGrounding=true 且 model 真触发了搜索时存在）
      // 落 sidecar `<name>.grounding.json` 给前端 attribution UI / spec.json 审计用。
      // 模型对人物 query 自动跳过 grounding，那时这块为空——不落 sidecar，行为同普通生图。
      const candidate = response?.candidates?.[0] || {};
      const groundingMetadata = candidate.groundingMetadata || candidate.grounding_metadata;
      let groundingPath = null;
      let groundingSourceCount = 0;
      let groundingQueries = [];
      let groundingTopSources = [];
      if (groundingMetadata) {
        const sidecarName = `${finalName}.grounding.json`;
        const absSidecar = path.join(outDir, sidecarName);
        try {
          await fs.writeFile(absSidecar, JSON.stringify(groundingMetadata, null, 2));
          groundingPath = path.posix.join('assets', 'generated', sidecarName);
        } catch (err) {
          console.warn(`[generate-image] grounding sidecar write failed: ${err.message}`);
        }
        const chunks = groundingMetadata.groundingChunks || [];
        groundingSourceCount = chunks.length;
        groundingQueries = (groundingMetadata.webSearchQueries || []).slice(0, 5);
        groundingTopSources = chunks.slice(0, 5).map((c) => ({
          title: c.web?.title || null,
          uri: c.web?.uri || null,
        }));
      }

      // 7. emit run.image_generated（前端可显 thumbnail / 加 timeline 节点）
      try {
        ctx?.emit?.({
          type: 'run.image_generated',
          path: agentRelPath,             // 原图路径（agent 引用 + 前端"查看大图"链接）
          thumbnailPath: thumbAgentRelPath,  // null 时表示 thumbnail 生成失败
          absPath: absOut,
          sizeBytes: imgBuf.length,
          thumbnailSizeBytes: thumb?.buf.length || null,
          prompt,
          assetRole: assetRole || null,
          aspectRatio,
          imageSize,
          model,            // 'flash' | 'pro'，区分前端 badge 显示 + spec.json 审计
          referenceImageCount: inlineImageParts.length,
          accompanyText: extracted.accompanyText || null,
          groundingUsed: groundingPath !== null,           // model 真触发了搜索
          groundingSourceCount,
          groundingPath,                                    // sidecar 相对路径，前端读 attribution HTML
        });
      } catch { /* fail-safe */ }

      // 8. 返回 CallToolResult — text caption + image content block
      const captionParts = [
        `Generated ${fileName}`,
        `at ${agentRelPath}`,
        `(${aspectRatio}, ${imageSize}, ${model}, ${(imgBuf.length / 1024).toFixed(1)} KB)`,
      ];
      if (assetRole) captionParts.push(`role=${assetRole}`);
      if (inlineImageParts.length > 0) {
        captionParts.push(`with ${inlineImageParts.length} reference image${inlineImageParts.length > 1 ? 's' : ''}`);
      }
      if (groundingPath) {
        captionParts.push(`grounded with ${groundingSourceCount} source${groundingSourceCount > 1 ? 's' : ''}`);
      } else if (useGrounding) {
        captionParts.push('(grounding requested but model didn\'t fire — likely person/character query, see cookbook § L)');
      }
      if (removeBackground && !rembgWarning) {
        captionParts.push('with transparent background (rembg U²-Net)');
      } else if (rembgWarning) {
        captionParts.push(rembgWarning.trim());
      }
      const caption = captionParts.join(' ');

      const content = [{ type: 'text', text: caption }];
      if (extracted.accompanyText) {
        content.push({ type: 'text', text: `Model commentary: ${extracted.accompanyText}` });
      }
      if (groundingPath) {
        // 给 agent 看到本次 grounding 用的搜索 + top sources，方便它在回话里
        // 简短报给用户（"grounded with 5 sources from <queries>"）；完整 attribution
        // HTML 在 sidecar 里供前端 chip UI 读。
        const sourceLines = groundingTopSources
          .filter((s) => s.title || s.uri)
          .map((s, i) => `  [${i + 1}] ${s.title || ''} ${s.uri || ''}`.trim())
          .join('\n');
        content.push({
          type: 'text',
          text:
            `Image Search Grounding active.\n`
            + `Queries: ${groundingQueries.join(' | ') || '(none)'}\n`
            + `Top sources (${groundingSourceCount} total):\n${sourceLines || '  (none)'}\n`
            + `Full attribution metadata: ${groundingPath}`,
        });
      }
      // image content block 用 thumbnail base64（原图通过 HTTP 按需加载，不走 WS）：
      // 原图 base64 化后单条 WS message 8MB+ 让浏览器 parse 卡 / nginx upstream 也痛苦。
      // thumbnail ~50KB 推 chat 缩略图够清晰，用户看大图点开走 HTTP /api/.../assets/...
      // agent 仍能通过 caption 里的 agentRelPath 引用原图（`<img src="assets/generated/foo.png">`）。
      // thumbnail 失败时降级回原 base64（保险，agent 至少能看到图）。
      const imageBlockData = thumb ? thumb.buf.toString('base64') : imgBuf.toString('base64');
      const imageBlockMime = thumb ? thumb.mimeType : extracted.mimeType;
      content.push({
        type: 'image',
        data: imageBlockData,
        mimeType: imageBlockMime,
      });
      return { content };
    },
  );
}
