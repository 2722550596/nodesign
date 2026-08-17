import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { safeResolveRead, safeResolveWrite } from './safe-path.js';

/**
 * ⭐这套是**回归测试**，起因是一次真实的越权：docx 页图路由抄了导出收集器那道
 * 守卫的**调用形状**、没抄它的 realpath 复核，于是工作区里一个指向 `.env` 的
 * 软链能被 LibreOffice 渲成一张 PNG 发给用户 —— 而这条路走的是**没有沙盒的
 * server 进程**，绕开了给 agent 设的 permissions.deny。
 *
 * 判据从此只有这一份实现。谁再写第二份，请让这套测试跟着它。
 */

let ws; let outside;

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-safe-ws-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-safe-out-'));
  await fs.writeFile(path.join(outside, 'secret.env'), 'KEY=leak-me');
  await fs.writeFile(path.join(outside, 'victim.docx'), 'ORIGINAL');
  await fs.writeFile(path.join(ws, '正常.docx'), 'ok');
  await fs.mkdir(path.join(ws, '子目录'));
  await fs.symlink(path.join(outside, 'secret.env'), path.join(ws, '看起来像文档.docx'));
  await fs.symlink(path.join(outside, 'victim.docx'), path.join(ws, '目标是软链.docx'));
  await fs.symlink(outside, path.join(ws, '跳板'));
});

afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('safeResolveRead', () => {
  it('工作区内的正常文件放行', async () => {
    expect(await safeResolveRead(ws, '正常.docx')).toBe(path.join(ws, '正常.docx'));
  });

  it('⭐软链指向工作区外 —— 词法看着没问题，必须拒', async () => {
    expect(await safeResolveRead(ws, '看起来像文档.docx')).toBeNull();
  });

  it('经过软链目录也要拒（父目录跳出去了）', async () => {
    expect(await safeResolveRead(ws, '跳板/secret.env')).toBeNull();
  });

  it('词法穿越照拒', async () => {
    expect(await safeResolveRead(ws, '../x.docx')).toBeNull();
    expect(await safeResolveRead(ws, '../../../../etc/passwd')).toBeNull();
    expect(await safeResolveRead(ws, '/etc/passwd')).toBeNull();
  });

  it('文件还不存在不算越界（留给调用方报 404，边界层不越权判断）', async () => {
    expect(await safeResolveRead(ws, '还没写出来.docx')).toBe(path.join(ws, '还没写出来.docx'));
  });
});

describe('safeResolveWrite', () => {
  it('新建文件、子目录里新建都放行', async () => {
    expect(await safeResolveWrite(ws, '新的.docx')).toBeTruthy();
    expect(await safeResolveWrite(ws, '子目录/a.docx')).toBeTruthy();
  });

  it('⭐目标本身是软链 —— 顺着写会覆盖工作区外的文件，必须拒', async () => {
    expect(await safeResolveWrite(ws, '目标是软链.docx')).toBeNull();
    // 拒了之后原文件一个字节都没动
    expect(await fs.readFile(path.join(outside, 'victim.docx'), 'utf8')).toBe('ORIGINAL');
  });

  it('往软链目录里写也要拒', async () => {
    expect(await safeResolveWrite(ws, '跳板/x.docx')).toBeNull();
  });

  it('词法穿越照拒', async () => {
    expect(await safeResolveWrite(ws, '../坏.docx')).toBeNull();
    expect(await safeResolveWrite(ws, '/tmp/坏.docx')).toBeNull();
  });

  it('父目录不存在时不给写（别替调用方 mkdir -p 到未知位置）', async () => {
    expect(await safeResolveWrite(ws, '没有这个目录/a.docx')).toBeNull();
  });
});
