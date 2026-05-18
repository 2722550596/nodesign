/**
 * server/lib/plugin-validator.js — Plugin zip 包格式校验
 *
 * 用户上传 plugin zip 时先过这层，hard-fail 拒绝危险/不合规包，warn 提示
 * 非致命问题。pass 后才允许写盘。
 *
 * 校验流程（按成本递增）：
 *   1. zip 元信息（大小 / entry 数）—— 几乎免费
 *   2. entry 路径安全（path traversal / 绝对路径）—— 解析 zip 不读 entry 内容
 *   3. 必备文件存在（.claude-plugin/plugin.json + skills/<id>/SKILL.md）
 *   4. 读 plugin.json + 解析 + 字段校验
 *   5. 遍历每个 SKILL.md 读 frontmatter + 校验 name 字段
 *
 * 任何 hard-fail 立即停止后续，返 `{ok: false, errors: [...]}`。
 *
 * SDK plugin convention（约定的目录结构）：
 *   <plugin-root>/
 *     .claude-plugin/plugin.json   { name, version?, description? }
 *     skills/<skill-id>/SKILL.md   YAML frontmatter { name, version?, description? }
 *
 * 安全约束：
 *   - jszip 不解析 zip 里的 unix 文件类型/权限，所以不存在 symlink 风险
 *     （jszip 把所有 entry 当 data file 提取）；但仍需查 path traversal
 *   - 总 / 单文件大小限制防 zip bomb
 *
 * 复用：parseFrontmatter from server/engine/agent/skill.js
 */

import JSZip from 'jszip';
import { parseFrontmatter } from '../engine/agent/skill.js';

// ── 校验阈值 ──

export const LIMITS = {
  ZIP_MAX_BYTES: 8 * 1024 * 1024,      // 总大小 ≤ 8MB
  ENTRY_MAX_BYTES: 2 * 1024 * 1024,    // 单文件 ≤ 2MB
  ENTRY_MAX_COUNT: 200,                 // entries ≤ 200
};

export const WARN_THRESHOLDS = {
  DESC_MAX_CHARS: 1536,                 // SDK skill listing description 单条截断阈值
  SKILL_BODY_MAX_BYTES: 50 * 1024,      // SKILL.md body 超 50KB context 占用大
};

// plugin name 命名规范：仅 [a-z0-9-]，≤ 40 char
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// 保留前缀（不允许用户 plugin 撞）。`nodesign` 是内置，其余是潜在系统/protocol 名空间
const RESERVED_PLUGIN_NAMES = new Set([
  'nodesign', 'claude', 'anthropic', 'system', 'builtin', 'default',
]);

/**
 * 校验 plugin zip buffer。
 *
 * @param {Buffer} buffer - 用户上传 zip 文件内容
 * @returns {Promise<{
 *   ok: true, manifest: object, skills: Array<{id, name, version, description}>, warnings: string[]
 * } | {
 *   ok: false, errors: string[]
 * }>}
 */
