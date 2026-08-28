/**
 * rewind-index.test.js — .nd/<sid>/rewind-index.json 读写回归（M3c C2/C9）
 *
 * 覆盖：append 追加 + read 读取、findRewindTarget 命中/未命中、
 * 空文件 / 损坏文件 → 空数组（不炸）、metaDir 不存在时 append 自建目录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { appendRewindEntry, readRewindIndex, findRewindTarget } from './rewind-index.js';

let tmpRoot;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-rewind-index-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('appendRewindEntry / readRewindIndex', () => {
  it('首次写入建文件；追加保留既有顺序', async () => {
    const metaDir = path.join(tmpRoot, 'sid-append');
    await fs.mkdir(metaDir, { recursive: true });
    await appendRewindEntry(metaDir, { entryId: 'aaaa1111', headShaBefore: 'sha1' });
    await appendRewindEntry(metaDir, { entryId: 'bbbb2222', headShaBefore: 'sha2' });
    expect(await readRewindIndex(metaDir)).toEqual([
      { entryId: 'aaaa1111', headShaBefore: 'sha1' },
      { entryId: 'bbbb2222', headShaBefore: 'sha2' },
    ]);
  });

  it('metaDir 不存在 → append 自建目录（兜底 ensureSessionWorkspace 之外的路径）', async () => {
    const metaDir = path.join(tmpRoot, 'sid-mkdir', 'nested');
    await appendRewindEntry(metaDir, { entryId: 'cccc3333', headShaBefore: 'sha3' });
    expect(await readRewindIndex(metaDir)).toHaveLength(1);
  });
});

describe('readRewindIndex 容错', () => {
  it('目录不存在 → []', async () => {
    expect(await readRewindIndex(path.join(tmpRoot, 'ghost'))).toEqual([]);
  });

  it('空文件 → []', async () => {
    const metaDir = path.join(tmpRoot, 'sid-empty');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(path.join(metaDir, 'rewind-index.json'), '');
    expect(await readRewindIndex(metaDir)).toEqual([]);
  });

  it('损坏 JSON → []（不炸）', async () => {
    const metaDir = path.join(tmpRoot, 'sid-corrupt');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(path.join(metaDir, 'rewind-index.json'), '{not json');
    expect(await readRewindIndex(metaDir)).toEqual([]);
  });

  it('损坏文件上 append → 从空数组重建（不丢新条）', async () => {
    const metaDir = path.join(tmpRoot, 'sid-corrupt-append');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(path.join(metaDir, 'rewind-index.json'), 'garbage');
    await appendRewindEntry(metaDir, { entryId: 'dddd4444', headShaBefore: 'sha4' });
    expect(await readRewindIndex(metaDir)).toEqual([{ entryId: 'dddd4444', headShaBefore: 'sha4' }]);
  });
});

describe('findRewindTarget', () => {
  it('命中 → headShaBefore；未命中 → null', async () => {
    const metaDir = path.join(tmpRoot, 'sid-find');
    await fs.mkdir(metaDir, { recursive: true });
    await appendRewindEntry(metaDir, { entryId: 'eeee5555', headShaBefore: 'shaA' });
    await appendRewindEntry(metaDir, { entryId: 'ffff6666', headShaBefore: 'shaB' });
    expect(await findRewindTarget(metaDir, 'ffff6666')).toBe('shaB');
    expect(await findRewindTarget(metaDir, 'eeee5555')).toBe('shaA');
    expect(await findRewindTarget(metaDir, '00000000')).toBeNull();
    expect(await findRewindTarget(path.join(tmpRoot, 'ghost'), 'eeee5555')).toBeNull();
  });
});
