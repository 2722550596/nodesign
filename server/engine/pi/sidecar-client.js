/**
 * server/engine/pi/sidecar-client.js — standalone MCP 子进程用的 sidecar fetch 客户端（doc §5.3）。
 *
 * standalone 的 ctx stub（emit/addToolCharge）与 tier/quota gate 都经它回主进程。
 * 失败语义（工具不能因为事件桥/计费桥挂掉而失败）：
 *   - emit / charge：失败只 stderr warn，不抛；
 *   - toolGate：网络/解析失败 fail-closed —— 返 deny（宁可拦，不放行花钱/越权的工具）。
 * 全部请求带 Authorization: Bearer <token>（lifecycle 注入的 NODESIGN_TOKEN，见 C1/C3），
 * 超时 5s（AbortSignal.timeout）。
 */

const TIMEOUT_MS = 5000;

export function createSidecarClient({ baseUrl, token, sid, pid }) {
  async function post(pathname, body) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sid, pid, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`sidecar ${pathname} → HTTP ${res.status}`);
    return res.json();
  }

  return {
    /** 工具事件 → 主进程项目 bus。失败只 warn 不抛。 */
    async emit(event) {
      try {
        await post('/emit', { event });
      } catch (err) {
        console.warn(`[sidecar-client] emit ${event?.type || '?'} 失败（忽略）: ${err?.message || err}`);
      }
    },

    /** tier/quota 权威判定。失败 fail-closed。 */
    async toolGate(capability, toolName) {
      try {
        const data = await post('/tool-gate', { capability, toolName });
        if (data && typeof data.allowed === 'boolean') return data;
        throw new Error('bad response shape');
      } catch (err) {
        console.warn(`[sidecar-client] tool-gate ${toolName} 失败（fail-closed）: ${err?.message || err}`);
        return { allowed: false, denial: `${toolName} denied: sidecar 不可用，档位校验无法完成，稍后再试。` };
      }
    },

    /** 按件计费 → 主进程本回合账。失败只 warn 不抛。 */
    async charge(name, usd) {
      try {
        await post('/charge', { name, usd });
      } catch (err) {
        console.warn(`[sidecar-client] charge ${name} 失败（忽略）: ${err?.message || err}`);
      }
    },
  };
}
