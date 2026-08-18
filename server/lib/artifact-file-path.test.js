// artifact-file 的路径判据（2026-08-18 从路由抽出来时补的测试）。
// ⚠️ `tasks/` 那条是审查抓到的真 bug：扁平化之后 agent 完全可以真建一个叫
// `tasks/` 的目录，而无条件剥前两段会把**磁盘上真实存在的文件**变成 404。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveArtifactFile } from './artifact-file-path.js';

let root;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-afp-'));
  await fs.mkdir(path.join(root, 'assets/generated/.thumbnails'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  await fs.mkdir(path.join(root, 'tasks/真的有这个目录'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), 'x');
  await fs.writeFile(path.join(root, 'assets/generated/.thumbnails/a.thumb.webp'), 'x');
  await fs.writeFile(path.join(root, 'tasks/真的有这个目录/page.html'), 'x');
  await fs.writeFile(path.join(root, '.claude/settings.json'), '{}');
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('resolveArtifactFile', () => {
  it('普通路径直通', async () => {
    const r = await resolveArtifactFile(root, 'index.html');
    expect(r.ok).toBe(true);
    expect(r.subPath).toBe('index.html');
  });

  it('空路径 400', async () => {
    expect(await resolveArtifactFile(root, '')).toMatchObject({ ok: false, status: 400 });
  });

  it('越界 403', async () => {
    expect(await resolveArtifactFile(root, '../../../etc/passwd')).toMatchObject({ ok: false, status: 403 });
  });

  it('基础设施目录 403（.claude 里有 settings.json 和整份转录）', async () => {
    expect(await resolveArtifactFile(root, '.claude/settings.json')).toMatchObject({ ok: false, status: 403 });
    expect(await resolveArtifactFile(root, '.nd/x/y.json')).toMatchObject({ ok: false, status: 403 });
    expect(await resolveArtifactFile(root, '.git/config')).toMatchObject({ ok: false, status: 403 });
  });

  it('白名单点目录放行（缩略图和 sidecar 住那儿）', async () => {
    expect((await resolveArtifactFile(root, 'assets/generated/.thumbnails/a.thumb.webp')).ok).toBe(true);
    expect((await resolveArtifactFile(root, 'assets/references/web/.meta/x.json')).ok).toBe(true);
  });

  it('旧形态 tasks/<任务>/x 剥掉前两段（浏览器缓存和旧 board.json 里还有）', async () => {
    const r = await resolveArtifactFile(root, 'tasks/某个老任务/index.html');
    expect(r.ok).toBe(true);
    expect(r.subPath).toBe('index.html');
  });

  it('⭐ 磁盘上真的有 tasks/<名>/ 时不许剥 —— 剥了就把真实文件 404 掉', async () => {
    const r = await resolveArtifactFile(root, 'tasks/真的有这个目录/page.html');
    expect(r.ok).toBe(true);
    expect(r.subPath).toBe('tasks/真的有这个目录/page.html');   // 原样，没被剥
  });

  it('数组形态的 subPath（express 分段）也认', async () => {
    const r = await resolveArtifactFile(root, ['assets', 'generated', '.thumbnails', 'a.thumb.webp']);
    expect(r.ok).toBe(true);
  });
});
