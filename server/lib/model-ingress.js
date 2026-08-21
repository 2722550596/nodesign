/**
 * server/lib/model-ingress.js — Anthropic 范式通用模型入口（2026-08-19，
 * 前身 binary-fixup-proxy.js）。
 *
 * ## 定位
 *
 * SDK binary 永远说 Anthropic Messages 协议；所有非订阅模型都从这里进。
 * 入口按 **请求 body.model 查表**（model-context.js 的 resolveWireModel）
 * 决定发往哪个上游、换哪把钥匙、开哪些修补 —— 无会话状态、无进程级
 * "当前模型" env（旧版的 NODESIGN_CURRENT_APP_MODEL 在多会话不同模型时
 * 会互相覆盖，已随 NoDesk 包装一起退役）。
 *
 * ## 每请求流水线
 *
 *   1. 剥 /__nd/<sessionId> 路径前缀（只用于日志归属）
 *   2. body.model 反查路由（appModel / sdkAlias / 剥[1m]的 alias 都认）；
 *      查不到 → 502 fail-loud，绝不盲转发（盲转发 = 烧错通路的钱且无人知晓）。
 *      注册过的 API 会话只认自己那行 + 自己的 fast 行，其它名字改道 fast 兜底
 *      （未知名 = SDK helper；在表里但属于别的行 = 撞名雷，见 resolveSessionWire）
 *   3. count_tokens：上游没有该端点（表里标了 / 404 实测过）→ 本地估算短路
 *   4. 修补：model 还原成上游真名 · thinking strip/enabled8k · tool_result
 *      图片提升到顶层（Kimi 与 Gemini 桥都丢 tool_result 图，08-19 探针实锤）·
 *      超长边图片下采样
 *   5. 换钥匙：上游钥匙从 env（UPSTREAMS[].keyEnv）取，按 authStyle 发；
 *      binary 带来的 ANTHROPIC_API_KEY 是占位符，一律丢弃
 *   6. 转发（SSE 直接 pipe，不解析响应流）
 *
 * ## 已知缺口（记录在案，别当没有）
 *
 * - 反重力通道流式 stop_reason 恒=end_turn 的病（tool_use 块在、收尾说错话）
 *   需要解析改写 SSE 才能修 —— 那族通道只当玩具，不为它上复杂度。
 * - prompt cache 不过桥（探针实测 cache 字段恒 0），长会话经济性靠模型价差硬扛。
 */

import http from 'node:http';
import https from 'node:https';
import sharp from 'sharp';
import { resolveWireModel, resolveModelRoute, UPSTREAMS } from '../engine/agent/model-context.js';
import { forwardOpenAIChat } from './ingress/forward-openai-chat.js';
import { failStreaks, exhaustedErrorBody } from './ingress/upstream-fail-streak.js';
import { noteUpstreamBilling } from './ingress/upstream-billing.js';

// ── 出站连接池 ──
// ⛔ 08-20 生产真踩：本地盒子（authStyle 'none' = 环回 SSH 隧道）走 Node 默认
// globalAgent，而它 **keepAlive 默认开着**。llama-server 几秒就关掉空闲连接，
// 那个 FIN 要先穿过 SSH 隧道才到 Node —— 窗口里 Node 会从池子里挑一条**其实已经
// 死了的 socket** 发请求，结果就是 `ECONNRESET: socket hang up` 刷屏（一分钟几百条），
// 而盒子那头 `ss` 看到的连接数是 0（两边对同一条连接的死活认知不一致，是识别信号）。
// 隧道内建连接本来就便宜（没有 TLS 握手），所以本地上游一律不复用连接。
// 远端上游（中转站/HTTPS）保持 keep-alive：那边握手贵，且没有隧道拖慢 FIN。
const AGENTS = new Map();
function agentFor(wire, useHttps) {
  if (wire.upstream.authStyle !== 'none') return undefined;   // 远端：用默认 globalAgent
  const key = useHttps ? 'https' : 'http';
  if (!AGENTS.has(key)) AGENTS.set(key, new (useHttps ? https : http).Agent({ keepAlive: false }));
  return AGENTS.get(key);
}

let _instance = null;

const PREFIX_RE = /^\/__nd\/([^/]+)(\/.*)$/;

