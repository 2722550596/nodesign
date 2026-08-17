import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { collectCard } from './export-collect.js';
import { packageBundles, extractApiContract, safeName } from './export-package.js';

/**
 * 这套盯两件事：
 *   1. **zip 布局保持工作区相对路径、零改写** —— 旧包塞进 `design/` 再回头重写
 *      `../../assets/` 前缀，深度算错一层图就全裂。不改写 = 那类 bug 不存在。
 *   2. **工程包的 README 是交付物的一半**，尤其那张 api 接口表 —— 它把「用了模拟
 *      数据」从缺陷变成资产。
 */

let ws;

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-pack-'));
  await fs.mkdir(path.join(ws, '蘑菇书店/app'), { recursive: true });
  await fs.mkdir(path.join(ws, 'assets/generated'), { recursive: true });
  await fs.mkdir(path.join(ws, 'assets/notes'), { recursive: true });
  await fs.writeFile(path.join(ws, '蘑菇书店/index.html'),
    '<img src="../assets/generated/店招.png"><img src="../assets/generated/丢了.png">');
  await fs.writeFile(path.join(ws, '蘑菇书店/app/api.js'), `
import * as impl from './mock.js';
export const listBooks  = (q) => impl.listBooks(q);        // GET  /api/books
export const createBook = (d) => impl.createBook(d);       // POST /api/books
export async function login(u, p) { return impl.login(u, p); }  // POST /api/auth/login
export const 没注路由 = () => 1;
`);
  await fs.writeFile(path.join(ws, '蘑菇书店/app/mock.js'), 'export const listBooks = () => [];');
  await fs.writeFile(path.join(ws, 'assets/generated/店招.png'), 'PNG');
  await fs.writeFile(path.join(ws, 'assets/notes/决策.md'), '# 决策\n拼贴风');
  await fs.writeFile(path.join(ws, 'assets/notes/待办.md'), '# 待办\n补文案');
});

afterAll(async () => { await fs.rm(ws, { recursive: true, force: true }); });

const entries = async (buf) => Object.keys((await JSZip.loadAsync(buf)).files).sort();

describe('extractApiContract —— 那列注释就是后端接口清单', () => {
  it('抓得到 const 箭头函数和 async function 两种写法', () => {
    const rows = extractApiContract(`
export const listBooks = (q) => impl.listBooks(q);   // GET /api/books
export async function login(u) { }                   // POST /api/auth/login
`);
    expect(rows.map(r => r.name)).toEqual(['listBooks', 'login']);
    expect(rows[0]).toMatchObject({ method: 'GET', route: '/api/books' });
    expect(rows[1]).toMatchObject({ method: 'POST', route: '/api/auth/login' });
  });

  it('没注路由的也要列出来（别假装它不存在）', () => {
    const rows = extractApiContract('export const 孤儿 = () => 1;');
    expect(rows).toEqual([{ name: '孤儿', method: null, route: null }]);
  });
});

describe('packageBundles —— zip 布局', () => {
  it('⭐保持工作区相对路径，不加 design/ 前缀、不改写引用', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    const { buffer, filename } = await packageBundles([b], { format: 'zip', projectName: '蘑菇书店' });
    const names = await entries(buffer);
    expect(names).toContain('蘑菇书店/index.html');
    expect(names).toContain('assets/generated/店招.png');   // 引用里写的就是 ../assets/…
    expect(names.some(n => n.startsWith('design/'))).toBe(false);
    expect(filename).toBe('蘑菇书店.zip');
    // 页面正文一个字都没动
    const html = await (await JSZip.loadAsync(buffer)).file('蘑菇书店/index.html').async('string');
    expect(html).toContain('../assets/generated/店招.png');
  });

  it('没有未解析引用时不放空清单（别再造一个 prompt.txt）', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    const { buffer } = await packageBundles([b], { format: 'zip', projectName: 'x' });
    expect(await entries(buffer)).not.toContain('未解析的引用.md');
  });

  it('多张卡引用同一张图时只进一次', async () => {
    const a = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    const c = await collectCard({ workspaceRoot: ws, cardId: 'assets/generated/店招.png' });
    const { buffer } = await packageBundles([a, c], { format: 'zip', projectName: 'x' });
    const names = await entries(buffer);
    expect(names.filter(n => n === 'assets/generated/店招.png')).toHaveLength(1);
  });
});

