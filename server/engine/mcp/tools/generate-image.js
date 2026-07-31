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
import { spawn } from 'node:child_process';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { Events } from '../../agent/events.js';
import { z } from 'zod';
import sharp from 'sharp';
import {
  THUMBNAIL_MAX_DIM, THUMBNAIL_QUALITY, enqueueWarm, warmSpecsFor,
} from '../../../lib/image-variant.js';

// Thumbnail 配置（env 可调）。**原图不动**——保留 Gemini 输出的全分辨率（通常
// 1080×1920+ PNG，6-8MB）让用户最终交付不损失质量。仅生成低清 thumbnail 给
// chat 缩略图 + WS 推送用，避免单条 message 8MB+ 让浏览器 parse 卡。
// 长边 512 + JPEG q80 → ~50KB，chat / WS 流畅。原图通过 HTTP /api/.../assets/...
// 按需加载（iframe 引用原图，用户点查看大图也加载原图）。
/**
 * 用 sharp 生成低清 thumbnail（不动原图）。
 * 长边 ≤ THUMBNAIL_MAX_DIM；统一 webp 输出。
 *
 * 2026-07-31 从 JPEG 换成 webp：同观感小三成，而且 webp 有 alpha，抠图产物
 * 不用再平铺白底 —— 原来那圈白底在预览里是真能看见的。
 * 规格常量从 lib/image-variant.js 来：资源路由给老图现补缩略图时用的是同一份，
 * 两边各写各的数字只会表现为某些图偶尔糊一点，查不出来。
 *
 * fail-soft：sharp 抛错返 null 让调用方降级。
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
    const buf = await pipeline.webp({ quality: THUMBNAIL_QUALITY }).toBuffer();
    return { buf, mimeType: 'image/webp' };
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

// ── codex 生图桥（2026-07-27：NoDesk 网关退役，codex 成为默认 provider）──
// 骑 codex CLI 订阅（零 API 费）：spawn `codex exec` 让它调自带图像生成工具，
// 图直接落到我们指定的绝对路径。实测单张 ~45-60s，参考图走 -i 附件（同样实测
// 风格参照有效）。桥接 prompt 必须写死"逐字传递零改写"——codex agent 默认会
// 按自己的 Augmentation rules 润色 prompt。
const IMAGE_PROVIDER = () => (process.env.NODESIGN_IMAGE_PROVIDER || 'codex').toLowerCase();
const CODEX_BIN = process.env.NODESIGN_CODEX_BIN || 'codex';
const CODEX_IMAGE_TIMEOUT_MS = Number(process.env.NODESIGN_CODEX_IMAGE_TIMEOUT_MS) || 240_000;

function buildCodexBridgePrompt({ prompt, aspectRatio, absOut, refCount }) {
  return [
    '你是图像生成管道的执行端，只做下面几件事，不做任何多余动作：',
    '1. 调用你的图像生成工具生成一张图。<image-prompt> 标签内的内容必须逐字作为生成 prompt，禁止改写、增删、翻译或润色。',
    `2. 输出比例：${aspectRatio}。优先用工具的比例/尺寸参数；工具没有对应参数时，作为补充说明传给工具，但不修改 <image-prompt> 原文。`,
    refCount > 0
      ? `3. 本消息附带 ${refCount} 张参考图，把它们作为图像生成的参考输入（风格 / 主体一致性参照）。`
      : '3. 本次无参考图。',
    `4. 生成后把图片文件复制到精确路径 ${absOut}（目录已存在）。`,
    '5. 最后只回复该绝对路径。',
    '<image-prompt>',
    prompt,
    '</image-prompt>',
  ].join('\n');
}

/**
 * 跑一次 codex exec 生图，以目标文件落盘为成功标准（codex 的文本回复不可信），
 * 失败自动重试一次。abort signal / 超时都 SIGKILL 子进程。
 */
