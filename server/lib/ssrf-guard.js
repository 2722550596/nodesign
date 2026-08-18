/**
 * server/lib/ssrf-guard.js — 出网地址闸（2026-08-18）
 *
 * ## 为什么要有这一层，以及为什么它必须在工具的实现体里
 *
 * agent 能自由指定 URL 的地方（截外部站、驱动浏览器）就是一台 SSRF 机器：它跑在
 * 服务端的网络命名空间里，够得到我们自己的 API、exp 实例、本机各种监听端口、
 * 云元数据地址。
 *
 * ⛔ **沙盒帮不上忙**：MCP 工具的 handler 全在 server 主进程里，而生产
 * `NODESIGN_SANDBOX` 根本没开；即便开了，bwrap 和 `permissions.deny` 管的是 SDK 的
 * Read/Write/Edit/Bash，**管不到 HTTP 路由和 MCP handler 的实现体**。所以这道闸
 * 只能长在工具自己的代码里 —— 好处是 agent 关不掉它（它连沙盒都不碰）。
 *
 * ## 三条判据（缺一条都能被绕过）
 *
 * 1. **按解析出来的 IP 判，不按主机名判。** 词法检查挡得住 `127.0.0.1` 字面量，
 *    挡不住一个 DNS 解析到 127.0.0.1 的公网域名。
 *    （`screenshot-url.js:30-49` 就是纯词法的那一档，这个模块是来替换它的。）
 * 2. **每一个请求都要过，不只是第一个。** 302 的下一跳、iframe、`<img>`、fetch/XHR
 *    的子资源各自都是请求。只查首个 URL 等于只锁前门。
 *    ⛔ **实测推翻过一个想当然的做法**：playwright 的 `context.route('**\/*')`
 *    **不拦跳转的下一跳** —— 本机 302 到 `https://example.com/`，浏览器实际到达了
 *    （`page.url()` 就是它），而 route 只被调用了一次（第一跳）。照那个做法，
 *    `https://evil/` → `http://127.0.0.1:4001/` 会直接穿过去。
 *    改用 **CDP `Fetch.requestPaused`**，实测它拦得到：导航的跳转目标、
 *    **子资源的跳转目标**（`<img>` 302 到元数据）、以及全部子资源。
 *    附带好处：响应体不绕道 node（route.fetch 那条路要代理全部流量，1 vCPU 付不起）。
 * 3. ⭐ **本机自有 IP 也要禁。** 我们的 API 监听的是 `*:4001`（绑所有网卡，`ss` 实查），
 *    所以只禁 `127.0.0.1` 挡不住"绕本机的 LAN/公网 IP 打自己"。
 *
 * ## 已知残余风险（诚实标注）
 *
 * **DNS 重绑定是缓解不是根除。** 我们在 route 层解析一次，playwright 真连的时候
 * 会再解析一次，两次之间存在 TOCTOU 窗口。第二道防线是连上之后看 CDP 报的
 * `remoteIPAddress`，但那已经是"数据可能开始返回"之后的补救。要根除得自己解析→
 * pin 住 IP→带 Host 头连，playwright 的 route 模型做不干净。
 */

import os from 'node:os';
import dns from 'node:dns/promises';

/** IPv4 段（CIDR），含各类保留段 —— 不只私网，元数据和 CGNAT 也在里面 */
const V4_BLOCKS = [
  ['0.0.0.0', 8],          // 本网络
  ['10.0.0.0', 8],         // RFC1918
  ['100.64.0.0', 10],      // CGNAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local，含 GCP/AWS 元数据 169.254.169.254
  ['172.16.0.0', 12],      // RFC1918
  ['192.0.0.0', 24],       // IETF 协议分配
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay（已弃用）
  ['192.168.0.0', 16],     // RFC1918
  ['198.18.0.0', 15],      // 基准测试
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // 组播
  ['240.0.0.0', 4],        // 保留（含 255.255.255.255）
];