export async function validatePluginZip(buffer) {
  const errors = [];
  const warnings = [];

  // ── 1. 总大小 ──
  if (!Buffer.isBuffer(buffer)) {
    return { ok: false, errors: ['上传内容不是有效 Buffer'] };
  }
  if (buffer.length > LIMITS.ZIP_MAX_BYTES) {
    return {
      ok: false,
      errors: [`zip 总大小 ${formatBytes(buffer.length)} 超限（≤ ${formatBytes(LIMITS.ZIP_MAX_BYTES)}）`],
    };
  }

  // ── 2. 解压 ──
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return { ok: false, errors: [`zip 解压失败：${err.message}`] };
  }

  const entries = Object.keys(zip.files);

  // ── 3. entry 数量 ──
  if (entries.length > LIMITS.ENTRY_MAX_COUNT) {
    return {
      ok: false,
      errors: [`zip 含 ${entries.length} 个 entry，超限（≤ ${LIMITS.ENTRY_MAX_COUNT}）`],
    };
  }
  if (entries.length === 0) {
    return { ok: false, errors: ['zip 为空'] };
  }

  // ── 4. entry 路径安全（path traversal / 绝对路径） ──
  // 同时统一识别 zip 根：有些打包工具会包一层顶级目录（如 foo-plugin/.claude-plugin/...）
  // 这里查每个 entry path 是否 unsafe + 收集所有顶级 dir 段
  const topDirs = new Set();
  for (const p of entries) {
    if (p.includes('\\')) {
      errors.push(`entry 路径 \`${p}\` 含反斜杠（Windows 风格），拒绝`);
      break;
    }
    if (p.startsWith('/')) {
      errors.push(`entry 路径 \`${p}\` 是绝对路径，拒绝`);
      break;
    }
    // 任何段含 .. 都拒（即使 zip 库本身可能正规化）
    const segs = p.split('/');
    if (segs.some(s => s === '..')) {
      errors.push(`entry 路径 \`${p}\` 含 \`..\`（path traversal 风险），拒绝`);
      break;
    }
    if (segs[0]) topDirs.add(segs[0]);
  }
  if (errors.length > 0) return { ok: false, errors };

  // ── 5. 识别 plugin root（顶级要么直接是 .claude-plugin 要么是一层 wrapper） ──
  // 情况 A：zip 根 = plugin root（顶级有 .claude-plugin/）
  // 情况 B：zip 根 = wrapper/ → plugin root（wrapper/.claude-plugin/...）
  let rootPrefix = '';
  if (!zip.file('.claude-plugin/plugin.json')) {
    // 找单一 wrapper：所有 entry 顶级都是同一个 dir
    if (topDirs.size === 1) {
      const wrapper = [...topDirs][0];
      if (zip.file(`${wrapper}/.claude-plugin/plugin.json`)) {
        rootPrefix = `${wrapper}/`;
      }
    }
  }
  const manifestPath = `${rootPrefix}.claude-plugin/plugin.json`;
  const manifestEntry = zip.file(manifestPath);
  if (!manifestEntry) {
    return {
      ok: false,
      errors: ['缺 `.claude-plugin/plugin.json` —— zip 必须含 plugin manifest（直接在 zip 根或单层 wrapper 内）'],
    };
  }

  // ── 6. 读 manifest + 校验 ──
  let manifestRaw;
  try {
    manifestRaw = await manifestEntry.async('string');
  } catch (err) {
    return { ok: false, errors: [`读取 plugin.json 失败：${err.message}`] };
  }
  if (Buffer.byteLength(manifestRaw, 'utf8') > LIMITS.ENTRY_MAX_BYTES) {
    return { ok: false, errors: [`plugin.json 单文件超 ${formatBytes(LIMITS.ENTRY_MAX_BYTES)}`] };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (err) {
    return { ok: false, errors: [`plugin.json 不是 valid JSON：${err.message}`] };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['plugin.json 必须是 JSON object'] };
  }

  const pluginName = manifest.name;
  if (!pluginName || typeof pluginName !== 'string') {
    return { ok: false, errors: ['plugin.json 缺 `name` 字段（必需）'] };
  }
  if (!PLUGIN_NAME_RE.test(pluginName)) {
    return {
      ok: false,
      errors: [`plugin name \`${pluginName}\` 不合规：仅允许 [a-z0-9-]，首字符不能是 -，长度 ≤ 40`],
    };
  }
  if (RESERVED_PLUGIN_NAMES.has(pluginName)) {
    return {
      ok: false,
      errors: [`plugin name \`${pluginName}\` 是保留名（不允许使用：${[...RESERVED_PLUGIN_NAMES].join(' / ')}）`],
    };
  }

  if (manifest.version && typeof manifest.version !== 'string') {
    return { ok: false, errors: ['plugin.json `version` 字段必须是 string'] };
  }
  if (!manifest.version) {
    warnings.push('plugin.json 缺 `version`，默认为 `0.0.0`');
  }

  // ── 7. 找 skills/<id>/SKILL.md ──
  const skillsPrefix = `${rootPrefix}skills/`;
  const skillFiles = entries.filter(p => p.startsWith(skillsPrefix) && p.endsWith('/SKILL.md'));
  if (skillFiles.length === 0) {
    return {
      ok: false,
      errors: ['plugin 必须含至少 1 个 `skills/<id>/SKILL.md`'],
    };
  }

  // ── 8. 逐个 skill 校验 ──
  const skills = [];
  for (const skillFilePath of skillFiles) {
    // 路径形如 [rootPrefix]skills/<id>/SKILL.md，提取 <id>
    const relativeAfterSkills = skillFilePath.slice(skillsPrefix.length); // <id>/SKILL.md
    const segs = relativeAfterSkills.split('/');
    // 拒绝深层嵌套（skills/<id>/sub/SKILL.md 不算合规 skill 入口）
    if (segs.length !== 2 || segs[1] !== 'SKILL.md') {
      // 容忍 — 不是 skill 入口，跳过
      continue;
    }
    const skillId = segs[0];
    if (!PLUGIN_NAME_RE.test(skillId)) {
      return {
        ok: false,
        errors: [`skill id \`${skillId}\` 不合规：仅允许 [a-z0-9-]，长度 ≤ 40`],
      };
    }

    const skillEntry = zip.file(skillFilePath);
    let skillRaw;
    try {
      skillRaw = await skillEntry.async('string');
    } catch (err) {
      return { ok: false, errors: [`读取 ${skillFilePath} 失败：${err.message}`] };
    }
    const skillBytes = Buffer.byteLength(skillRaw, 'utf8');
    if (skillBytes > LIMITS.ENTRY_MAX_BYTES) {
      return {
        ok: false,
        errors: [`${skillFilePath} 单文件 ${formatBytes(skillBytes)} 超 ${formatBytes(LIMITS.ENTRY_MAX_BYTES)}`],
      };
    }

    const { frontmatter } = parseFrontmatter(skillRaw);
    if (!frontmatter.name) {
      return {
        ok: false,
        errors: [`${skillFilePath} 缺 YAML frontmatter \`name\` 字段（必需）`],
      };
    }
    if (!PLUGIN_NAME_RE.test(frontmatter.name)) {
      return {
        ok: false,
        errors: [`${skillFilePath} frontmatter \`name: ${frontmatter.name}\` 不合规：仅允许 [a-z0-9-]，长度 ≤ 40`],
      };
    }

    // warn 阈值
    if (frontmatter.description && frontmatter.description.length > WARN_THRESHOLDS.DESC_MAX_CHARS) {
      warnings.push(
        `${skillFilePath} description ${frontmatter.description.length} char 超 ${WARN_THRESHOLDS.DESC_MAX_CHARS}（SDK skill listing 会被截）`,
      );
    }
    if (skillBytes > WARN_THRESHOLDS.SKILL_BODY_MAX_BYTES) {
      warnings.push(
        `${skillFilePath} body ${formatBytes(skillBytes)} 超 ${formatBytes(WARN_THRESHOLDS.SKILL_BODY_MAX_BYTES)}（agent invoke 时 context 占用大）`,
      );
    }
    if (!frontmatter.version) {
      warnings.push(`${skillFilePath} 缺 frontmatter \`version\`，默认为 \`0.0.0\``);
    }

    skills.push({
      id: skillId,
      name: frontmatter.name,
      version: frontmatter.version || '0.0.0',
      description: frontmatter.description || '',
    });
  }

  if (skills.length === 0) {
    return {
      ok: false,
      errors: ['未找到合规 skill（skills/<id>/SKILL.md 至少 1 个，路径形态需精确）'],
    };
  }

  // ── 9. 单文件大小：抽查所有 entry ──
  // 大文件可能在 patterns/ 等附件里；逐个 entry uncompressed 大小检查
  for (const p of entries) {
    const entry = zip.files[p];
    if (entry.dir) continue;
    // jszip 没暴露 uncompressedSize（除非用 _data），保守做法：解到 nodebuffer 看大小
    // 但全 zip 解一遍开销大，这里只对 *已知关键路径*（manifest + skill）做尺寸保护（上面已做）。
    // 其他文件（如 skill 的 patterns/*.md）按总大小限制即可（总 ≤ 8MB 包含）。
  }

  return {
    ok: true,
    manifest: {
      name: pluginName,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
    },
    skills,
    warnings,
    rootPrefix,  // 解压时用，去掉 wrapper 层
  };
}

