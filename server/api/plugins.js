/**
 * server/api/plugins.js — Plugin 上传 / 列表 / 卸载（用户级 + project 级 两套 router）
 *
 * 用户级（跨 project 全局，挂在 /api/plugins）：
 *   GET    /api/plugins                                列用户级 plugin
 *   POST   /api/plugins/install                        上传 zip → ~/.nodesign/plugins/
 *   DELETE /api/plugins/:name                          卸载用户级 plugin
 *
 * Project 级（仅当前 project，挂在 /api/projects 跟 assets/turn 同前缀）：
 *   GET    /api/projects/:pid/plugins                  列 project 级 plugin
 *   POST   /api/projects/:pid/plugins/install          上传 zip → <pid>/shared/.claude/plugins/
 *   DELETE /api/projects/:pid/plugins/:name            卸载 project 级 plugin
 *
 * 上传流程（两轨同套）：
 *   1. multer 收 multipart `file` 字段到 memory buffer
 *   2. validatePluginZip(buffer) — hard-fail 立即 400 + 详细 errors[]
 *   3. 解压到 staging 临时目录（同一 root 下 .staging/<tmpId>/）
 *   4. 目标 plugin name 已存在：没 `?force=true` 返 409 + 当前装的 manifest；
 *      有 force：先 rm -rf 旧目录
 *   5. atomic rename staging → 目标
 *   6. 返 manifest + skills + warnings
 *
 * 安全：validator 已拦 path traversal / 保留 name / 大小 / 格式；extractPluginZip
 *   二次防御解压路径不出 staging dir；DELETE 校验 name 合规 + 不撞保留前缀。
 *
 * 复用：multer memoryStorage pattern from server/api/assets.js:13-26
 */

import express from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';

import { validateProjectId, getProject } from '../projects/store.js';
import {
  getUserPluginsRoot,
  getProjectPluginsRoot,
  listInstalledPluginsDetailed,
} from '../engine/agent/plugin-loader.js';
import {
  validatePluginZip,
  extractPluginZip,
  LIMITS,
} from '../lib/plugin-validator.js';

// ── plugin name 合规检查（同 validator，但 DELETE 路径需独立查） ──
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED_PLUGIN_NAMES = new Set([
  'nodesign', 'claude', 'anthropic', 'system', 'builtin', 'default',
]);

function isValidPluginName(name) {
  return typeof name === 'string'
    && PLUGIN_NAME_RE.test(name)
    && !RESERVED_PLUGIN_NAMES.has(name);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.ZIP_MAX_BYTES },
});

// ── 安装核心（两轨共用） ──

async function installPluginToRoot(buffer, targetRoot, { force }) {
  const validation = await validatePluginZip(buffer);
  if (!validation.ok) {
    return { status: 400, body: { error: 'validation failed', errors: validation.errors } };
  }
  const { manifest, skills, warnings, rootPrefix } = validation;
  const targetDir = path.join(targetRoot, manifest.name);

  let existingManifest = null;
  try {
    const raw = await fs.readFile(path.join(targetDir, '.claude-plugin', 'plugin.json'), 'utf8');
    existingManifest = JSON.parse(raw);
  } catch { /* not installed */ }

  if (existingManifest && !force) {
    return {
      status: 409,
      body: {
        error: 'plugin already installed',
        existing: {
          name: existingManifest.name,
          version: existingManifest.version || '0.0.0',
          description: existingManifest.description || '',
        },
        incoming: manifest,
        hint: '加 ?force=true 强制覆盖（旧 plugin 目录会被删除）',
      },
    };
  }

  // staging：装到目标 root 下的 .staging/<tmpId>/，方便 atomic rename 同设备
  await fs.mkdir(targetRoot, { recursive: true });
  const stagingRoot = path.join(targetRoot, '.staging');
  await fs.mkdir(stagingRoot, { recursive: true });
  const tmpDir = path.join(stagingRoot, `${manifest.name}-${Date.now().toString(36)}`);
  await fs.mkdir(tmpDir);

  try {
    await extractPluginZip(buffer, tmpDir, rootPrefix);
    if (existingManifest) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
    await fs.rename(tmpDir, targetDir);
  } catch (err) {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }

  return {
    status: existingManifest ? 200 : 201,
    body: {
      installed: { ...manifest, path: targetDir, skills },
      replaced: existingManifest || null,
      warnings,
    },
  };
}

// ── 卸载核心 ──

async function uninstallFromRoot(rootDir, name) {
  if (!isValidPluginName(name)) {
    return { status: 400, body: { error: `plugin name \`${name}\` 不合规或是保留名` } };
  }
  const targetDir = path.join(rootDir, name);
  const resolved = path.resolve(targetDir);
  const resolvedRoot = path.resolve(rootDir);
  if (!resolved.startsWith(resolvedRoot + path.sep)) {
    return { status: 400, body: { error: 'invalid target path' } };
  }
  try {
    await fs.access(targetDir);
  } catch {
    return { status: 404, body: { error: `plugin \`${name}\` not installed` } };
  }
  await fs.rm(targetDir, { recursive: true, force: true });
  return { status: 200, body: { uninstalled: name } };
}

// ── Router 1：用户级（挂 /api/plugins） ──

export const userPluginsRouter = express.Router();

userPluginsRouter.get('/', async (_req, res, next) => {
  try {
    const plugins = await listInstalledPluginsDetailed(getUserPluginsRoot());
    res.json({ plugins });
  } catch (err) { next(err); }
});

userPluginsRouter.post('/install', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file (field name: file)' });
    const force = req.query.force === 'true';
    const result = await installPluginToRoot(req.file.buffer, getUserPluginsRoot(), { force });
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

userPluginsRouter.delete('/:name', async (req, res, next) => {
  try {
    const result = await uninstallFromRoot(getUserPluginsRoot(), req.params.name);
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

// ── Router 2：project 级（挂 /api/projects，跟 assets/turn 同前缀） ──

export const projectPluginsRouter = express.Router();

projectPluginsRouter.get('/:pid/plugins', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    const root = getProjectPluginsRoot(req.params.pid);
    const plugins = await listInstalledPluginsDetailed(root);
    res.json({ plugins });
  } catch (err) { next(err); }
});

projectPluginsRouter.post('/:pid/plugins/install', upload.single('file'), async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    if (!req.file) return res.status(400).json({ error: 'no file (field name: file)' });
    const force = req.query.force === 'true';
    const root = getProjectPluginsRoot(req.params.pid);
    const result = await installPluginToRoot(req.file.buffer, root, { force });
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

projectPluginsRouter.delete('/:pid/plugins/:name', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    const root = getProjectPluginsRoot(req.params.pid);
    const result = await uninstallFromRoot(root, req.params.name);
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

export default { userPluginsRouter, projectPluginsRouter };