/** IPv6 前缀（小写、去零压缩前的字面前缀匹配即可覆盖） */
const V6_PREFIXES = ['::1', '::', 'fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', 'ff'];

const v4ToInt = (ip) => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + (Number(o) & 255), 0) >>> 0;

function v4Blocked(ip) {
  const n = v4ToInt(ip);
  for (const [base, bits] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    if ((n & mask) === (v4ToInt(base) & mask)) return true;
  }
  return false;
}

/** IPv4-mapped / NAT64 要**拆开按 v4 判**，否则 `::ffff:127.0.0.1` 直接绕过 */
function unwrapV6(ip) {
  const m = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) return m[1];
  // ::ffff:7f00:1 这种十六进制写法
  const h = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (h) {
    const a = parseInt(h[1], 16), b = parseInt(h[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/**
 * 本机的地址集合。
 *
 * ⛔ **只枚举网卡是不够的**（2026-08-18 审查攻出来的）：云上是 1:1 NAT，
 * 实例的**公网 IP 根本不在任何网卡上**。实测这台机器网卡只有
 * `127.0.0.1 / ::1 / 10.128.0.12 / fe80::…`，而它的公网 IP 是 35.209.189.19 ——
 * `blockReason` 对它返回 null（放行），发夹 `curl https://<公网IP>:8443/` 真的 200。
 * 也就是说「本机自有 IP 也要禁」那条判据在原来的实现下**形同没有**，
 * 而给它写的那条单元测试是同义反复（枚举 ownAddresses 再断言它们被禁，
 * 结构上不可能失败）。
 *
 * 所以三个来源并起来：
 *   ① 网卡（拿到 loopback 和内网地址）
 *   ② 云元数据里的外部 IP（**我们自己进程去读**，不是让浏览器去读 —— 那个地址
 *      对浏览器是禁的）。取不到就算了，别的环境没这个端点。
 *   ③ `ND_PUBLIC_IP` 环境变量兜底（自建机器、多 IP、或者元数据端点关掉的情况）
 *
 * ⚠️ ② 是**异步**的，所以 `primeOwnAddresses()` 要在启动时调一次；没调也不会崩，
 * 只是少了那一条（同步路径永远拿得到 ① 和 ③）。
 */
let ownCache = null;
function baseOwn() {
  const set = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) set.add(String(a.address).toLowerCase().replace(/%.*$/, ''));
  }
  for (const extra of String(process.env.ND_PUBLIC_IP || '').split(',')) {
    const v = extra.trim().toLowerCase();
    if (v) set.add(v);
  }
  return set;
}
export function ownAddresses() {
  if (!ownCache) ownCache = baseOwn();
  return ownCache;
}

/**
 * 把云元数据里的外部 IP 也加进来。启动时调一次（失败静默 —— 不是所有环境都有）。
 * @returns {Promise<string|null>} 加进来的那个 IP
 */
export async function primeOwnAddresses({ timeoutMs = 1500 } = {}) {
  const set = ownAddresses();
  const url = 'http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip';
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const ip = (await res.text()).trim().toLowerCase();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      set.add(ip);
      console.log(`[ssrf-guard] 本机公网 IP ${ip} 已加入禁止集（云 NAT 下它不在任何网卡上）`);
      return ip;
    }
  } catch { /* 没这个端点 / 超时：正常 */ }
  return null;
}

/**
 * 这个 IP 该不该禁。
 * @returns {string|null} 禁的理由；null = 放行
 */
export function blockReason(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return 'empty address';
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');

  if (ownAddresses().has(ip)) {
    return `${ip} is this machine's own address (our API listens on *:PORT — reaching it via any local NIC is the same as reaching localhost)`;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return v4Blocked(ip) ? `${ip} is a private/reserved IPv4 address` : null;
  }
  if (ip.includes(':')) {
    const v4 = unwrapV6(ip);
    if (v4) {
      if (ownAddresses().has(v4)) return `${ip} maps to this machine's own address`;
      return v4Blocked(v4) ? `${ip} maps to private IPv4 ${v4}` : null;
    }
    const bare = ip.replace(/:/g, '') === '' ? '::' : ip;
    for (const pre of V6_PREFIXES) {
      if (pre === '::' ? bare === '::' : bare.startsWith(pre)) {
        return `${ip} is a private/reserved IPv6 address`;
      }
    }
    return null;
  }
  return `${rawIp} is not an IP address`;   // 调用方该先解析
}

