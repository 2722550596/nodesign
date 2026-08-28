/**
 * server/runtime/local-env.js — 本地分发版的钥匙与开关（<dataRoot>/.env）读写，白名单制。
 *
 * 配置页「钥匙」那一栏的后端：只暴露 ENV_KEYS 里列的键（搜索 / 生图 / 发布 / 引擎），
 * 值在 GET 时打码（只报配没配 + 末四位），PUT 时改文件并同步进 process.env（web_search 这类调用时读 env 的
 * 工具立刻生效；能力表由调用方 probeCapabilities({force:true}) 重探）。.env 里不在白名单的行原样保留。
 */

import fs from 'node:fs';
import path from 'node:path';
import { profile } from './profile.js';

export const ENV_KEYS = Object.freeze([
  { key: 'NODESIGN_TAVILY_KEY', group: '联网搜索', label: 'Tavily', secret: true, hint: 'web_search 四家任一即可；英文检索优先用它' },
  { key: 'NODESIGN_EXA_KEY', group: '联网搜索', label: 'Exa', secret: true },
  { key: 'NODESIGN_BAIDU_QIANFAN_KEY', group: '联网搜索', label: '百度千帆', secret: true, hint: '中文检索自动路由到它' },
  { key: 'NODESIGN_ZHIPU_KEY', group: '联网搜索', label: '智谱', secret: true },
  // 生图通道：选哪个就只露哪个的配置项（showIf 表驱动，前端按它显隐；optionHints 是选中该项时的说明）
  { key: 'NODESIGN_IMAGE_PROVIDER', group: '生图', label: '生图通道', secret: false, options: ['codex', 'gateway'], default: 'codex',
    optionHints: { codex: '走本机的 OpenAI codex CLI（用你的 ChatGPT 账号）。装法：npm i -g @openai/codex，然后终端里 codex login 一次。装好后点右上角「重启」重探', gateway: '走一个兼容 OpenAI Images 接口的网关（中转站）：填它给的钥匙和地址' } },
  { key: 'NODESIGN_GATEWAY_KEY', group: '生图', label: '网关 Key', secret: true, showIf: { NODESIGN_IMAGE_PROVIDER: 'gateway' } },
  { key: 'NODESIGN_GATEWAY_URL', group: '生图', label: '网关 URL', secret: false, showIf: { NODESIGN_IMAGE_PROVIDER: 'gateway' }, hint: '如 https://api.example.com/v1' },
  { key: 'NODESIGN_CODEX_BIN', group: '生图', label: 'codex 可执行路径（可选）', secret: false, showIf: { NODESIGN_IMAGE_PROVIDER: 'codex' }, hint: '装了但不在 PATH 时填绝对路径；在 PATH 里就留空' },
  { key: 'CLOUDFLARE_API_TOKEN', group: '发布', label: 'Cloudflare API Token', secret: true, hint: 'publish_site 一键上线；还要装 wrangler' },
  { key: 'NODESIGN_PUBLISH_DOMAIN', group: '发布', label: '发布域名后缀', secret: false, hint: '如 share.example.com；站点发到 <slug>.<这个>' },
  { key: 'NODESIGN_CF_ACCOUNT_ID', group: '发布', label: 'Cloudflare Account ID', secret: false },
  { key: 'NODESIGN_MCP_SERVERS', group: '引擎', label: '外部 MCP 服务（JSON）', secret: false,
    hint: '消费第三方 MCP server：{"名字":{"type":"sse","url":"http://127.0.0.1:8233/sse"}}。模型将看到 mcp__<名字>__* 工具（名字只允许字母数字 _-）。改完重启生效' },
]);
const ALLOWED = new Set(ENV_KEYS.map((k) => k.key));

export const envPath = profile.isLocal ? path.join(profile.dataRoot, '.env') : null;

function mask(v) {
  if (!v) return '';
  return v.length <= 8 ? '••••' : `••••${v.slice(-4)}`;
}

/** 配置页视图：每个白名单键配没配 + 打码预览（真值不出门） */
export function envView() {
  return ENV_KEYS.map((k) => {
    const v = process.env[k.key] || '';
    return { ...k, set: !!v, preview: k.secret ? mask(v) : v };
  });
}

function parseLine(line) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m ? m[1] : null;
}

/**
 * 写 .env：只动白名单键；null/'' = 删行；其它行（注释、别的键）原样。同步 process.env。
 * @param {Record<string, string|null>} values
 * @returns {{ changed: string[] }}
 */
export function setEnvValues(values) {
  if (!envPath) throw new Error('hosted profile 不在这里改 .env');
  const changed = [];
  for (const [k, v] of Object.entries(values || {})) {
    if (!ALLOWED.has(k)) throw new Error(`不允许改 ${k}（不在白名单）`);
    if (v != null && typeof v !== 'string') throw new Error(`${k} 的值必须是字符串`);
    if (v && /[\r\n]/.test(v)) throw new Error(`${k} 的值不能含换行`);
    const def = ENV_KEYS.find((d) => d.key === k);
    if (def.options && v && !def.options.includes(v)) throw new Error(`${k} 只能是 ${def.options.filter(Boolean).join(' | ')} 或留空`);
    if (def.validate) {
      const why = def.validate(v);
      if (why) throw new Error(`${k}：${why}`);
    }
  }
  let lines = [];
  try { lines = fs.readFileSync(envPath, 'utf8').split('\n'); if (lines.at(-1) === '') lines.pop(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (const [k, vRaw] of Object.entries(values || {})) {
    const v = vRaw ? vRaw.trim() : '';
    const idx = lines.findIndex((l) => parseLine(l) === k);
    const rendered = `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`;
    if (!v) {
      if (idx !== -1) { lines.splice(idx, 1); changed.push(k); }
      delete process.env[k];
    } else {
      if (idx !== -1) { if (lines[idx] !== rendered) { lines[idx] = rendered; changed.push(k); } } else { lines.push(rendered); changed.push(k); }
      process.env[k] = v;
    }
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const tmp = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, envPath);
  return { changed };
}
