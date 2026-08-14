/**
 * moveEntry 回归（2026-08-14 可维护性行动 D 刀：冒烟脚本转正）。
 *
 * 这套用例原是 scratchpad 冒烟脚本 —— 会话结束就蒸发，等于没有。转正进仓，
 * 钉的是搬家语义的三方一致：磁盘真动了、board 物件换了身份、关系线端点跟走。
 * 用户拖拽和 agent 的 organize_board 共用这一份实现（单一真相源）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ⚠️ 数据根必须在 import workspace.js 之前定（PROJECTS_DATA_ROOT 是模块加载时
// 从 env 解析的常量）—— 所以这里用顶层 await 的动态 import，别改成静态。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-move-test-'));
process.env.PROJECTS_DATA_DIR = tmp;
const { moveEntry, MoveError } = await import('./move-entry.js');

const PID = 'proj_test0000_move';
const root = path.join(tmp, PID, 'shared');
const boardPath = path.join(root, 'board.json');
const readBoard = () => JSON.parse(fs.readFileSync(boardPath, 'utf8'));

const expectMoveError = async (p, status) => {
  await expect(p).rejects.toSatisfy(
    (e) => e instanceof MoveError && e.status === status,
    `应抛 MoveError(${status})`,
  );
};

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'assets/generated'), { recursive: true });
  fs.mkdirSync(path.join(root, '观察日志'), { recursive: true });
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/generated/a.png'), 'img1');
  fs.writeFileSync(path.join(root, 'assets/generated/b.png'), 'img2');
  fs.writeFileSync(path.join(root, '观察日志/index.html'), 'idx');
  fs.writeFileSync(path.join(root, 'notes/决策.md'), 'note');
  fs.writeFileSync(path.join(root, '旧稿.html'), 'loose');
  fs.writeFileSync(boardPath, JSON.stringify({
    size: { w: 4000, h: 2600 },
    zones: {},
    objects: {
      'assets/generated/a.png': { x: 10, y: 20, z: 1 },
      'deck:旧稿.html': { x: 50, y: 60, z: 2 },
    },
    bindings: {
      'b:1': { type: 'ref', from: 'assets/generated/a.png', to: 'deck:旧稿.html' },
    },
  }));
});

describe('moveEntry —— 搬家语义（磁盘/board/关系线三方一致）', () => {
  it('搬图进新夹（createFolder 自动建夹），board 身份与位置跟走', async () => {
    const r = await moveEntry(PID, 'assets/generated/a.png', '素材', { createFolder: true });
    expect(r).toMatchObject({ ok: true, from: 'assets/generated/a.png', to: '素材/a.png', moved: true });
    expect(fs.existsSync(path.join(root, '素材/a.png'))).toBe(true);
    const b = readBoard();
    expect(b.objects['素材/a.png']).toMatchObject({ x: 10, y: 20 });
    expect(b.objects['assets/generated/a.png']).toBeUndefined();
    expect(b.bindings['b:1'].from).toBe('素材/a.png');   // 关系线端点跟走
  });

  it('搬 deck 进站点的 assets/ 子目录（站根不透明，assets/ 放行）', async () => {
    const r = await moveEntry(PID, '旧稿.html', '观察日志/assets', { createFolder: true });
    expect(r.to).toBe('观察日志/assets/旧稿.html');
    expect(readBoard().bindings['b:1'].to).toBe('deck:观察日志/assets/旧稿.html');
  });

  it('站点根被拒：它是产物不是收纳文件夹', async () => {
    await expectMoveError(moveEntry(PID, '素材/a.png', '观察日志', { createFolder: true }), 400);
  });

  it('便签可以搬出 notes/（2026-08-14 放开，明码换形态）', async () => {
    const r = await moveEntry(PID, 'notes/决策.md', '素材');
    expect(r.to).toBe('素材/决策.md');
  });

  it('搬回 notes/ 仍被目标守卫挡（升格回便签是单独一道闸）', async () => {
    await expectMoveError(moveEntry(PID, '素材/决策.md', 'notes'), 400);
  });

  it('点目录 / 基础设施目录拒进', async () => {
    await expectMoveError(moveEntry(PID, '素材/a.png', '.nd', { createFolder: true }), 400);
    await expectMoveError(moveEntry(PID, '素材/a.png', 'exports', { createFolder: true }), 400);
  });

  it('不存在的源 404；目标夹不存在且不建 404', async () => {
    await expectMoveError(moveEntry(PID, '不存在.png', '素材'), 404);
    await expectMoveError(moveEntry(PID, '素材/a.png', '没这个夹'), 404);
  });

  it('文件夹不能搬进自己肚子里', async () => {
    await expectMoveError(moveEntry(PID, '素材', '素材/里屋', { createFolder: true }), 400);
  });

  it('同名冲突 409', async () => {
    fs.writeFileSync(path.join(root, 'b.png'), 'dup');
    await expectMoveError(moveEntry(PID, 'assets/generated/b.png', ''), 409);
  });
});
