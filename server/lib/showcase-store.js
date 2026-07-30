/**
 * server/lib/showcase-store.js — 个人作品橱窗（2026-07-30）
 *
 * 一条 showcase = 一件做完的作品 + 它沉淀出来的 skill。
 * 跟"模板市场"的区别：模板是别人替你预设风格，橱窗是**你自己探索出来的结论**被
 * 固化下来——第一次仍然是从问题长出骨架，第二次开始你有资格复用自己的结论。
 *
 * 归属：user_id 必填，只有本人（和 admin）看得到自己的橱窗。将来做跨用户市场时
 * 再加 published 字段和审核，不在这一版（SKILL.md 整段进 agent 上下文，
 * 陌生人的 skill 等于让人往你会话里写指令，得先有审核范围才能开）。
 *
 * artifact_rel 存 'tasks/<任务>/<入口>'，封面走 lib/cover.js 现截现缓存。
 */

import db from '../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS showcase (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    project_id    TEXT,
    task_id       TEXT,
    artifact_rel  TEXT,
    skill_name    TEXT,
    title         TEXT NOT NULL,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_showcase_user_created ON showcase(user_id, created_at DESC);
`);

function newId() {
  return `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    taskId: row.task_id,
    artifactRel: row.artifact_rel,
    skillName: row.skill_name,
    title: row.title,
    note: row.note,
    createdAt: row.created_at,
  };
}

/** 同一件产物只留一条（重复固化就是更新，不是堆一堆重复卡片） */
export function upsertEntry({ userId, projectId, taskId, artifactRel, skillName, title, note }) {
  if (!userId) throw new Error('userId required');
  const existing = artifactRel
    ? db.prepare('SELECT * FROM showcase WHERE user_id = ? AND project_id IS ? AND artifact_rel IS ?')
      .get(userId, projectId ?? null, artifactRel)
    : null;
  if (existing) {
    db.prepare(`UPDATE showcase
                SET task_id = ?, skill_name = ?, title = ?, note = ?, created_at = datetime('now')
                WHERE id = ?`)
      .run(taskId ?? null, skillName ?? null, title, note ?? null, existing.id);
    return rowToEntry(db.prepare('SELECT * FROM showcase WHERE id = ?').get(existing.id));
  }
  const id = newId();
  db.prepare(`INSERT INTO showcase (id, user_id, project_id, task_id, artifact_rel, skill_name, title, note)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, projectId ?? null, taskId ?? null, artifactRel ?? null,
      skillName ?? null, title, note ?? null);
  return rowToEntry(db.prepare('SELECT * FROM showcase WHERE id = ?').get(id));
}

export function listEntries(userId) {
  if (!userId) return [];
  return db.prepare('SELECT * FROM showcase WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId).map(rowToEntry);
}

export function getEntry(id) {
  return rowToEntry(db.prepare('SELECT * FROM showcase WHERE id = ?').get(id));
}

export function removeEntry(id, userId) {
  const info = db.prepare('DELETE FROM showcase WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

/** 项目删除时连带清（作品没了，卡片留着只会点出 404） */
export function removeEntriesForProject(projectId) {
  db.prepare('DELETE FROM showcase WHERE project_id = ?').run(projectId);
}
