/**
 * server/lib/site-publish.js — 站点发布核心（2026-08-02）
 *
 * HTTP 路由（api/publish.js）和 agent 的 MCP 工具（publish_site）共用这一套：
 * 闸门（试用号 403 / 每人 2 个）、staging、wrangler deploy、custom domain、记账。
 * agent 走的是**项目 owner** 的额度与权限 —— 谁的项目算谁的，不看是谁触发。
 *
 * # custom domain（<slug>.share.xiaobuyu.trade 这一层）
 * 配置驱动，两个 env 都在才启用，缺一个就退回 <cf_project>.pages.dev：
 *   NODESIGN_PUBLISH_DOMAIN   如 share.xiaobuyu.trade（发布域后缀）
 *   CLOUDFLARE_API_TOKEN      scope：Account.Pages:Edit + Zone.DNS:Edit + Zone:Read
 * 探针实测（2026-08-02）：Pages 给四级域名单独排证书（certificate_authority:
 * google），Universal SSL 只盖一级泛域这件事由 Pages custom domain 流程自己解决；
 * wrangler 的 OAuth 挂 domain 够用但建 DNS 记录 403 —— 所以要独立 token。
 * 域名步骤失败不拉倒整次发布：deploy 已成功就返 pages.dev 地址 + warning。
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSharedDir } from '../projects/workspace.js';
import { taskManifest } from './kinds/index.js';
import { walkTaskFiles, loadIgnore } from './task-scan.js';
import {
  getPublished, upsertPublished, removePublished,
  countPublishedByUser, cfProjectNameFor, getByCustomDomain,
} from './publish-store.js';

const execFileAsync = promisify(execFile);
const DEPLOY_TIMEOUT_MS = 180_000;

export function publishLimit() {
  const v = Number(process.env.NODESIGN_USER_PUBLISH_LIMIT);
  return Number.isFinite(v) && v >= 0 ? v : 2;
}

export function validTaskName(name) {
  // `.` 是工作区根上那个站的 key（扁平化后最常见的一种），单独放行；
  // 其余仍然是单层目录名。
  if (name === '.') return true;
  return typeof name === 'string' && name.length > 0
    && !name.includes('/') && !name.includes('..') && !name.startsWith('.');
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** wrangler 跟着服务进程的 node 走（nvm 全局包和 node 同目录），pm2 的 PATH 不可靠 */
function wranglerBin() {
  return path.join(path.dirname(process.execPath), 'wrangler');
}