// Vision 下采样阈值（长边像素）。1568 = Anthropic token 优化阈值，也是多数
// 中转网关安全线（mili-logo 2500×2500 曾触发网关 400）。
const VISION_MAX_DIM = (() => {
  const n = Number(process.env.NODESIGN_VISION_MAX_DIM);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1568;
})();

// count_tokens capability 运行时缓存：upstreamId → false（404 实测确认没有）。
// 表里 countTokens:false 的上游直接短路，true 的先转发、404 后降级并记住。
const countTokensDead = new Set();

// ── 会话级 fast 兜底路由 ──
// SDK binary 的部分内部 helper 不看 ANTHROPIC_SMALL_FAST_MODEL，直接用它
// config 目录里的默认 Claude 名发请求（_ingress-check 实测抓到 claude-sonnet-5
// 重试 8 次）。旧基建里这类请求静默打错通路烧钱；fail-loud 之后它们会 502 =
// helper 功能死。这里给注册过的会话一条兜底：未知 model 名 → 本会话的 fast
// 模型。session-loop 在 API 会话起 query 前注册、finally 注销。
//
// ⛔ 撞名雷（2026-08-19 审计标出、08-20 封死）：API 行的 sdkAlias 同时也是真实的
// Claude 名（gemini 行 = claude-sonnet-4-6[1m]，kimi 行 = claude-opus-4-7[1m]）。
// qwen 会话里的 binary 若用这类名字发一发 helper 请求（SDK 换个 config 默认名就会），
// 按全表反查会**命中别的行**、带着别家钥匙静默转发 —— 事前无警报、成功转发不留
// 日志，只有记账侧（qwen run 里冒出 gemini 行）事后才看得见。表级断言封不住它
// （SDK 内部会用哪些名字没法枚举），所以改成**会话级路由**：一个会话只认自己那行
// 和自己的 fast 行，其它一概改道 fast 兜底，绝不跨行。
const sessionRoutes = new Map();     // sessionId → { appModel, fastModel }
const fallbackLogged = new Set();     // `${sid}:${model}` 只告一次，防日志洪水

export function registerIngressSession(sessionId, appModel) {
  const route = resolveModelRoute(appModel);
  if (route.mode === 'api') sessionRoutes.set(sessionId, { appModel: route.appModel, fastModel: route.fastModel });
}

export function unregisterIngressSession(sessionId) {
  sessionRoutes.delete(sessionId);
  for (const k of fallbackLogged) {
    if (k.startsWith(sessionId + ':')) fallbackLogged.delete(k);
  }
}

/**
 * 会话级路由决策（纯函数，有单测）。
 *
 * - 没注册的会话 / 无会话前缀（探针、体检）：全表反查，查不到就是 null（502）。
 * - 注册过的 API 会话：只认**自己那行**和**自己的 fast 行**。其它名字一律改道
 *   fast 兜底 —— 不在表里的是 SDK helper 默认名（'fallback'），在表里但属于别的行
 *   的就是撞名雷（'collision'），后者尤其不能放过去（那是别家的钥匙、真钱）。
 *
 * @param {string|undefined} bodyModel
 * @param {string|null} sessionTag
 * @returns {{ wire: ReturnType<typeof resolveWireModel>, reason: 'table'|'fallback'|'collision'|'none',
 *             fastModel?: string, sessionModel?: string, collidesWith?: string }}
 */
export function resolveSessionWire(bodyModel, sessionTag) {
  const direct = resolveWireModel(bodyModel);
  const sess = sessionTag ? sessionRoutes.get(sessionTag) : null;
  if (!sess) return { wire: direct, reason: direct ? 'table' : 'none', role: 'main' };
  // role：'main' = 会话主行的请求（主 agent 一轮）；'helper' = fast 行 / 兜底 / 撞名改道
  // （标题、auto 分类器、摘要等一句话的活）。openai-chat 行按 role 选 reasoning_effort
  if (direct && direct.appModel === sess.appModel) return { wire: direct, reason: 'table', role: 'main' };
  if (direct && direct.appModel === sess.fastModel) return { wire: direct, reason: 'table', role: 'helper' };
  const wire = resolveWireModel(sess.fastModel);
  return {
    wire,
    role: 'helper',
    reason: direct ? 'collision' : 'fallback',
    fastModel: sess.fastModel,
    sessionModel: sess.appModel,
    ...(direct ? { collidesWith: direct.appModel } : {}),
  };
}