/** 只允许这两个 scheme 发起网络请求；data:/blob: 不出网所以另算 */
const NET_SCHEMES = new Set(['http:', 'https:']);
const OFFLINE_SCHEMES = new Set(['data:', 'blob:', 'about:']);

/**
 * 一个 URL 能不能让浏览器去。**解析 DNS 后逐个 IP 判**。
 * @returns {Promise<{ok: true, ips: string[]} | {ok: false, reason: string}>}
 */
/**
 * 主机名 → 判定结果的短期缓存。
 *
 * 一个页面几十个子资源，每个都查一次 DNS 在 1 vCPU 上不划算。
 * ⚠️ 缓存跟 DNS 重绑定的关系要说清：TTL 内我们**认一次结果**，这**缩小**了
 * "两次解析之间答案变了"的窗口，但也意味着 TTL 内的变化我们看不见 ——
 * 兜底仍然是第二道（连上后看 remoteIPAddress）。TTL 故意短。
 */
const HOST_TTL_MS = 30_000;
const hostCache = new Map();   // host → { at, verdict }

export async function checkUrl(raw, { timeoutMs = 4000 } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: `not a valid URL: ${raw}` }; }

  if (OFFLINE_SCHEMES.has(u.protocol)) return { ok: true, ips: [] };   // 不出网
  if (!NET_SCHEMES.has(u.protocol)) {
    return { ok: false, reason: `scheme ${u.protocol} is not allowed (only http/https; file:// would read local files)` };
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // 字面量 IP 不用解析（也别交给 DNS —— 有些解析器会对畸形量做意外的事）
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    const why = blockReason(host);
    return why ? { ok: false, reason: why } : { ok: true, ips: [host] };
  }
  // `.local` 是 mDNS，只可能指向局域网
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return { ok: false, reason: `${host} resolves inside the local network` };
  }

  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.at < HOST_TTL_MS) return cached.verdict;

  let addrs;
  try {
    addrs = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), timeoutMs)),
    ]);
  } catch (err) {
    return { ok: false, reason: `cannot resolve ${host}: ${err.message}` };
  }
  if (!addrs.length) return { ok: false, reason: `${host} resolved to nothing` };

  // ⭐ **任一**地址落在禁止段就整个拒。多 A 记录里混一条 127.0.0.1 是标准的
  // DNS-rebinding 起手式，"挑一个能用的"等于自己把门打开。
  let verdict = { ok: true, ips: addrs.map(a => a.address) };
  for (const a of addrs) {
    const why = blockReason(a.address);
    if (why) { verdict = { ok: false, reason: `${host} → ${why}` }; break; }
  }
  hostCache.set(host, { at: Date.now(), verdict });
  if (hostCache.size > 500) hostCache.delete(hostCache.keys().next().value);
  return verdict;
}

