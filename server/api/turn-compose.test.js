/**
 * turn-compose.test.js — composeUserMessage 的**基数**回归（2026-08-21 加）。
 *
 * 背景：f6380f4 那笔提交本意只是删一段过时注释，实际把「用户文字 + 附件」整段
 * 又贴了一遍（同一个 chat 被 blocks.push 两次）。结果每条用户消息进 SDK 都是两份
 * 相同的 text block，转录里 `[{text:"你好！"},{text:"你好！"}]`，附件图连 base64
 * 都双份。整份文件语法没错、测试也没有 —— 靠人眼看 diff 是拦不住的。
 *
 * 所以这里断言的不是"内容对不对"而是"每样东西只出现一次"：
 * 复制粘贴多一份立刻红。
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { composeUserMessage } from './turn-compose.js';

const EMPTY_PENDING = { count: 0, summary: '' };
const texts = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text);

describe('composeUserMessage 基数', () => {
  it('纯文字：正好一个 text block，就是用户那句话', async () => {
    const { blocks } = await composeUserMessage('你好！', [], EMPTY_PENDING, os.tmpdir());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: '你好！' });
  });

  it('带 pendingSummary：system 块 + 用户那句话各一份', async () => {
    const { blocks } = await composeUserMessage(
      '继续', [], { count: 2, summary: '用户改了 2 处' }, os.tmpdir(),
    );
    expect(texts(blocks).filter((t) => t === '继续')).toHaveLength(1);
    expect(texts(blocks).filter((t) => t.startsWith('<system>'))).toHaveLength(1);
  });

  it('只发附件没文字：占位句只出现一次，素材清单也只有一份', async () => {
    const { blocks } = await composeUserMessage(
      '', [{ path: 'assets/nope.zip', name: 'nope.zip' }], EMPTY_PENDING, os.tmpdir(),
    );
    expect(texts(blocks).filter((t) => t.includes('用户只发了附件'))).toHaveLength(1);
    expect(texts(blocks).filter((t) => t.includes('可用素材'))).toHaveLength(1);
  });

  it('displayText 不重复用户那句话', async () => {
    const { displayText } = await composeUserMessage('唯一一句', [], EMPTY_PENDING, os.tmpdir());
    expect(displayText.split('唯一一句')).toHaveLength(2); // 出现 1 次
  });
});
