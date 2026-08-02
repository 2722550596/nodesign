/**
 * server/lib/publish-store.js — 站点发布记录（2026-08-02 Cloudflare 一键上线）
 *
 * 一行 = 一个已发布站点（project+task 唯一）。cf_project 是 Cloudflare Pages
 * 项目名，全局唯一 —— URL 就是 https://<cf_project>.pages.dev，重发布不换名
 * 所以 URL 稳定。行删掉 = 已下线（Pages 项目同步删）。
 *
 * 配额口径按 user_id 数行：默认每个正式号 2 个（env NODESIGN_USER_PUBLISH_LIMIT），
 * admin 不限；重发布同一个任务不占新额度。
 */

import crypto from 'node:crypto';
import db from '../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS published_sites (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task TEXT NOT NULL,
    user_id TEXT,
    cf_project TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_published_at TEXT,
    UNIQUE(project_id, task)
  );
`);

// custom domain（08-02 当天追加）：<slug>.share.xiaobuyu.trade 这一层。
// 发布时挂上就记着，重发布沿用 —— URL 稳定性的真相源在这一列
const pubCols = new Set(db.prepare('PRAGMA table_info(published_sites)').all().map(c => c.name));
if (!pubCols.has('custom_domain')) {
  db.exec('ALTER TABLE published_sites ADD COLUMN custom_domain TEXT');
  console.log('[publish-store] published_sites.custom_domain column added');
}

function rowToSite(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    task: row.task,
    userId: row.user_id,
    cfProject: row.cf_project,
    url: row.url,
    customDomain: row.custom_domain || null,
    createdAt: row.created_at,
    lastPublishedAt: row.last_published_at,
  };
}

export function getPublished(projectId, task) {
  return rowToSite(db.prepare(
    'SELECT * FROM published_sites WHERE project_id = ? AND task = ?',
  ).get(projectId, task));
}

export function countPublishedByUser(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM published_sites WHERE user_id = ?').get(userId).n;
}

export function listPublished() {
  return db.prepare('SELECT * FROM published_sites ORDER BY last_published_at DESC').all().map(rowToSite);
}

export function getByCustomDomain(host) {
  return rowToSite(db.prepare('SELECT * FROM published_sites WHERE custom_domain = ?').get(host));
}

/** 发布成功后落记录（存在则刷时间戳 + 补 domain/url —— 重发布 URL 不变） */
export function upsertPublished({ projectId, task, userId, cfProject, url, customDomain = null }) {
  const existing = getPublished(projectId, task);
  if (existing) {
    db.prepare(
      "UPDATE published_sites SET last_published_at = datetime('now'), url = ?, custom_domain = ? WHERE id = ?",
    ).run(url, customDomain, existing.id);
    return getPublished(projectId, task);
  }
  const id = `pub_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  db.prepare(`
    INSERT INTO published_sites (id, project_id, task, user_id, cf_project, url, custom_domain, last_published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, projectId, task, userId, cfProject, url, customDomain);
  return getPublished(projectId, task);
}

export function removePublished(projectId, task) {
  return db.prepare('DELETE FROM published_sites WHERE project_id = ? AND task = ?')
    .run(projectId, task).changes > 0;
}

/**
 * Pages 项目名：nd-<任务名slug>-<hash6>。任务名多半是中文，slug 化后常剩空串，
 * hash（pid+task 派生，稳定）才是唯一性的真来源；slug 只为了人在 CF 面板里认得出。
 * Pages 命名规则：小写字母数字连字符，不能头尾连字符。
 */
export function cfProjectNameFor(projectId, task) {
  const slug = String(task).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 24);
  const hash = crypto.createHash('sha1').update(`${projectId}/${task}`).digest('hex').slice(0, 6);
  return `nd-${slug ? `${slug}-` : ''}${hash}`;
}