/**
 * 启动入口（幂等单例；路由是 per-request 的，单例不再锁死目标）。
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export async function getOrStartIngress() {
  if (_instance) return _instance;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        await handleRequest(req, res, Buffer.concat(chunks));
      } catch (err) {
        console.error(`[model-ingress] handler error: ${err?.stack || err?.message || err}`);
        try { res.writeHead(502); res.end(`ingress handler error: ${err?.message || 'unknown'}`); } catch { /* ignore */ }
      }
    });
    req.on('error', (err) => {
      console.error(`[model-ingress] request error: ${err.message}`);
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

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`[model-ingress] listening on ${baseUrl} (upstreams: ${Object.keys(UPSTREAMS).join(', ')})`);
  _instance = { baseUrl, close: () => new Promise((r) => server.close(() => r())), server };
  return _instance;
}

export async function stopIngress() {
  if (!_instance) return;
  await _instance.close();
  _instance = null;
}

async function handleRequest(req, res, bodyBuf) {
  // 剥 /__nd/<sessionId> 前缀（日志归属用）
  let sessionTag = null;
  let origPath = req.url;
  const m = PREFIX_RE.exec(req.url);
  if (m) { sessionTag = decodeURIComponent(m[1]); origPath = m[2]; }
  const sidShort = sessionTag ? sessionTag.slice(0, 8) : '-';

  if (!(req.method === 'POST' && /^\/v1\/messages\b/.test(origPath))) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`model-ingress: unsupported ${req.method} ${origPath}`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    // 没有 model 就没法路由 —— fail-loud 而不是盲转发
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('model-ingress: body is not JSON, cannot route');
    return;
  }

  const routed = resolveSessionWire(parsed?.model, sessionTag);
  const wire = routed.wire;
  if (wire && routed.reason !== 'table') {
    const logKey = `${sessionTag}:${parsed?.model}`;
    if (!fallbackLogged.has(logKey)) {
      fallbackLogged.add(logKey);
      if (routed.reason === 'collision') {
        console.warn(`[model-ingress] sid=${sidShort} ⛔ 撞名：model '${parsed?.model}' 属于别的行（${routed.collidesWith}），本会话是 ${routed.sessionModel} —— 不跨行转发，改道会话 fast（${routed.fastModel}）`);
      } else {
        console.warn(`[model-ingress] sid=${sidShort} 未知 model '${parsed?.model}' → 会话 fast 兜底（${routed.fastModel}）`);
      }
    }
  }
  if (!wire) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`model-ingress: no route for model '${parsed?.model}' — 该名字不在 model-context.js 的 API 表里`);
    console.warn(`[model-ingress] sid=${sidShort} 未知 model '${parsed?.model}'，已拒绝（fail-loud）`);
    return;
  }

  // authStyle 'none' = 无鉴权上游（本地 llama-server 走环回隧道），不需要钥匙
  const needKey = wire.upstream.authStyle !== 'none';
  const key = needKey ? process.env[wire.upstream.keyEnv] : null;
  if (needKey && !key) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`model-ingress: 上游钥匙未配置（env ${wire.upstream.keyEnv} 为空）`);
    return;
  }

  const isCountTokens = /^\/v1\/messages\/count_tokens\b/.test(origPath);

  // 会话连续失败上限（upstream-fail-streak.js，僵尸 run 案）：上游持续死时 CLI 对 5xx 无上限退避重试，
  // 一个回合能挂一小时。到上限就回 400（CLI 不重试、回合以 is_error 收场、文案到用户、会话不死），
  // 计数归零让用户下次再发有新机会。count_tokens 不参与（它不是循环的燃料）。
  // 计数按 sid+角色分桶：helper（标题/分类器）一次成功不能把主行攒的计数清零（08-21 评审抓的洞）
  const streakKey = sessionTag ? `${sessionTag}:${routed.role || 'main'}` : null;
  if (!isCountTokens && failStreaks.exhausted(streakKey)) {
    const { n, reason } = failStreaks.consume(streakKey);
    const body = JSON.stringify(exhaustedErrorBody({ label: wire.upstream?.label || wire.upstreamId, n, reason }));
    console.warn(`[model-ingress] sid=${sidShort} role=${routed.role} upstream=${wire.upstreamId} 连续失败 ${n} 次（${reason}）→ 400 止损，计数归零`);
    res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
    res.end(body);
    return;
  }
  const noteOutcome = (ok, reason) => { if (!isCountTokens) failStreaks.note(streakKey, ok, reason); };

  // count_tokens：上游没有该端点 → 本地估算短路（SDK 内部窗口计数要有数，
  // 否则 ContextUsageBar 永远"等待"、80% 预警从不触发 —— DMXAPI 时代真踩过）
  const upstreamHasCount = wire.upstream.countTokens !== false && !countTokensDead.has(wire.upstreamId);
  if (isCountTokens && !upstreamHasCount) {
    const respBody = JSON.stringify({ input_tokens: estimateInputTokens(parsed) });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(respBody)) });
    res.end(respBody);
    return;
  }

  // 修补流水线（count_tokens 也要 model 还原，其余修补无害）
  await transformForUpstream(parsed, wire);

  // 协议分岔：上游说 OpenAI chat（Zen 等）→ 转换层；其余透传 Anthropic
  if (wire.protocol === 'openai-chat') {
    const target = new URL(wire.upstream.baseUrl);
    // helper 请求降档：主行想多少归主行，helper 一句话的活用 helperReasoningEffort（默认 low）
    const wireFwd = routed.role === 'helper' && wire.helperReasoningEffort ? { ...wire, reasoningEffort: wire.helperReasoningEffort } : wire;
    forwardOpenAIChat({ parsed, wire: wireFwd, key, res, sidShort, target, path: joinPath(target.pathname, '/chat/completions'), agent: agentFor(wire, target.protocol === 'https:'), onOutcome: noteOutcome,
      // 上游自报费用按会话 × appModel 累加（helper 请求记到 helper 行头上），session-loop 结账时取走
      onBilling: (info) => noteUpstreamBilling(sessionTag, wireFwd.appModel, info) });
    return;
  }
  const outBody = Buffer.from(JSON.stringify(parsed), 'utf8');

  // 换钥匙 + 头处理
  const target = new URL(wire.upstream.baseUrl);
  const useHttps = target.protocol === 'https:';
  const headers = { ...req.headers, host: target.hostname };
  delete headers['x-api-key'];
  delete headers['authorization'];
  if (wire.upstream.authStyle === 'bearer') headers['authorization'] = `Bearer ${key}`;
  else if (needKey) headers['x-api-key'] = key;
  headers['content-length'] = String(outBody.length);

  const proxyReq = (useHttps ? https : http).request({
    hostname: target.hostname,
    port: target.port || (useHttps ? 443 : 80),
    path: joinPath(target.pathname, origPath),
    method: 'POST',
    headers,
    agent: agentFor(wire, useHttps),
  }, (proxyRes) => {
    // count_tokens 404 → 降级本地估算并记住这个上游没有该端点
    if (isCountTokens && (proxyRes.statusCode === 404 || proxyRes.statusCode === 405)) {
      countTokensDead.add(wire.upstreamId);
      proxyRes.resume();   // 丢弃上游响应体
      const respBody = JSON.stringify({ input_tokens: estimateInputTokens(parsed) });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(respBody)) });
      res.end(respBody);
      console.warn(`[model-ingress] ${wire.upstreamId} 没有 count_tokens（404），已降级本地估算并缓存`);
      return;
    }
    // 上游 4xx/5xx：console.warn 一行 status + model + body 前 200 字，PM2 日志直接看到根因
    if (proxyRes.statusCode >= 400) {
      const respChunks = [];
      proxyRes.on('data', (c) => respChunks.push(c));
      proxyRes.on('end', () => {
        const preview = Buffer.concat(respChunks).slice(0, 200).toString('utf8').replace(/\s+/g, ' ');
        console.warn(`[model-ingress] sid=${sidShort} upstream=${wire.upstreamId} ${proxyRes.statusCode} model=${wire.wireModel} body=${preview}`);
      });
      // 透传路：5xx 记一次失败（4xx 是请求本身的问题，CLI 不重试，不记）；2xx 算成功
      if (proxyRes.statusCode >= 500) noteOutcome(false, `HTTP ${proxyRes.statusCode}`);
    } else {
      noteOutcome(true);
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    const detail = err.code ? `${err.code}: ${err.message}` : err.message;
    console.error(`[model-ingress] forward error (${wire.upstreamId}): ${detail}`);
    noteOutcome(false, `forward: ${detail}`);
    try { res.writeHead(502); res.end(`ingress forward error: ${detail}`); } catch { /* ignore */ }
  });

  proxyReq.write(outBody);
  proxyReq.end();
}