/**
 * 把闸装到一个 playwright BrowserContext 上。两道防线：
 *
 * ① **CDP `Fetch.requestPaused`** —— 每个请求（含每个跳转下一跳、iframe、子资源）
 *    在**发出之前**被暂停，按解析出的 IP 判，不过就 `Fetch.failRequest`。
 *    为什么不是 playwright 的 `context.route`：实测它看不到跳转的下一跳（见文件头）。
 * ② CDP `Network.responseReceived` 的 `remoteIPAddress` —— 真连上之后再看一眼对端，
 *    挡第一道之后被重绑定掉的那种。**这是补救不是预防**：走到这里数据可能已经在返回。
 *
 * ⚠️⚠️ **`armPage` 必须 await 完才能让那个页面导航。**
 * 第一版把装闸挂在 `context.on('page')` 里 fire-and-forget，结果**攻出一个初始化
 * 竞态**：`newPage()` 之后立刻 goto，`Fetch.enable` 还没握手完，第一次导航整个
 * 穿过第一道闸 —— 实测直接到达了 `169.254.169.254`，闸零记账（救回来的是第二道，
 * 而那时数据已经在返回了）。所以现在装闸是**调用方必须显式 await 的动作**。
 * 我们自己造页面，所以这条能保证；**没经过 armPage 的页面（比如 target=_blank
 * 弹窗）一律立刻关掉** —— 一个没装闸的页面就是一个洞，宁可功能少一点。
 *
 * @param {import('playwright').BrowserContext} context
 * @param {(ev: {url: string, reason: string, stage: string}) => void} [onBlocked]
 * @returns {Promise<{ blocked: Array, armPage: (page) => Promise<void> }>}
 */
export async function attachSsrfGuard(context, onBlocked, { proxied = false } = {}) {
  const blocked = [];
  const armed = new WeakSet();
  const note = (url, reason, stage) => {
    const rec = { url: String(url).slice(0, 300), reason, stage };
    blocked.push(rec);
    if (blocked.length > 200) blocked.shift();
    try { onBlocked?.(rec); } catch { /* 记账不能变成新故障源 */ }
  };

  async function armPage(page) {
    if (armed.has(page)) return;
    const cdp = await context.newCDPSession(page);   // 抛错就让调用方知道（别静默假装装上了）

    cdp.on('Fetch.requestPaused', async (ev) => {
      // ⚠️ **每条路径都必须落到 continueRequest 或 failRequest 上**。handler 里抛错
      // 会让这个请求**永远暂停**，浏览器一直等 —— 症状跟"网站很慢"一模一样，
      // 真跑时撞过一次 30 秒超时。
      const id = ev.requestId;
      const url = ev.request?.url || '(unknown)';
      try {
        const verdict = await checkUrl(url);
        if (verdict.ok) return await cdp.send('Fetch.continueRequest', { requestId: id });
        note(url, verdict.reason, 'request');
        return await cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'AccessDenied' });
      } catch (err) {
        if (/closed|Target|detached|Session/i.test(err?.message || '')) return;   // 正常竞态
        // 判不出来就**拒**（fail-closed）：安全闸不能因为自己出错而放行
        note(url, `guard error, denied by default: ${err?.message || err}`, 'request');
        try { await cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'Failed' }); } catch { /* */ }
      }
    });

    // 第二道只在**没有代理**的通道上有意义。
    // ⚠️ 真跑抓到的：挂了 browse-proxy 之后每个响应的 `remoteIPAddress` 都是代理
    // 自己（127.0.0.1），于是这道兜底把**每个页面**都掐掉了。而它本来防的是
    // 「请求阶段判过之后 DNS 被翻掉」—— 代理会自己解析并**连那个验过的 IP**（pin），
    // 重绑定在那条路上结构性不可能，所以这道检查在代理下是纯冗余。
    if (!proxied) {
      cdp.on('Network.responseReceived', (ev) => {
        const ip = ev?.response?.remoteIPAddress;
        if (!ip) return;
        const why = blockReason(ip);
        if (!why) return;
        note(ev.response.url, `connected to ${why}`, 'connected');
        page.close().catch(() => {});   // 已经连上了，能做的只有立刻掐掉
      });
    }

    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    armed.add(page);
  }

  // 没经过 armPage 的页面（弹窗）立刻关掉。给 armPage 一个微任务的机会先登记，
  // 免得把我们自己刚造的页面误杀。
  context.on('page', (p) => {
    setTimeout(() => {
      if (armed.has(p) || p.isClosed()) return;
      note(p.url() || '(popup)', 'popup was not armed with the network guard — closed', 'popup');
      p.close().catch(() => {});
    }, 250);
  });

  for (const p of context.pages()) await armPage(p);
  return { blocked, armPage };
}
