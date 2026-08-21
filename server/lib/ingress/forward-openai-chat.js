/**
 * lib/ingress/forward-openai-chat.js — openai-chat 协议上游的转发体（08-21）。
 * 从 model-ingress.js 拆出来（行数棘轮）：转换在 ./openai-chat.js，这里只管 HTTP 往返。
 * 调用方给 target/path/agent（出站连接池与 joinPath 住 model-ingress，不反向依赖）。
 */
import http from 'node:http';
import https from 'node:https';
import { toOpenAIChatRequest, fromOpenAIChatResponse, toAnthropicError, OpenAIToAnthropicSSE, truncationOfChatResponse } from './openai-chat.js';

/**
 * OpenAI chat 上游：请求体转换 → POST <base>/chat/completions → 响应转回 Anthropic
 * （流式走 OpenAIToAnthropicSSE，非流式整包转，错误体转 Anthropic error 形状）。
 * ⚠️ 不转发 binary 带来的任何请求头（anthropic-version/beta 头对它无意义，UA 要自己给：
 * Cloudflare 对某些默认 UA 回 1010）。
 */
export function forwardOpenAIChat({ parsed, wire, key, res, sidShort, target, path, agent, onOutcome = () => {}, onBilling = () => {}, onTruncated = () => {} }) {
  const wantStream = !!parsed.stream;
  // onOutcome(ok, reason)：每次往返报一次结果，model-ingress 据此记会话连续失败计数（upstream-fail-streak.js）
  // onBilling({ costUsd, usage })：上游自报的费用/用量（/zen/go 的 cost 字段），model-ingress 按会话累加给记账（upstream-billing.js）
  // onTruncated(reason|null)：这次往返是不是「说到一半被掐」（upstream-truncation.js）。每次往返都报一次
  //   —— null 表示收得完整，会把会话上的旧标记清掉。
  const body = toOpenAIChatRequest(parsed, { reasoningEffort: wire.reasoningEffort, maxOutput: wire.maxOutput });
  const outBody = Buffer.from(JSON.stringify(body), 'utf8');
  const useHttps = target.protocol === 'https:';
  const headers = {
    host: target.hostname,
    'content-type': 'application/json',
    'content-length': String(outBody.length),
    accept: wantStream ? 'text/event-stream' : 'application/json',
    'user-agent': 'NoDesign-ingress/1 (+https://nodesign.xiaobuyu.trade)',
    authorization: `Bearer ${key}`,
  };
  const proxyReq = (useHttps ? https : http).request({
    hostname: target.hostname,
    port: target.port || (useHttps ? 443 : 80),
    path,
    method: 'POST',
    headers,
    agent,
  }, (proxyRes) => {
    const status = proxyRes.statusCode || 502;
    if (status >= 400) {
      const chunks = [];
      let settled = false;
      proxyRes.on('data', (c) => chunks.push(c));
      // 错误体也可能传到一半被掐（Zen 的空体 503 正是这条路）：'end' 不来 → res 从没
      // writeHead 也从没 end，请求就那么悬着，CLI 只能干等它自己的 300s 流空闲超时，
      // 而且 onOutcome 没报、止损计数看不见它（fable 评审 P1）。
      proxyRes.on('aborted', () => proxyRes.emit('error', Object.assign(new Error('upstream aborted'), { code: 'ECONNRESET' })));
      proxyRes.on('error', (err) => {
        if (settled) return;
        settled = true;
        const detail = err.code || err.message;
        console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} ${status} 错误体传到一半断了（${detail}）`);
        onOutcome(false, `HTTP ${status} (aborted: ${detail})`);
        if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
        const errBody = JSON.stringify(toAnthropicError(status, `${wire.upstream?.label || wire.upstreamId} 上游返回 ${status}（响应还没传完就断了）—— 稍后再发一次`));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(errBody)) });
        res.end(errBody);
      });
      proxyRes.on('end', () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} ${status} model=${wire.wireModel} body=${text.slice(0, 200).replace(/\s+/g, ' ')}`);
        // 空体的 5xx（Zen 08-21 连回三个 503 body 空）：给用户一句能懂的话，别让 CLI 只显示 "HTTP 503"
        const msg = text.trim() ? text : `${wire.upstream?.label || wire.upstreamId} 上游返回 ${status}（模型暂时不可用，稍后再发一次）`;
        onOutcome(false, `HTTP ${status}`);
        const errBody = JSON.stringify(toAnthropicError(status, msg));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(errBody)) });
        res.end(errBody);
      });
      return;
    }
    if (wantStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const xf = new OpenAIToAnthropicSSE({ model: parsed.model, label: wire.upstream?.label || wire.upstreamId });
      xf.on('error', (err) => { console.error(`[model-ingress] sse transform error: ${err.message}`); onOutcome(false, `transform: ${err.message}`); try { res.end(); } catch { /* ignore */ } });
      // 转换层以 error 事件收场（私货 finish / 早断流 / 空体）→ 算一次失败；正常收尾算成功
      xf.on('end', () => {
        onOutcome(!xf.failReason, xf.failReason || '');
        onTruncated(xf.truncated);
        if (xf.cost != null || xf.usage) onBilling({ costUsd: xf.cost, usage: xf.usage });
      });
      // ⛔ 上游中途把连接掐了（RST / 网络中断）：pipe **不会**把 proxyRes 的 error 传给 xf，
      // 于是 _flush 永不执行、我们的 SSE 永不收尾，CLI 只能干等到它自己的流空闲超时
      // （第三方 base URL 那档是 300 秒，字节级看门狗只对 api.anthropic.com 生效）。
      // 手动 end 一下 xf：走的是跟干净 EOF 完全一样的收尾路径（有正文→半截标记，
      // 零正文→error 事件），CLI 立刻拿到结果。
      const endEarly = (why) => {
        if (xf.writableEnded) return;
        console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 流被上游掐断（${why}）→ 就地收尾`);
        xf.end();
      };
      proxyRes.on('aborted', () => endEarly('aborted'));
      proxyRes.on('error', (err) => endEarly(err.code || err.message));
      proxyRes.pipe(xf).pipe(res);
      return;
    }
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    // 非流式的同一个洞：上游半路掐了，'end' 不来 —— 别让请求悬着，就地回 502（CLI 会重试）
    proxyRes.on('aborted', () => proxyRes.emit('error', Object.assign(new Error('upstream aborted'), { code: 'ECONNRESET' })));
    proxyRes.on('error', (err) => {
      if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
      const detail = err.code || err.message;
      console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 非流式响应被掐断（${detail}）`);
      onOutcome(false, `upstream stream aborted: ${detail}`);
      const errBody = JSON.stringify(toAnthropicError(502, `${wire.upstream?.label || wire.upstreamId} 的响应传到一半断了（${detail}）—— 稍后再发一次`));
      res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(errBody);
    });
    proxyRes.on('end', () => {
      let out;
      let upstreamJson;
      try { upstreamJson = JSON.parse(Buffer.concat(chunks).toString('utf8')); out = fromOpenAIChatResponse(upstreamJson); }
      catch (err) {
        const errBody = JSON.stringify(toAnthropicError(502, `ingress: upstream JSON unreadable (${err.message})`));
        res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(errBody); return;
      }
      if (!out) {   // 200 但没有 choices / 私货 finish_reason 且零可见输出：别包成成功
        const alienFinish = upstreamJson?.choices?.[0]?.finish_reason;
        const label = wire.upstream?.label || wire.upstreamId;
        const msg = upstreamJson?.error?.message
          || (alienFinish
            ? `${label}以 ${alienFinish} 结束了这次请求，没有输出任何正文 —— 上游自己的链路出错，已自动重试仍失败；稍后再发，或换个模型（upstream ended with finish_reason='${alienFinish}' and no visible output）`
            : `${label}返回了空响应，一个字都没有 —— 上游问题，已自动重试仍失败；稍后再发，或换个模型（upstream returned no choices）`);
        console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} 200-but-empty model=${wire.wireModel} ${String(msg).slice(0, 160)}`);
        onOutcome(false, String(msg).slice(0, 120));
        const errBody = JSON.stringify(toAnthropicError(502, String(msg)));
        res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(errBody); return;
      }
      onOutcome(true);
      onTruncated(truncationOfChatResponse(upstreamJson));
      if (upstreamJson.cost != null || upstreamJson.usage) onBilling({ costUsd: upstreamJson.cost ?? null, usage: upstreamJson.usage || null });
      const respBody = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(respBody)) });
      res.end(respBody);
    });
  });
  proxyReq.on('error', (err) => {
    const detail = err.code ? `${err.code}: ${err.message}` : err.message;
    console.error(`[model-ingress] forward error (${wire.upstreamId}): ${detail}`);
    onOutcome(false, `forward: ${detail}`);
    try { res.writeHead(502); res.end(`ingress forward error: ${detail}`); } catch { /* ignore */ }
  });
  proxyReq.write(outBody);
  proxyReq.end();
}