async function runCodexImageGen({ bridgePrompt, refPaths, cwd, signal, expectFile, timeoutMs = CODEX_IMAGE_TIMEOUT_MS }) {
  const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', cwd, bridgePrompt];
  for (const p of refPaths) args.push('-i', p);

  const runOnce = () => new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stderrTail = '';
    child.stdout.on('data', () => { /* 排空防背压 */ });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      reject(new Error(`codex exec timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', (err) => { clearTimeout(killTimer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      if (signal?.aborted) return reject(new Error('aborted'));
      if (code !== 0) return reject(new Error(`codex exec exited ${code}: ${stderrTail.slice(-300) || 'no stderr'}`));
      resolve();
    });
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await runOnce();
      const st = await fs.stat(expectFile).catch(() => null);
      if (st && st.size > 0) return;
      throw new Error(`codex finished but target file missing/empty: ${expectFile}`);
    } catch (err) {
      if (attempt === 2 || signal?.aborted) throw err;
      console.warn(`[generate-image] codex attempt ${attempt} failed (${err.message}), retrying once`);
    }
  }
}

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
    `Generate a high-quality image.
Use this to add hero / cover / background / frame / icon / decoration / portrait
/ illustration / quote-backdrop / section-divider / pattern visuals to canvas.html.

BACKEND NOTE: default backend is codex-imagegen (subscription). Under it the
parameters that matter are prompt + aspectRatio + referenceImages (+ assetRole /
outputName for naming). imageSize / thinkingLevel / responseModalities / model /
useGrounding are Gemini-gateway-only and silently ignored; PDF referenceImages
are NOT supported (images only). Expect ~45-60s per image — batch wisely and
prefer one good anchor shot over many speculative variants.

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
      // 1. provider 分流（2026-07-27：NoDesk 网关退役，默认 codex 订阅生图；
      //    gateway 分支保留给显式 NODESIGN_IMAGE_PROVIDER=gateway 的场景）
      const provider = IMAGE_PROVIDER();

      // 输出命名 + 目录提前定：codex 分支需要先有确定的目标路径让 codex 落盘
      const finalName = buildOutputName(outputName, assetRole);
      const useShared = !!sharedRoot;
      const outDir = path.join(
        useShared ? sharedRoot : workspaceRoot,
        'assets',
        'generated',
      );
      await fs.mkdir(outDir, { recursive: true });

      // 2. 解析 referenceImages（fail-fast；两个 provider 共用解析，消费方式不同：
      //    codex 用 abs 路径走 -i 附件，gateway 读文件转 base64 inline parts）
      const resolvedRefs = [];
      if (referenceImages && referenceImages.length > 0) {
        for (const rel of referenceImages) {
          try {
            resolvedRefs.push(await resolveReferenceImage(rel, workspaceRoot, sharedRoot));
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `generate_image failed resolving referenceImages[${rel}]: ${err.message}`,
              }],
              isError: true,
            };
          }
        }
      }

      let imgBuf;
      let outMime = 'image/png';
      let accompanyText = null;
      let response = null;   // gateway 分支才有（grounding metadata 从这取）
      let fileName;
      let absOut;

      if (provider === 'codex') {
        const pdfRef = resolvedRefs.find((r) => r.mimeType === 'application/pdf');
        if (pdfRef) {
          return {
            content: [{
              type: 'text',
              text: 'generate_image failed: codex provider 不支持 PDF reference（-i 只收图片）。先把 PDF 内容转述进 prompt，或截图后当图片 reference。',
            }],
            isError: true,
          };
        }
        fileName = `${finalName}.png`;
        absOut = path.join(outDir, fileName);
        const bridgePrompt = buildCodexBridgePrompt({
          prompt, aspectRatio, absOut, refCount: resolvedRefs.length,
        });
        try {
          await runCodexImageGen({
            bridgePrompt,
            refPaths: resolvedRefs.map((r) => r.abs),
            cwd: outDir,
            signal: ctx?.abortController?.signal,
            expectFile: absOut,
          });
        } catch (err) {
          return {
            content: [{
              type: 'text',
              text: `generate_image codex error: ${err?.message || String(err)}`,
            }],
            isError: true,
          };
        }
        imgBuf = await fs.readFile(absOut);
      } else {
        // ── gateway 分支（显式 opt-in）──
        const gatewayUrl = process.env.NODESIGN_GATEWAY_URL || DEFAULT_NODESK_URL;
        const gatewayKey = process.env.NODESIGN_GATEWAY_KEY;
        if (!gatewayKey) {
          return {
            content: [{
              type: 'text',
              text: 'generate_image failed: NODESIGN_IMAGE_PROVIDER=gateway 但 NODESIGN_GATEWAY_KEY 未设。',
            }],
            isError: true,
          };
        }
        const channel = process.env.NODESIGN_GATEWAY_CHANNEL || DEFAULT_CHANNEL;
        const channelBase =
          process.env.NODESIGN_GATEWAY_CHANNEL_URL_BASE || DEFAULT_DMXAPI_BASE;

        const inlineImageParts = [];
        for (const resolved of resolvedRefs) {
          const buf = await fs.readFile(resolved.abs);
          inlineImageParts.push({
            inline_data: {
              mime_type: resolved.mimeType,
              data: buf.toString('base64'),
            },
          });
        }

        // Gemini generateContent payload
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

        // 扩展名跟 Gemini 返回的 mimeType 走（实测 Gemini 3.1 Flash Image
        // 经常返 image/jpeg 而不是 png，硬写 .png 会让文件名和真实编码不一致）
        const ext = (() => {
          switch ((extracted.mimeType || '').toLowerCase()) {
            case 'image/jpeg': case 'image/jpg': return '.jpg';
            case 'image/webp': return '.webp';
            case 'image/gif':  return '.gif';
            case 'image/png':
            default:           return '.png';
          }
        })();
        imgBuf = Buffer.from(extracted.base64, 'base64');
        outMime = extracted.mimeType || 'image/png';
        accompanyText = extracted.accompanyText || null;
        fileName = `${finalName}${ext}`;
        absOut = path.join(outDir, fileName);
        // 原图不压缩——保留全分辨率给最终交付（导出 / iframe 引用）
        await fs.writeFile(absOut, imgBuf);
      }

      // 额外生成 thumbnail（仅给 chat 缩略图 / WS 推送用，原图保留）
      // 落到 .thumbnails/ 子目录，agent 通常不引用（隐藏目录命名暗示），但能被
      // /api/.../assets/.thumbnails/foo.thumb.webp 路径访问（assets endpoint 不限子树）
      const thumbDir = path.join(outDir, '.thumbnails');
      await fs.mkdir(thumbDir, { recursive: true });
      const thumbName = `${finalName}.thumb.webp`;
      const absThumb = path.join(thumbDir, thumbName);
      const thumb = await makeThumbnail(imgBuf);
      if (thumb) {
        await fs.writeFile(absThumb, thumb.buf);
        console.log(`[generate-image] saved ${fileName} ${imgBuf.length}B + thumb ${thumb.buf.length}B`);
      } else {
        console.log(`[generate-image] saved ${fileName} ${imgBuf.length}B (thumb skipped)`);
      }
      const thumbAgentRelPath = thumb ? path.posix.join('assets', 'generated', '.thumbnails', thumbName) : null;

      // 预热派生图：全尺寸 webp / 三档响应式宽度 / 各档 avif，全部排后台串行编。
      //
      // 为什么放在这里：这一刻用户正在等模型说下一句话，CPU 是闲的；而如果不预热，
      // 第一个打开站点的人要在请求路径上等 12 张图各编一次。单核实测冷开一个
      // 12 图站点 5.4s，预热之后 72ms。
      // 不 await：编码是后台队列的事，生图工具不该被它拖住。
      fs.stat(absOut)
        .then(st => enqueueWarm(absOut, st, warmSpecsFor()))
        .catch(() => { /* 预热失败不影响生图，下次请求现编 */ });

      // 语义 sidecar（2026-07-27 工作台）：.meta/<name>.json 记录物件来历，
      // /api/.../artifacts 清单合并给产物墙显示（prompt / 角色 / 来源 run）。
      // fail-soft：写不进不影响生图主流程。
      try {
        const metaDir = path.join(outDir, '.meta');
        await fs.mkdir(metaDir, { recursive: true });
        await fs.writeFile(path.join(metaDir, `${finalName}.json`), JSON.stringify({
          prompt,
          assetRole: assetRole || null,
          aspectRatio,
          provider,
          model: provider === 'codex' ? 'codex' : model,
          referenceImageCount: resolvedRefs.length,
          sessionId: ctx?.sessionId || null,
          runId: ctx?.runId || null,
          ts: new Date().toISOString(),
        }, null, 2));
      } catch (err) {
        console.warn(`[generate-image] meta sidecar write failed: ${err.message}`);
      }

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

      // 7a. emit file_changed —— 让图**当场**上墙。
      //
      // MCP 工具写盘不走 PostToolUse(Write|Edit) 那条 file_changed 直发（matcher
      // 匹配不到 mcp__nodesign__* 工具名），所以生成的图在这一发之前对前端是不存在的：
      // 产物墙只在 listVersion / boardVersion 变化时才重拉 /artifacts，而这两个都要等
      // run.done 的兜底刷新。结果就是"图生完了，要等这一轮跑完才出现在任务文件夹里"。
      // record-decision.js 早就补过同样的一发，这里漏了。
      try {
        ctx?.emit?.(Events.fileChanged(absOut, 'add'));
      } catch { /* fail-safe */ }

      // 7b. emit run.image_generated（前端可显 thumbnail / 加 timeline 节点）
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
          model: provider === 'codex' ? 'codex' : model,   // 前端 badge 显示 + spec.json 审计
          referenceImageCount: resolvedRefs.length,
          accompanyText,
          groundingUsed: groundingPath !== null,           // model 真触发了搜索
          groundingSourceCount,
          groundingPath,                                    // sidecar 相对路径，前端读 attribution HTML
        });
      } catch { /* fail-safe */ }

      // 8. 返回 CallToolResult — text caption + image content block
      const captionParts = [
        `Generated ${fileName}`,
        `at ${agentRelPath}`,
        provider === 'codex'
          ? `(${aspectRatio}, codex-imagegen, ${(imgBuf.length / 1024).toFixed(1)} KB)`
          : `(${aspectRatio}, ${imageSize}, ${model}, ${(imgBuf.length / 1024).toFixed(1)} KB)`,
      ];
      if (assetRole) captionParts.push(`role=${assetRole}`);
      if (resolvedRefs.length > 0) {
        captionParts.push(`with ${resolvedRefs.length} reference image${resolvedRefs.length > 1 ? 's' : ''}`);
      }
      if (groundingPath) {
        captionParts.push(`grounded with ${groundingSourceCount} source${groundingSourceCount > 1 ? 's' : ''}`);
      } else if (useGrounding) {
        captionParts.push('(grounding requested but model didn\'t fire — likely person/character query, see cookbook § L)');
      }
      const caption = captionParts.join(' ');

      const content = [{ type: 'text', text: caption }];
      if (accompanyText) {
        content.push({ type: 'text', text: `Model commentary: ${accompanyText}` });
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
      const imageBlockMime = thumb ? thumb.mimeType : outMime;
      content.push({
        type: 'image',
        data: imageBlockData,
        mimeType: imageBlockMime,
      });
      return { content };
    },
  );
}