async function runWrangler(args) {
  return execFileAsync(wranglerBin(), args, {
    timeout: DEPLOY_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
}

/**
 * 找要发布的目录站点产物（单页试作不可发布）。
 *
 * `key` 扁平化之后是**站点的产物根**：`.` = 工作区根上那个站，`v2` 之类 =
 * 子目录站。发布记录表里的存量数据存的还是旧任务名，那些记录仍然能下线
 * （unpublish 走存下来的 host，不需要重新寻址），但重发布会认不出来 ——
 * 这是可接受的：重发布本来就要用户在界面上点一下当前那个站。
 *
 * root 消歧（main 39ca348 合入，语义照搬）：多个平行站点时不猜。
 *   - 显式传 root（'.' 表示工作区根）→ 精确匹配，匹配不上 400 并列出现有的
 *   - 没传 root：key 匹配 || 只有一个站兜底（旧发布记录兼容）|| 409 列候选
 */
async function resolveSiteRoot(pid, key, root) {
  const workspaceRoot = getSharedDir(pid);
  try { await fs.access(workspaceRoot); } catch { return null; }
  const manifest = await taskManifest(workspaceRoot);
  const sites = (manifest?.artifacts || []).filter(a => a.kind === 'site' && !a.single);
  if (!sites.length) return null;
  const label = (a) => a.root || '.';
  let inst;
  if (typeof root === 'string' && root !== '') {
    const want = root === '.' ? '' : root.replace(/\/+$/, '');
    inst = sites.find(a => (a.root || '') === want);
    if (!inst) {
      throw fail(400, `没有 root 为「${root}」的站点，现有：${sites.map(label).join('、')}`);
    }
  } else {
    const wanted = key === '.' || key === '' || key == null ? '' : String(key).replace(/\/+$/, '');
    inst = sites.find(a => (a.root || '') === wanted)
      || (sites.length === 1 ? sites[0] : null);
    if (!inst) {
      throw fail(409, `工作区里有 ${sites.length} 个平行站点：${sites.map(label).join('、')}`
        + ' —— 用 root 参数指定要发布哪个（工作区根传 "."），不能替你猜');
    }
  }
  return {
    taskDir: workspaceRoot,
    root: inst.root || '',
    rootAbs: inst.root ? path.join(workspaceRoot, inst.root) : workspaceRoot,
  };
}

/** staging：与整站 zip 同语义（产物根 + .ndignore + assets 副本 + 相对路径改写） */
async function stageSite(pid, { taskDir, root, rootAbs }) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-publish-'));
  const ignore = await loadIgnore(taskDir);
  const files = await walkTaskFiles(rootAbs, { maxDepth: 6, ignore, ignoreBase: taskDir });
  let staged = 0;
  for (const f of files) {
    if (!root && f.rel === 'canvas.html') continue;          // 根站排 deck 保留名
    if (f.rel === '.nd-project.json') continue;
    const dest = path.join(stage, f.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (/\.(html?|css)$/i.test(f.rel)) {
      const depth = f.rel.split('/').length - 1;
      const up = '../'.repeat(depth);
      const text = await fs.readFile(f.abs, 'utf8');
      await fs.writeFile(dest, text.replace(/(["'(])(?:\.\.\/)+assets\//g, `$1${up}assets/`));
    } else {
      await fs.copyFile(f.abs, dest);
    }
    staged += 1;
  }
  if (!staged) throw fail(400, '站点没有可发布的文件');
  const assetsDir = path.join(getSharedDir(pid), 'assets');
  try {
    await fs.cp(assetsDir, path.join(stage, 'assets'), { recursive: true, force: true });
  } catch { /* 没有素材目录就不带 */ }
  // 兜底 404（2026-08-07）：Pages 没有 404.html 时按 SPA 处理，任意路径都回退
  // index.html 返 200 —— 断链和发错站点完全隐形（agent 报障的另一半病根）。
  // NoDesign 的站点是静态多页，不需要 SPA 回退；站点自带 404.html 则不动。
  try {
    await fs.access(path.join(stage, '404.html'));
  } catch {
    await fs.writeFile(path.join(stage, '404.html'),
      '<!doctype html><meta charset="utf-8"><title>404</title>'
      + '<style>body{font-family:system-ui;display:flex;min-height:100vh;margin:0;'
      + 'align-items:center;justify-content:center;color:#5F5142;background:#F5F0E4}</style>'
      + '<p>404 · 这个地址下没有页面</p>');
  }
  return stage;
}

// ── Cloudflare API（custom domain 专用；deploy 本身走 wrangler）──

function domainConfig() {
  const suffix = process.env.NODESIGN_PUBLISH_DOMAIN;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!suffix || !token) return null;
  return {
    suffix,
    token,
    accountId: process.env.NODESIGN_CF_ACCOUNT_ID || 'd49a09c02b1c8f62936fb1db7417b7ca',
    apex: suffix.split('.').slice(-2).join('.'),
  };
}

async function cfApi(cfg, method, urlPath, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    const msg = (data.errors || []).map(e => e.message).join('; ') || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { cfErrors: data.errors });
  }
  return data.result;
}

let zoneIdCache = null;
async function zoneId(cfg) {
  if (zoneIdCache) return zoneIdCache;
  const zones = await cfApi(cfg, 'GET', `/zones?name=${cfg.apex}`);
  zoneIdCache = zones?.[0]?.id || null;
  if (!zoneIdCache) throw new Error(`zone ${cfg.apex} not found`);
  return zoneIdCache;
}

function hostSlug(task) {
  return String(task).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 32);
}

/**
 * 给已 deploy 的站点挂 <host>.<suffix>：Pages custom domain + 代理 CNAME。
 * host 首选任务名 slug（中文任务名 slug 化常剩空串，退回 hash）；被别的站占了
 * 就带 hash 后缀。幂等：published 记录里已有 custom_domain 就只补挂不换名。
 */
async function ensureCustomDomain({ pid, task, cfProject, existingDomain }) {
  const cfg = domainConfig();
  if (!cfg) return null;
  const hash = cfProject.slice(-6);
  let host;
  if (existingDomain) {
    host = existingDomain;
  } else {
    const slug = hostSlug(task);
    const bare = slug ? `${slug}.${cfg.suffix}` : `${hash}.${cfg.suffix}`;
    const taken = getByCustomDomain(bare);
    host = (taken && !(taken.projectId === pid && taken.task === task))
      ? `${slug ? `${slug}-` : ''}${hash}.${cfg.suffix}`
      : bare;
  }

  // ① Pages 项目挂域名（已挂过会报错 —— 幂等吞掉）
  try {
    await cfApi(cfg, 'POST', `/accounts/${cfg.accountId}/pages/projects/${cfProject}/domains`, { name: host });
  } catch (err) {
    if (!/already|exists|8000015/i.test(err.message)) throw err;
  }
  // ② 代理 CNAME → <cfProject>.pages.dev（已存在同名记录就不重建）
  const zid = await zoneId(cfg);
  const existing = await cfApi(cfg, 'GET', `/zones/${zid}/dns_records?type=CNAME&name=${host}`);
  if (!existing?.length) {
    await cfApi(cfg, 'POST', `/zones/${zid}/dns_records`, {
      type: 'CNAME', name: host, content: `${cfProject}.pages.dev`, proxied: true,
      comment: 'nodesign publish',
    });
  }
  return host;
}

/** 从 Pages 项目上摘域名。**必须在删项目之前**：挂着 custom domain 的项目
 * CF 拒删（code 8000028，2026-08-02 实测踩的）。 */
async function detachCustomDomain(site) {
  const cfg = domainConfig();
  if (!cfg || !site.customDomain) return;
  try {
    await cfApi(cfg, 'DELETE',
      `/accounts/${cfg.accountId}/pages/projects/${site.cfProject}/domains/${site.customDomain}`);
  } catch (err) {
    if (!/not found|does not exist/i.test(err.message)) throw err;
  }
}

async function removeCustomDomainDns(site) {
  const cfg = domainConfig();
  if (!cfg || !site.customDomain) return;
  const zid = await zoneId(cfg);
  const records = await cfApi(cfg, 'GET', `/zones/${zid}/dns_records?type=CNAME&name=${site.customDomain}`);
  for (const r of records || []) {
    await cfApi(cfg, 'DELETE', `/zones/${zid}/dns_records/${r.id}`);
  }
}

// ── 主流程 ──

// 同一站点同时只允许一个 deploy 在飞（双击/双开/agent 与人撞车防抖）
const inFlight = new Set();

/**
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.task
 * @param {string} [p.root]  多站点任务点名要发哪个（'.' = 任务根）；单站点可省
 * @param {object} p.user  额度与权限按这个用户算（HTTP = 请求者，MCP = 项目 owner）
 * @returns {{ site, warning: string|null }}
 */
export async function publishSite({ projectId, task, root, user }) {
  if (!validTaskName(task)) throw fail(400, 'invalid task');
  if (user?.lifetimeCostLimitUsd != null) {
    throw fail(403, '试用账号不能发布站点到公网 —— 想发布可以找站主换正式邀请码');
  }
  const existing = getPublished(projectId, task);
  if (!existing && user?.role !== 'admin') {
    const used = countPublishedByUser(user?.id);
    if (used >= publishLimit()) {
      throw fail(403, `你已发布 ${used} 个站点（上限 ${publishLimit()}），先下线一个再发`);
    }
  }
  const resolved = await resolveSiteRoot(projectId, task, root);
  if (!resolved) throw fail(400, '这个任务里没有可发布的目录站点');

  const key = `${projectId}/${task}`;
  if (inFlight.has(key)) throw fail(409, '这个站点正在发布中，稍等');
  inFlight.add(key);
  let stage = null;
  try {
    stage = await stageSite(projectId, resolved);
    const name = existing?.cfProject || cfProjectNameFor(projectId, task);
    try {
      await runWrangler(['pages', 'project', 'create', name, '--production-branch', 'main']);
    } catch (err) {
      const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
      if (!/already exists|8000007/i.test(msg)) throw err;
    }
    await runWrangler(['pages', 'deploy', stage, '--project-name', name, '--branch', 'main', '--commit-dirty=true']);

    let customDomain = existing?.customDomain || null;
    let warning = null;
    try {
      customDomain = await ensureCustomDomain({
        pid: projectId, task, cfProject: name, existingDomain: customDomain,
      });
    } catch (err) {
      console.warn('[publish] custom domain failed (deploy 本身成功):', err.message);
      warning = '专属域名没挂上，先用 pages.dev 地址；重新发布会再试';
    }
    const site = upsertPublished({
      projectId, task, userId: user?.id ?? null,
      cfProject: name,
      url: customDomain ? `https://${customDomain}` : `https://${name}.pages.dev`,
      customDomain,
    });
    return { site, warning };
  } finally {
    inFlight.delete(key);
    if (stage) fs.rm(stage, { recursive: true, force: true }).catch(() => { /* 临时目录清理失败不致命 */ });
  }
}

/** @returns {boolean} false = 本来就没发布 */
export async function unpublishSite({ projectId, task }) {
  if (!validTaskName(task)) throw fail(400, 'invalid task');
  const site = getPublished(projectId, task);
  if (!site) return false;
  await detachCustomDomain(site);           // 摘域名必须先于删项目（8000028）
  try {
    await runWrangler(['pages', 'project', 'delete', site.cfProject, '--yes']);
  } catch (err) {
    const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    if (!/not found|does not exist|8000007/i.test(msg)) throw err;
  }
  try {
    await removeCustomDomainDns(site);
  } catch (err) {
    console.warn('[publish] DNS 清理失败（Pages 项目已删，入口已死）:', err.message);
  }
  removePublished(projectId, task);
  return true;
}