/**
 * 按路由行修补请求 body（原地改）。导出供单测直接喂假 body 验证。
 *
 * @param {object} parsed  Anthropic Messages body
 * @param {object} wire    resolveWireModel 的返回
 * @returns {Promise<boolean>} 是否有改动
 */
export async function transformForUpstream(parsed, wire) {
  let mutated = false;

  // model 还原成上游真名（SDK 发的是 spoof alias 或 appModel）
  if (parsed.model !== wire.wireModel) {
    parsed.model = wire.wireModel;
    mutated = true;
  }

  // thinking：'strip' = 删字段让上游自决（Gemini thinking 关不掉、参数过桥行为
  // 未知）；'enabled8k' = adaptive 改写成 enabled+budget（Kimi 实测 adaptive =
  // 0 thinking blocks）
  if (wire.thinking === 'strip') {
    if ('thinking' in parsed) { delete parsed.thinking; mutated = true; }
  } else if (wire.thinking === 'enabled8k') {
    if (parsed.thinking?.type === 'adaptive') {
      parsed.thinking = { type: 'enabled', budget_tokens: 8192 };
      mutated = true;
    }
  }

  // tool_result 里的图提升到 user message 顶层（丢图桥的必修 shim）
  if (wire.liftImages && Array.isArray(parsed.messages)) {
    if (liftImagesFromToolResult(parsed.messages)) mutated = true;
  }

  // 图片归一：长边超限下采样（所有上游统一做，安全无害）+ 把上游解不开的格式
  // 转码过去（只有声明了 imageFormats 的上游才做，见 model-context 那张表）
  if (Array.isArray(parsed.messages)) {
    const allowed = wire.upstream?.imageFormats || null;
    if (await normalizeImages(parsed.messages, VISION_MAX_DIM, allowed)) mutated = true;
  }

  return mutated;
}

