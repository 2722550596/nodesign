import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（跟其它服务端测试同一套纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-tasklist-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { EventBus } = await import('../agent/events.js');
const { attachBoardTasklist, canvasIdForRel, _resetBoardTasklist } = await import('./board-tasklist.js');
const { readBoard, patchBoard } = await import('../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../projects/workspace.js');

const pid = 'proj_tasklist_test';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

describe('board-tasklist（步骤清单镜像成板书）', () => {
  beforeAll(async () => { await ensureProjectWorkspace(pid); _resetBoardTasklist(); });

  it('canvasIdForRel：精确 > deck: > 站点根 > 原样', () => {
    const board = { objects: { 'deck:a.html': { x: 0, y: 0 }, 'site:Duvet': { x: 0, y: 0 }, 'assets/x.png': { x: 0, y: 0 } } };
    expect(canvasIdForRel(board, 'assets/x.png')).toBe('assets/x.png');
    expect(canvasIdForRel(board, 'a.html')).toBe('deck:a.html');
    expect(canvasIdForRel(board, 'Duvet/style.css')).toBe('site:Duvet');
    expect(canvasIdForRel(board, 'new.html')).toBe('deck:new.html');
  });

  it('todo → 板书文件 + 座位；file_changed → 到产物的「第 N 步」线；done 清状态', async () => {
    const bus = new EventBus();
    attachBoardTasklist(bus, pid);
    await patchBoard(pid, { objects: { 'deck:海报.html': { x: 100, y: 100 } } });
    const runId = 'run_abcdef123456';
    bus.publish({ type: 'run.todo.updated', runId, sessionId: 's1', todos: [
      { content: '定风格', status: 'completed', activeForm: '定风格' },
      { content: '画海报', status: 'in_progress', activeForm: '画海报' },
      { content: '写说明', status: 'pending', activeForm: '写说明' },
    ] });
    await wait(300);
    let board = await readBoard(pid);
    const chalkIds = Object.keys(board.objects).filter(id => id.startsWith('notes/板书/'));
    expect(chalkIds.length).toBe(1);
    const raw = await fs.readFile(path.join(getSharedDir(pid), chalkIds[0]), 'utf8');
    expect(raw).toContain('nd: chalk');
    expect(raw).toContain('- [x] 定风格');
    expect(raw).toContain('**→ 画海报**');
    expect(raw).toContain('- [ ] 写说明');

    bus.publish({ type: 'run.file_changed', runId, sessionId: 's1', filePath: '海报.html', event: 'change' });
    bus.publish({ type: 'run.file_changed', runId, sessionId: 's1', filePath: '海报.html', event: 'change' });   // 同一件只连一次
    await wait(300);
    board = await readBoard(pid);
    const lines = Object.values(board.bindings).filter(b => b.from === chalkIds[0]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ to: 'deck:海报.html', type: 'annotates', by: 'auto', label: '第 2 步' });

    // 更新清单：原地改，座位不动、文件同一个
    const pos = board.objects[chalkIds[0]];
    bus.publish({ type: 'run.todo.updated', runId, sessionId: 's1', todos: [
      { content: '定风格', status: 'completed' }, { content: '画海报', status: 'completed' }, { content: '写说明', status: 'in_progress', activeForm: '正在写说明' },
    ] });
    await wait(300);
    board = await readBoard(pid);
    expect(Object.keys(board.objects).filter(id => id.startsWith('notes/板书/'))).toEqual(chalkIds);
    expect(board.objects[chalkIds[0]].x).toBe(pos.x);
    expect(await fs.readFile(path.join(getSharedDir(pid), chalkIds[0]), 'utf8')).toContain('**→ 正在写说明**');

    bus.publish({ type: 'run.done', runId, sessionId: 's1' });
    await wait(100);
    bus.publish({ type: 'run.file_changed', runId, sessionId: 's1', filePath: 'b.png', event: 'change' });
    await wait(200);
    board = await readBoard(pid);
    expect(Object.values(board.bindings).filter(b => b.from === chalkIds[0]).length).toBe(1);
  });
});