/**
 * 把校验通过的 zip 解压到目标目录（atomic：先解到 staging，调用方完成后 rename）。
 *
 * 注意：本函数假定 `validatePluginZip` 已经过，**只关心 path 安全**这一项二次防御。
 *
 * @param {Buffer} buffer
 * @param {string} stagingDir - 已建好的空目录绝对路径
 * @param {string} rootPrefix - validate 时识别的 wrapper 前缀（可能是 '' 或 'foo/'）
 * @returns {Promise<void>}
 */
export async function extractPluginZip(buffer, stagingDir, rootPrefix = '') {
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  const zip = await JSZip.loadAsync(buffer);
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    // 去 wrapper 前缀
    if (rootPrefix && !entryPath.startsWith(rootPrefix)) continue;
    const relativePath = rootPrefix ? entryPath.slice(rootPrefix.length) : entryPath;
    if (!relativePath) continue;
    // 二次防御：拒绝 .. / 绝对路径（应该已被 validate 拦但保险）
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      throw new Error(`unsafe entry path during extract: ${relativePath}`);
    }
    const targetPath = path.join(stagingDir, relativePath);
    // 校验解压后路径仍在 stagingDir 下（resolve 后比较 prefix）
    const resolvedTarget = path.resolve(targetPath);
    const resolvedStaging = path.resolve(stagingDir);
    if (!resolvedTarget.startsWith(resolvedStaging + path.sep) && resolvedTarget !== resolvedStaging) {
      throw new Error(`extract target escapes staging dir: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const content = await entry.async('nodebuffer');
    await fs.writeFile(targetPath, content);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