describe('packageBundles —— 工程包 README', () => {
  it('带 api 接口表，没注路由的也列', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    const { buffer, filename } = await packageBundles([b], { format: 'handoff', projectName: '蘑菇书店' });
    const md = await (await JSZip.loadAsync(buffer)).file('README.md').async('string');
    expect(md).toContain('你的后端需要提供这些接口');
    expect(md).toContain('`GET /api/books`');
    expect(md).toContain('`POST /api/auth/login`');
    expect(md).toContain('没注路由');
    expect(filename).toBe('蘑菇书店-工程包.zip');
  });

  it('认出 mock 层就说明数据是假的；没有 package.json 就说双击打开', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    const { buffer } = await packageBundles([b], { format: 'handoff', projectName: 'x' });
    const md = await (await JSZip.loadAsync(buffer)).file('README.md').async('string');
    expect(md).toContain('现在的数据是假的');
    expect(md).toContain('不需要装任何东西');
    expect(md).not.toContain('npm install');
  });

  it('缺失的引用要写进 README，不静默', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    const { buffer } = await packageBundles([b], { format: 'handoff', projectName: 'x' });
    const md = await (await JSZip.loadAsync(buffer)).file('README.md').async('string');
    expect(md).toContain('assets/generated/丢了.png');
  });

  it('有 package.json 时改说构建命令', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-pkg-'));
    await fs.mkdir(path.join(dir, '站'), { recursive: true });
    await fs.writeFile(path.join(dir, '站/package.json'), '{"scripts":{"build":"vite build"}}');
    await fs.writeFile(path.join(dir, '站/index.html'), '<p>x</p>');
    const b = await collectCard({ workspaceRoot: dir, cardId: 'site:站' });
    const { buffer } = await packageBundles([b], { format: 'handoff', projectName: 'x' });
    const md = await (await JSZip.loadAsync(buffer)).file('README.md').async('string');
    expect(md).toContain('npm install');
    expect(md).toContain('node_modules` 不在包里');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('packageBundles —— raw / md', () => {
  it('raw 直下原件，文件名就是它自己', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'assets/generated/店招.png' });
    const { filename, buffer } = await packageBundles([b], { format: 'raw' });
    expect(filename).toBe('店招.png');
    expect(buffer.toString()).toBe('PNG');
  });

  it('raw 对多个文件要拒（该走 zip）', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    await expect(packageBundles([b], { format: 'raw' })).rejects.toMatchObject({ status: 400 });
  });

  it('md 把便签合并成一份，带来源标注', async () => {
    const a = await collectCard({ workspaceRoot: ws, cardId: 'assets/notes/决策.md' });
    const c = await collectCard({ workspaceRoot: ws, cardId: 'assets/notes/待办.md' });
    const { buffer, filename } = await packageBundles([a, c], { format: 'md', projectName: '蘑菇书店' });
    const text = buffer.toString('utf8');
    expect(text).toContain('拼贴风');
    expect(text).toContain('补文案');
    expect(text).toContain('assets/notes/决策.md');
    expect(filename).toBe('蘑菇书店.md');
  });

  it('空 bundles 直接 400', async () => {
    await expect(packageBundles([], { format: 'zip' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('safeName', () => {
  it('路径分隔与父目录都要清掉', () => {
    expect(safeName('a/b')).toBe('a_b');
    expect(safeName('../坏')).toBe('._坏');
    expect(safeName('')).toBe('导出');
  });
});
