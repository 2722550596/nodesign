/**
 * server/api/skills.js — Skill 列表（plugin-aware）
 *
 * GET /api/skills                    列内置 + 用户级 plugin（不区分 project）
 * GET /api/skills?projectId=xxx      上面 + 加 project 级 plugin 内的 skills（拍平到 projectLocal）
 *
 * 2026-05-18 schema 改造（plugin convention）：
 *   {
 *     plugins: [
 *       { name, version, description, scope: 'builtin' | 'user', path, skills: [...] },
 *       ...
 *     ],
 *     projectLocal: [...]   // project 级 plugin 内的 skills 拍平，scope: 'project'
 *   }
 *
 * 数据源（plugin-loader.js 已经做了 scan + manifest 解析）：
 *   - builtin: server/engine/plugins/nodesign/
 *   - user:    <userHome>/.nodesign/plugins/*\/
 *   - project: <pid>/shared/.claude/plugins/*\/
 *
 * P0 只读不写；plugin 安装/卸载在 /api/plugins 和 /api/projects/:pid/plugins。
 */

import express from 'express';

import { validateProjectId, getProject } from '../projects/store.js';
import {
  getUserPluginsRoot,
  getBuiltinPluginsRoot,
  getProjectPluginsRoot,
  listInstalledPluginsDetailed,
} from '../engine/agent/plugin-loader.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [builtin, user] = await Promise.all([
      listInstalledPluginsDetailed(getBuiltinPluginsRoot()),
      listInstalledPluginsDetailed(getUserPluginsRoot()),
    ]);

    const plugins = [
      ...builtin.map(p => ({ ...p, scope: 'builtin' })),
      ...user.map(p => ({ ...p, scope: 'user' })),
    ];

    let projectLocal = [];
    const pid = req.query.projectId;
    if (pid && typeof pid === 'string') {
      try {
        validateProjectId(pid);
        const proj = getProject(pid);
        // 多用户（2026-07-30）：project 级 skill 只给项目归属人/admin 看
        if (proj && (req.user?.role === 'admin' || proj.ownerId === req.user?.id)) {
          const projectPlugins = await listInstalledPluginsDetailed(getProjectPluginsRoot(pid));
          // 拍平 project 级 skills（保留 plugin name 追溯）
          for (const p of projectPlugins) {
            for (const s of p.skills) {
              projectLocal.push({
                ...s,
                scope: 'project',
                pluginName: p.name,
              });
            }
          }
        }
      } catch { /* invalid pid → 静默忽略 */ }
    }

    res.json({ plugins, projectLocal });
  } catch (err) { next(err); }
});

export default router;