/**
 * 把 tool_result.content 里的 image block 提到外层 user message content 顶层；
 * 原位置替换为占位文本。Kimi S8 时代写的，08-19 探针证明 Gemini 桥同样需要。
 */
export function liftImagesFromToolResult(messages) {
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
            text: '[image lifted to end of this message for upstream vision compat — see image block below]',
          };
        }
        return inner;
      });
    }
    if (liftedImages.length > 0) msg.content.push(...liftedImages);
  }
  return mutated;
}

/**
 * 图片归一：扫所有 image block（user msg 顶层 + tool_result 内嵌），按需下采样
 * 和/或转码。两件事共用一次遍历也共用一条 sharp 管线 —— 拆成两个函数就是把这段
 * 嵌套遍历抄第二份，而它已经是"顶层 + tool_result 内嵌"两层的形状了。
 *
 * fail-soft：单张图 sharp 抛错 → warn 后保留原图透传，不阻断整 turn。
 *
 * @param {number} maxDim 长边上限，超了才 resize
 * @param {string[]|null} allowed 上游解得开的 media_type 白名单；null = 不限
 */
async function normalizeImages(messages, maxDim, allowed) {
  let mutated = false;
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (block?.type === 'image') {
        const replaced = await maybeNormalizeImageBlock(block, maxDim, allowed);
        if (replaced) { msg.content[i] = replaced; mutated = true; }
      }
      if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          const inner = block.content[j];
          if (inner?.type === 'image') {
            const replaced = await maybeNormalizeImageBlock(inner, maxDim, allowed);
            if (replaced) { block.content[j] = replaced; mutated = true; }
          }
        }
      }
    }
  }
  return mutated;
}

const IMAGE_WRITERS = {
  'image/png': (p) => p.png({ compressionLevel: 9 }),
  'image/jpeg': (p) => p.jpeg({ quality: 90, mozjpeg: true }),
  'image/webp': (p) => p.webp({ quality: 85 }),
};

/**
 * 单图归一。两个触发条件，满足任一才动（都不满足返 null 原样透传）：
 *   - 长边超过 maxDim  → 下采样
 *   - media_type 不在上游的 imageFormats 里 → 转码
 *
 * 转码目标按有没有 alpha 分：有 alpha 走 png（保住透明），没有走 jpeg（照片和
 * 渲染图转 png 会胖好几倍，本地盒子这条链路还要过 SSH 隧道）。**只在 allowed
 * 里挑**，上游声明什么就往什么转。
 *
 * gif 不在 IMAGE_WRITERS 的键里，所以动图永远不进这条路（重 encode 会丢帧）——
 * 代价是 gif 遇到解不开它的上游仍旧失败，那个另说，别在这儿悄悄压成一张静图。
 */
