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

let _instance = null;

const NODESK_PATH = '/default/passthrough';
const PREFIX_RE = /^\/__nd\/([^/]+)(\/.*)$/;

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

  // NoDesk 渠道映射 —— 当前所有模型走同一 channel（DMX → DMXAPI）
  const nodeskChannel = process.env.NODESIGN_GATEWAY_CHANNEL || 'DMX';
  const nodeskChannelUrlBase = (process.env.NODESIGN_GATEWAY_CHANNEL_URL_BASE
    || 'https://www.dmxapi.cn').replace(/\/$/, '');

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
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

      // 1. 现有 kimi 修复（thinking adaptive→enabled、vision lift）
      body = maybeFixupMessagesBody(body);
      let modelHint = null;
      try { modelHint = JSON.parse(body.toString('utf8'))?.model || null; } catch { /* ignore */ }

      // 2. NoDesk passthrough 包装：注入 channel + channel_url
      body = wrapAsNodeskPassthrough(body, {
        channel: nodeskChannel,
        channelUrl: nodeskChannelUrlBase + origPath,
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
        if (process.env.NODESIGN_DEBUG_KIMI_400 === '1' && proxyRes.statusCode >= 400) {
          const tag = `400-${Date.now()}-${Math.random().toString(36).slice(2,6)}.json`;
          try {
            fs.writeFileSync('/tmp/nodesign-fail-req-' + tag, body);
            console.warn(`[binary-fixup-proxy] ${proxyRes.statusCode} response — request body saved: /tmp/nodesign-fail-req-${tag}`);
          } catch (e) { /* ignore */ }
          const respChunks = [];
          proxyRes.on('data', c => respChunks.push(c));
          proxyRes.on('end', () => {
            try {
              fs.writeFileSync('/tmp/nodesign-fail-resp-' + tag, Buffer.concat(respChunks));
              console.warn(`[binary-fixup-proxy] response body saved: /tmp/nodesign-fail-resp-${tag}`);
            } catch (e) { /* ignore */ }
          });
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error(`[binary-fixup-proxy] forward error: ${err.message}`);
        try { res.writeHead(502); res.end(`proxy forward error: ${err.message}`); } catch { /* ignore */ }
      });

      proxyReq.write(body);
      proxyReq.end();
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
  console.log(`[binary-fixup-proxy] listening on ${baseUrl} → ${realUrl}${NODESK_PATH} (channel=${nodeskChannel})`);

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
 */
function maybeFixupMessagesBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }

  if (!parsed || typeof parsed !== 'object') return body;

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

  if (!parsed.model || typeof parsed.model !== 'string') return body;
  if (!/^kimi/i.test(parsed.model)) return body;

  let mutated = false;

  // Kimi vision lift（保留 — 主代理仍 kimi-k2.6）
  if (Array.isArray(parsed.messages) && liftImagesFromToolResult(parsed.messages)) {
    mutated = true;
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
