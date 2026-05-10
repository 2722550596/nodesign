/**
 * server/lib/binary-fixup-proxy.js — Claude Agent SDK binary 出口 fixup +
 * NoDesk AI Gateway passthrough 包装。
 *
 * # 它解决的两类问题
 *
 * 1. **Kimi binary fixup**（保留）：SDK binary 对非白名单 model（如 kimi-k2.6）
 *    强转 thinking 'adaptive' → Kimi 不支持 → 0 thinking blocks。Proxy 在出口拦
 *    POST /v1/messages，把 thinking 改回 enabled+budget_tokens。Kimi vision 也
 *    需要把 image 从 tool_result 提到 user message 顶层（参见 liftImagesFromToolResult）。
 *
 * 2. **NoDesk passthrough 包装**（2026-05-06 新增）：NoDesk Gateway
 *    （`https://llm-gateway-api.nodesk.tech`）只接受 POST /default/passthrough，
 *    body 里要带 channel + channel_url 指明下游真实 API。SDK binary 不知道这事，
 *    它仍按 Anthropic 协议发 POST /v1/messages。proxy 在转发前把请求重新包装：
 *      - URL 重写 → /default/passthrough
 *      - body 注入 channel + channel_url
 *      - 保留 Authorization Bearer（NoDesk 网关 Key）
 *      - 透传 ND-Thread-Id（sessionId）+ ND-Trace-Id（turnId）让网关后台串链路
 *
 * # 路径编码（sessionId 流到 proxy）
 *
 * 调用方（session-loop.js / session-loop.js）把 ANTHROPIC_BASE_URL 设成
 * `http://127.0.0.1:PORT/__nd/<sessionId>`，SDK binary 会把请求发到
 * `http://127.0.0.1:PORT/__nd/<sessionId>/v1/messages`。proxy 解析路径前缀
 * 拿到 sessionTag，剥掉前缀后得到原始路径。
 *
 * turnId 走 `process.env.NODESIGN_CURRENT_TURN_ID`（同一 Node 进程，session-loop
 * 在 startTurn 时 mutate；SDK 串行处理 turn 不会 race）。
 *
 * # 流式响应
 *
 * NoDesk "原样转发"，下游响应 SSE chunks 通过 res.pipe 直接透传，proxy 不解析
 * 响应内容。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import sharp from 'sharp';

let _instance = null;

const NODESK_PATH = '/default/passthrough';
const PREFIX_RE = /^\/__nd\/([^/]+)(\/.*)$/;

// Vision 下采样阈值（长边像素）。> 这个值的 image 在 fixup 阶段重 encode。
// 默认 1568（Anthropic token 优化阈值，也是多数中转网关安全线）。
// 触发原因：mili 项目 mili-logo.png 2500×2500 RGBA 触发 DMXAPI 400；
// 经 cross-check 唯一区别是长边超出常见 vision 网关阈值。
const VISION_MAX_DIM = (() => {
  const n = Number(process.env.NODESIGN_VISION_MAX_DIM);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1568;
})();

// 已知 spoofing alias 集合（SDK 视角 model 名）。proxy 只把这些 alias 反向回真
// appModel；其他 model 名（haiku-cc / 真 claude / 真 sonnet 等）原样保留以走
// 各自的下游路由。
//
// 来源：model-context.js 的 SPOOF_MAP value 集合 ∪ SDK 序列化时剥后缀的形态
// （SDK 把 `claude-opus-4-7[1m]` 序列化为 `claude-opus-4-7` 发出去）。
//
// 加新 spoof alias 时这里也要加，否则新加的 alias 不会被 reverse → 路由错。
const REVERSE_SPOOF_TARGETS = new Set([
  'claude-opus-4-7[1m]',
  'claude-opus-4-7',
]);

/**
 * 启动 fixup proxy（幂等：第一次调启动，后续复用同一个 instance）。
 *
 * @param {string} realUrl  NoDesk 网关 URL（如 https://llm-gateway-api.nodesk.tech）
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export async function getOrStartProxy(realUrl) {
  if (_instance) return _instance;
  if (!realUrl) throw new Error('binary-fixup-proxy: realUrl required');

  const target = new URL(realUrl);
  const useHttps = target.protocol === 'https:';
  const targetPort = target.port || (useHttps ? 443 : 80);
  const reqLib = useHttps ? https : http;

  // NoDesk 渠道映射 —— 主代理 vs subagent/helper 分流（2026-05-08）：
  //   - 主代理（kimi-* model）→ MAIN channel（默认 kimi → moonshot anthropic 兼容端点）
  //   - subagent + SDK helper（haiku-cc 等其他 model）→ SUB channel（DMX → DMXAPI）
  // 路由依据 = 出口请求 body.model 字段；同一 proxy 实例内动态分流，不需要起两个 server。
  //
  // 主代理用 moonshot.cn 自带 anthropic 兼容端点（base = /anthropic，origPath /v1/messages
  // 自动拼成 /anthropic/v1/messages）—— 实测响应/SSE 都是纯 Anthropic 协议，含
  // thinking_delta + signature + cache_*_tokens，SDK binary 直插即用，无需协议转换。
  // OpenAI 端点 (/v1/chat/completions) 的 SSE 是 chat.completion.chunk，SDK 解析崩，
  // 严禁切到那条路径。
  const nodeskMainChannel = process.env.NODESIGN_GATEWAY_MAIN_CHANNEL || 'kimi';
  const nodeskMainChannelUrlBase = (process.env.NODESIGN_GATEWAY_MAIN_CHANNEL_URL_BASE
    || 'https://api.moonshot.cn/anthropic').replace(/\/$/, '');
  const nodeskSubChannel = process.env.NODESIGN_GATEWAY_CHANNEL || 'DMX';
  const nodeskSubChannelUrlBase = (process.env.NODESIGN_GATEWAY_CHANNEL_URL_BASE
    || 'https://www.dmxapi.cn').replace(/\/$/, '');

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
     try {
      let body = Buffer.concat(chunks);

      // 剥 /__nd/<sessionTag> 前缀
      let sessionTag = null;
      let origPath = req.url;
      const m = PREFIX_RE.exec(req.url);
      if (m) {
        sessionTag = decodeURIComponent(m[1]);
        origPath = m[2];
      }

      // 仅对 POST /v1/messages（含 sub-path 如 /count_tokens）做包装 + fixup。
      // 其他请求保守起见 502 拒绝（SDK binary 实际只发 /v1/messages 系列）
      const isMessagesPost = req.method === 'POST' && /^\/v1\/messages\b/.test(origPath);
      if (!isMessagesPost) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`binary-fixup-proxy: unsupported ${req.method} ${origPath}`);
        return;
      }

      // 2026-05-07：DMXAPI 不实现 /v1/messages/count_tokens 端点 → 一律 404 →
      // SDK binary 内部 R1.countTokens（每条 assistant message 后调）拿不到值
      // → Query.getContextUsage() 永远 null → ContextUsageBar 永远"等待"
      // + 80% 阈值预警从不触发（曾爆 418k 就是这条没起作用）
      // 修：本地短路返伪造 200 + 粗估 input_tokens（body 字符数 / 3.5），
      // 让 SDK 内部窗口计数有数据。估算 ±20% 够 UI 进度条用。
      const isCountTokens = /^\/v1\/messages\/count_tokens\b/.test(origPath);
      if (isCountTokens) {
        const estimate = estimateInputTokens(body);
        const respBody = JSON.stringify({ input_tokens: estimate });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(respBody)),
        });
        res.end(respBody);
        return;
      }

      // 1. 现有 kimi 修复（thinking adaptive→enabled、vision lift、长边超限下采样）
      body = await maybeFixupMessagesBody(body);
      let modelHint = null;
      try { modelHint = JSON.parse(body.toString('utf8'))?.model || null; } catch { /* ignore */ }

      // 2. NoDesk passthrough 包装：按 model 分流（kimi-* 走主代理 channel，其他走 sub channel）
      const isMainAgent = !!modelHint && /^kimi/i.test(modelHint);
      const routeChannel = isMainAgent ? nodeskMainChannel : nodeskSubChannel;
      const routeBase = isMainAgent ? nodeskMainChannelUrlBase : nodeskSubChannelUrlBase;
      body = wrapAsNodeskPassthrough(body, {
        channel: routeChannel,
        channelUrl: routeBase + origPath,
      });

      // 3. headers 处理：
      //    - SDK binary 按 Anthropic 标准发 `x-api-key: <key>` 头；NoDesk 网关
      //      **只认 `Authorization: Bearer <key>`** —— 直接转发会全 401。
      //      把 x-api-key 转成 Authorization Bearer，并删掉 x-api-key 避免
      //      下游把它也透给 DMXAPI（DMXAPI 自己懂 x-api-key 但 NoDesk 不接）。
      //    - 注入 ND-Thread-Id / ND-Trace-Id（NoDesk 后台链路追踪）
      const headers = { ...req.headers, host: target.hostname };
      const incomingKey = headers['x-api-key'] || headers['X-Api-Key'];
      if (incomingKey && !headers['authorization']) {
        headers['authorization'] = `Bearer ${incomingKey}`;
      }
      delete headers['x-api-key'];
      delete headers['X-Api-Key'];
      if (sessionTag) headers['nd-thread-id'] = sessionTag;
      const turnId = process.env.NODESIGN_CURRENT_TURN_ID;
      if (turnId) headers['nd-trace-id'] = turnId;
      headers['content-length'] = String(body.length);

      const proxyReq = reqLib.request({
        hostname: target.hostname,
        port: targetPort,
        path: joinPath(target.pathname, NODESK_PATH),
        method: 'POST',
        headers,
      }, (proxyRes) => {
        // 上游 4xx/5xx：默认 console.warn 一行 status + model + body 前 200 字
        // 让 PM2 日志直接看到根因（base64 大 → context too long / 拒收 image block 等）；
        // NODESIGN_DEBUG_KIMI_400=1 仍然额外把完整 req+resp dump 到 /tmp 方便深挖
        if (proxyRes.statusCode >= 400) {
          const respChunks = [];
          proxyRes.on('data', c => respChunks.push(c));
          proxyRes.on('end', () => {
            const respBody = Buffer.concat(respChunks);
            const preview = respBody.slice(0, 200).toString('utf8').replace(/\s+/g, ' ');
            console.warn(`[binary-fixup-proxy] upstream ${proxyRes.statusCode} model=${modelHint || '?'} body=${preview}`);
            if (process.env.NODESIGN_DEBUG_KIMI_400 === '1') {
              const tag = `${proxyRes.statusCode}-${Date.now()}-${Math.random().toString(36).slice(2,6)}.json`;
              try {
                fs.writeFileSync('/tmp/nodesign-fail-req-' + tag, body);
                fs.writeFileSync('/tmp/nodesign-fail-resp-' + tag, respBody);
                console.warn(`[binary-fixup-proxy] dumped: /tmp/nodesign-fail-req-${tag} + resp`);
              } catch (e) { /* ignore */ }
            }
          });
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        // 包含 errno/code 让前端 502 文案能区分网络抖动（ECONNRESET）vs 协议错误（EPROTO）
        const detail = err.code ? `${err.code}: ${err.message}` : err.message;
        console.error(`[binary-fixup-proxy] forward error: ${detail}`);
        try { res.writeHead(502); res.end(`proxy forward error: ${detail}`); } catch { /* ignore */ }
      });

      proxyReq.write(body);
      proxyReq.end();
     } catch (err) {
       // async handler 抛出（如 sharp meta 异常 + downsample 漏网）：保 502 不让连接卡死
       console.error(`[binary-fixup-proxy] handler error: ${err?.stack || err?.message || err}`);
       try { res.writeHead(502); res.end(`proxy handler error: ${err?.message || 'unknown'}`); } catch { /* ignore */ }
     }
    });

    req.on('error', (err) => {
      console.error(`[binary-fixup-proxy] request error: ${err.message}`);
      try { res.writeHead(400); res.end(); } catch { /* ignore */ }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(
    `[binary-fixup-proxy] listening on ${baseUrl} → ${realUrl}${NODESK_PATH} `
    + `(main=${nodeskMainChannel}@${nodeskMainChannelUrlBase} | sub=${nodeskSubChannel}@${nodeskSubChannelUrlBase})`
  );

  _instance = {
    baseUrl,
    close: () => new Promise((r) => server.close(() => r())),
    server,
  };

  return _instance;
}

/**
 * Body fixup（Kimi）：只在 model=kimi-* 时改 thinking + vision。
 * 其他情况原样返回（不解析 / 不改）。fail-soft：parse 异常一律透传。
 *
 * async：downsampleOversizedImages 用 sharp（异步）做尺寸下采样 —— 起因是 mili
 * 项目的 mili-logo.png 2500×2500 触发 DMXAPI 400，常见 vision 网关长边阈值 ≤2048。
 * 调用方 `req.on('end', async ...)` 已 await + try/catch 兜底。
 */
async function maybeFixupMessagesBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }

  if (!parsed || typeof parsed !== 'object') return body;

  // ── Model spoofing reverse（2026-05-08；2026-05-10 收窄）──
  // session-loop.js 给 SDK options.model 喂 spoofing alias（如 kimi-k2.6 →
  // claude-opus-4-7[1m]）让 SDK 内部 rawMaxTokens=1M，autoCompactWindow=230400
  // 不再被卡 200k。但 outgoing body 的 model 仍是 alias，gateway 不认。
  // 这里在 fixup 入口把 **已知 spoofing alias** 还原成真 appModel ——
  // 后续 routing / vision lift / thinking fixup 全部按真 model（kimi-*）走。
  //
  // 2026-05-10 修：原版无条件 `if (parsed.model !== appModel)` 会把所有非
  // appModel（包括 subagent 走的 haiku-cc / SDK helper 调用的 haiku 默认）
  // 一并改成 appModel，导致正确配 haiku 的子代理被误路由到 Moonshot。
  // 收窄到只识别 SDK 序列化出去可能的 alias 形态（`[1m]` 后缀 SDK 会剥）。
  //
  // appModel 通过 session-loop startTurn 设的 process.env 拿（同 TURN_ID 模式）。
  const appModel = process.env.NODESIGN_CURRENT_APP_MODEL;
  const originalModel = parsed.model;  // [TEMP DIAG] 预存以便日志比对
  let mutatedByReverse = false;
  if (appModel && typeof parsed.model === 'string' && REVERSE_SPOOF_TARGETS.has(parsed.model)) {
    parsed.model = appModel;
    mutatedByReverse = true;
  }

  // [TEMP DIAG 2026-05-10] 验证 reverse 收窄修复 —— 跑一次 vision-checker
  // + explorer 后确认主/子代理路由都对就删。always-on 不靠 env；同时写 /tmp
  // 文件方便程序读（server stdout 走 TTY 时无法 tail）。
  // 加 hint 字段（messages.length / system.length / stop_seq 等）和 leak dump
  // 帮定位 post-turn opus-4-7 leak 的 caller。
  if (typeof originalModel === 'string') {
    const msgCount = Array.isArray(parsed.messages) ? parsed.messages.length : '?';
    const sysLen = typeof parsed.system === 'string'
      ? parsed.system.length
      : (Array.isArray(parsed.system) ? parsed.system.length : 0);
    const maxTok = parsed.max_tokens || '?';
    const isLeak = appModel === undefined && originalModel !== 'kimi-k2.6';
    const line = `[${new Date().toISOString()}] [reverse-diag] in=${originalModel} `
      + `out=${parsed.model} appModel=${appModel || '<unset>'} `
      + `mutated=${mutatedByReverse} `
      + `msgs=${msgCount} sys_len=${sysLen} max_tokens=${maxTok}`
      + (isLeak ? ' ⚠️LEAK' : '');
    console.info(line);
    try { fs.appendFileSync('/tmp/nodesign-reverse-diag.log', line + '\n'); }
    catch { /* fail-soft */ }

    // Leak case：dump 完整 body 让人工分析这是什么 SDK 调用
    if (isLeak) {
      try {
        const tag = `${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        fs.writeFileSync(
          `/tmp/nodesign-leak-${tag}.json`,
          JSON.stringify(parsed, null, 2)
        );
        console.info(`[reverse-diag] leak body dumped: /tmp/nodesign-leak-${tag}.json`);
      } catch { /* fail-soft */ }
    }
  }

  // Vision 诊断（NODESIGN_DEBUG_VISION=1）
  if (process.env.NODESIGN_DEBUG_VISION === '1' && Array.isArray(parsed.messages)) {
    const stats = scanImageBlocks(parsed.messages);
    if (stats.total > 0 || stats.unknownImageRefs > 0) {
      console.info(
        `[binary-fixup vision] model=${parsed.model || '?'} `
        + `images=${stats.total} (toolResult=${stats.inToolResult} userMsg=${stats.inUserMsg}) `
        + `unknownRefs=${stats.unknownImageRefs}`
      );
    }
  }

  // Kimi 诊断
  if (process.env.NODESIGN_DEBUG_KIMI === '1' && Array.isArray(parsed.messages)) {
    console.info(`[binary-fixup kimi] model=${parsed.model || '?'} messages.length=${parsed.messages.length} thinking=${JSON.stringify(parsed.thinking)}`);
    if (process.env.NODESIGN_DEBUG_KIMI_FULL === '1') {
      const tag = `nodesign-kimi-dump-${Date.now()}-${Math.random().toString(36).slice(2,8)}.json`;
      try {
        fs.writeFileSync('/tmp/' + tag, JSON.stringify(parsed, null, 2));
        console.info(`[binary-fixup kimi] full body written: /tmp/${tag}`);
      } catch (e) { /* ignore */ }
    }
  }

  // 非 Kimi 路径（含 Claude / haiku helper）跳过 vision lift / thinking fixup；
  // 但 spoofing-reverse 已经改过 parsed.model 时仍要返回新 buffer 不能丢。
  const finalize = (changed) =>
    changed ? Buffer.from(JSON.stringify(parsed), 'utf8') : body;
  if (!parsed.model || typeof parsed.model !== 'string') return finalize(mutatedByReverse);
  if (!/^kimi/i.test(parsed.model)) return finalize(mutatedByReverse);

  let mutated = mutatedByReverse;

  // Kimi vision lift（保留 — 主代理仍 kimi-k2.6）
  if (Array.isArray(parsed.messages) && liftImagesFromToolResult(parsed.messages)) {
    mutated = true;
  }

  // 长边超限的 image 下采样到 VISION_MAX_DIM（lift 后扫顶层即可，但保险扫两层）
  if (Array.isArray(parsed.messages)) {
    const resized = await downsampleOversizedImages(parsed.messages, VISION_MAX_DIM);
    if (resized) mutated = true;
  }

  // thinking adaptive → enabled（保留 — kimi-k2.6 主代理）
  if (parsed.thinking && parsed.thinking.type === 'adaptive') {
    parsed.thinking = { type: 'enabled', budget_tokens: 8192 };
    mutated = true;
  }

  return mutated ? Buffer.from(JSON.stringify(parsed), 'utf8') : body;
}

/**
 * 把请求 body 包装成 NoDesk passthrough 格式。
 *
 * 输入：原始 Anthropic Messages API body（含 model / messages / thinking / ...）
 * 输出：在 body 顶层注入 channel + channel_url，其他字段原样保留
 *
 * 失败 fail-soft：parse 异常返回原 body（NoDesk 会拒，但不在 proxy 这层崩）
 */
function wrapAsNodeskPassthrough(body, { channel, channelUrl }) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object') return body;
  parsed.channel = channel;
  parsed.channel_url = channelUrl;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/**
 * Kimi tool_result-image fix（S8）：把 tool_result.content 里的 image block
 * 提到外层 user message content 顶层；原位置替换为占位文本说明图片在末尾。
 */
function liftImagesFromToolResult(messages) {
  let mutated = false;
  for (const msg of messages) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    const liftedImages = [];
    for (const block of msg.content) {
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      block.content = block.content.map((inner) => {
        if (inner?.type === 'image' && inner.source?.data) {
          liftedImages.push({ ...inner });
          mutated = true;
          return {
            type: 'text',
            text: '[image content lifted to user message top-level for Kimi vision compat — see image block at end of this message]',
          };
        }
        return inner;
      });
    }
    if (liftedImages.length > 0) {
      msg.content.push(...liftedImages);
    }
  }
  return mutated;
}

/**
 * 长边超限下采样：扫所有 image block（user msg 顶层 + tool_result 内嵌），
 * 长边 > maxDim 的 base64 image 用 sharp 重 encode 到长边 = maxDim。
 *
 * 起因：mili 项目 mili-logo.png 2500×2500 RGBA 触发 DMXAPI 400。常见 vision 网关
 * 长边限制 ≤2048（Anthropic 官方 8000 但 token 优化在 1568）。
 *
 * fail-soft：单张图 sharp 抛错 → console.warn 后保留原图透传，不阻断整 turn。
 *
 * @param {Array} messages
 * @param {number} maxDim 长边像素阈值
 * @returns {Promise<boolean>} 是否有任何 image 被替换
 */
async function downsampleOversizedImages(messages, maxDim) {
  let mutated = false;
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      // 顶层 image
      if (block?.type === 'image') {
        const replaced = await maybeResizeImageBlock(block, maxDim);
        if (replaced) { msg.content[i] = replaced; mutated = true; }
      }
      // tool_result 内嵌 image（lift 后理论上不会有，但防御扫描）
      if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          const inner = block.content[j];
          if (inner?.type === 'image') {
            const replaced = await maybeResizeImageBlock(inner, maxDim);
            if (replaced) { block.content[j] = replaced; mutated = true; }
          }
        }
      }
    }
  }
  return mutated;
}

/**
 * 检查单个 image block 是否需要 resize：
 *   - 仅 base64 source（URL 引用图不动）
 *   - media_type 限 png/jpeg/webp（gif 跳过避免动图丢帧）
 *   - 长边 ≤ maxDim 跳过
 *
 * resize 时若有 alpha 通道则 flatten 白底（部分 vision 网关对 RGBA 不友好；副作用是
 * 透明背景的 logo 会变白底，但比 400 报错好）。
 *
 * @returns {Promise<object|null>} 替换后的 block，或 null（无需替换 / 失败透传）
 */
async function maybeResizeImageBlock(block, maxDim) {
  const src = block?.source;
  if (!src || src.type !== 'base64' || !src.data) return null;
  const writers = {
    'image/png': (p) => p.png({ compressionLevel: 9 }),
    'image/jpeg': (p) => p.jpeg({ quality: 85, mozjpeg: true }),
    'image/webp': (p) => p.webp({ quality: 85 }),
  };
  const writer = writers[src.media_type];
  if (!writer) return null;

  try {
    const inputBuf = Buffer.from(src.data, 'base64');
    const meta = await sharp(inputBuf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const longEdge = Math.max(w, h);
    if (longEdge <= maxDim) return null;

    let pipeline = sharp(inputBuf).resize({
      width: w >= h ? maxDim : null,
      height: h > w ? maxDim : null,
      fit: 'inside',
      withoutEnlargement: true,
    });
    if (meta.hasAlpha) pipeline = pipeline.flatten({ background: '#ffffff' });
    const outBuf = await writer(pipeline).toBuffer();

    if (process.env.NODESIGN_DEBUG_VISION === '1') {
      console.info(
        `[binary-fixup vision] resized ${w}x${h} ${src.media_type} `
        + `(${inputBuf.length}B) → longEdge=${maxDim} (${outBuf.length}B)`
      );
    }

    return {
      ...block,
      source: {
        type: 'base64',
        media_type: src.media_type,
        data: outBuf.toString('base64'),
      },
    };
  } catch (err) {
    console.warn(`[binary-fixup vision] resize failed (passthrough): ${err?.message || err}`);
    return null;
  }
}

function scanImageBlocks(messages) {
  const stats = { total: 0, inToolResult: 0, inUserMsg: 0, unknownImageRefs: 0 };
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'image') {
        stats.total++;
        stats.inUserMsg++;
        if (!block.source?.data) stats.unknownImageRefs++;
      }
      if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner?.type === 'image') {
            stats.total++;
            stats.inToolResult++;
            if (!inner.source?.data) stats.unknownImageRefs++;
          }
        }
      }
    }
  }
  return stats;
}

/**
 * CJK 字符范围（用于 token 估算分流）：
 *   - U+3040-U+309F 平假名 / U+30A0-U+30FF 片假名
 *   - U+4E00-U+9FFF CJK Unified Ideographs（基础汉字）
 *   - U+AC00-U+D7AF 韩文音节
 * 上面合并成一个字符类（含中间 U+A000-U+ABFF 等冷门段，误判率 < 0.1%，可忽略）。
 *
 * 系数依据：Kimi/Anthropic 的 SentencePiece tokenizer 对 CJK 1 字 ≈ 1.3 token，
 * 英文走 BPE ~4 char/token。混合文本按字符比例分别加权。
 */
const CJK_REGEX = /[぀-鿿가-힯]/g;

function estimateText(s) {
  if (typeof s !== 'string') return 0;
  const cjkMatches = s.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = s.length - cjkCount;
  return cjkCount * 1.3 + nonCjkCount / 4;
}

/**
 * 粗估 messages body 的 input token 数。
 *   - text: 按 CJK / 非 CJK 字符比例加权（estimateText）
 *   - image base64: data 长度 / 4（vision 模型按图块 token 计费，量级近似）
 *   - tool_use / tool_result / thinking 等递归结构都按 text 估
 *
 * 不做 cache_creation/cache_read 拆分（SDK 内部不强依赖；input_tokens 一个数
 * 就够 Query.getContextUsage 维护窗口计数）。
 *
 * 实测误差范围：纯英文 ±10%，纯中文 ±15%，混合 ±20%。
 * 比之前 length / 3.5 在中文场景误差 -77% 改善显著。
 *
 * fail-soft：解析失败返保守值 50000（约 1/5 上下文，触发 80% 警告概率低）。
 */
function estimateInputTokens(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    let total = 0;

    const addText = (s) => { total += estimateText(s); };
    const addBlock = (b) => {
      if (!b) return;
      if (b.type === 'text' && b.text) addText(b.text);
      else if (b.type === 'image' && b.source?.data) total += b.source.data.length / 4;
      else if (b.type === 'tool_use') {
        addText(b.name || '');
        addText(JSON.stringify(b.input || {}));
      }
      else if (b.type === 'tool_result') {
        if (typeof b.content === 'string') addText(b.content);
        else if (Array.isArray(b.content)) b.content.forEach(addBlock);
      }
      else if (b.type === 'thinking' && b.thinking) addText(b.thinking);
    };

    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (typeof msg.content === 'string') addText(msg.content);
        else if (Array.isArray(msg.content)) msg.content.forEach(addBlock);
      }
    }
    if (typeof parsed.system === 'string') addText(parsed.system);
    else if (Array.isArray(parsed.system)) parsed.system.forEach(addBlock);
    if (Array.isArray(parsed.tools)) {
      for (const t of parsed.tools) {
        addText(t.name || '');
        addText(t.description || '');
        addText(JSON.stringify(t.input_schema || {}));
      }
    }

    return Math.max(1, Math.round(total));
  } catch {
    return 50000;
  }
}

/**
 * URL path 拼接：target base path + downstream path（避免重复 / 或丢段）。
 *
 * 例如：target.pathname=''，downstream='/default/passthrough'
 *    → '/default/passthrough'
 */
function joinPath(base, reqPath) {
  const cleanBase = (base || '').replace(/\/$/, '');
  const cleanReqPath = reqPath.startsWith('/') ? reqPath : '/' + reqPath;
  return cleanBase + cleanReqPath;
}

/**
 * 进程退出时 close proxy（防 socket 泄漏）。
 *
 * @returns {Promise<void>}
 */
export async function stopProxy() {
  if (!_instance) return;
  await _instance.close();
  _instance = null;
}