async function maybeNormalizeImageBlock(block, maxDim, allowed) {
  const src = block?.source;
  if (!src || src.type !== 'base64' || !src.data) return null;
  if (!IMAGE_WRITERS[src.media_type]) return null;

  const needsTranscode = Array.isArray(allowed) && !allowed.includes(src.media_type);

  try {
    const inputBuf = Buffer.from(src.data, 'base64');
    const meta = await sharp(inputBuf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const needsResize = Math.max(w, h) > maxDim;
    if (!needsResize && !needsTranscode) return null;

    // 转码时目标格式从 allowed 里挑；不转码就还用原格式
    let outType = src.media_type;
    if (needsTranscode) {
      const prefer = meta.hasAlpha ? ['image/png', 'image/jpeg'] : ['image/jpeg', 'image/png'];
      outType = prefer.find((t) => allowed.includes(t) && IMAGE_WRITERS[t])
        || allowed.find((t) => IMAGE_WRITERS[t]);
      if (!outType) {
        console.warn(`[model-ingress] 上游 imageFormats 里没有能写的格式，原样透传 ${src.media_type}`);
        return null;
      }
    }

    let pipeline = sharp(inputBuf);
    if (needsResize) {
      pipeline = pipeline.resize({
        width: w >= h ? maxDim : null,
        height: h > w ? maxDim : null,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    // 两种情况去 alpha：① 落到 jpeg（它没有 alpha 通道，不 flatten 出来是黑底）；
    // ② 走了 resize —— 这条是原有行为，理由是"部分 vision 网关对 RGBA 不友好"，
    // 别因为加转码顺手把它改掉（中转站那两个上游一直吃的是 flatten 过的图）。
    if (meta.hasAlpha && (needsResize || outType === 'image/jpeg')) {
      pipeline = pipeline.flatten({ background: '#ffffff' });
    }
    const outBuf = await IMAGE_WRITERS[outType](pipeline).toBuffer();
    return {
      ...block,
      source: { type: 'base64', media_type: outType, data: outBuf.toString('base64') },
    };
  } catch (err) {
    console.warn(`[model-ingress] image normalize failed (passthrough): ${err?.message || err}`);
    return null;
  }
}

/**
 * CJK 字符范围（token 估算分流）：平/片假名 + CJK 基础汉字 + 韩文音节。
 * 系数：CJK 1 字 ≈ 1.3 token，英文 BPE ~4 char/token。
 */
const CJK_REGEX = /[぀-鿿가-힯]/g;

function estimateText(s) {
  if (typeof s !== 'string') return 0;
  const cjk = s.match(CJK_REGEX)?.length || 0;
  return cjk * 1.3 + (s.length - cjk) / 4;
}

/**
 * 粗估 messages body 的 input token 数（count_tokens 本地降级用）。
 * 实测误差：纯英文 ±10%，纯中文 ±15%，混合 ±20% —— 够 UI 进度条与预警分档。
 */
export function estimateInputTokens(parsed) {
  try {
    let total = 0;
    const addText = (s) => { total += estimateText(s); };
    const addBlock = (b) => {
      if (!b) return;
      if (b.type === 'text' && b.text) addText(b.text);
      else if (b.type === 'image' && b.source?.data) total += b.source.data.length / 4;
      else if (b.type === 'tool_use') { addText(b.name || ''); addText(JSON.stringify(b.input || {})); }
      else if (b.type === 'tool_result') {
        if (typeof b.content === 'string') addText(b.content);
        else if (Array.isArray(b.content)) b.content.forEach(addBlock);
      } else if (b.type === 'thinking' && b.thinking) addText(b.thinking);
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
    return 50000;   // 保守值 ≈ 1/5 上下文，误触 80% 警告概率低
  }
}

/** URL path 拼接（避免重复 / 或丢段）。moonshot base 自带 /anthropic 段靠它保住 */
function joinPath(base, reqPath) {
  const cleanBase = (base || '').replace(/\/$/, '');
  return cleanBase + (reqPath.startsWith('/') ? reqPath : '/' + reqPath);
}
