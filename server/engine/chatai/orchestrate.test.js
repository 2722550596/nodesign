// 编排编译的金样例（离线，不碰网络）。夹具现场搭在系统临时目录。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadOrchestration, compileContext, estTokens, CONFIG_FILE } from './orchestrate.js';
import { readLog, appendTurn, writeSummary, readSummary } from './chat-log.js';
import { needsSummary } from './summarize.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function scaffold(yaml, files = {}) {
  await fs.writeFile(path.join(dir, CONFIG_FILE), yaml, 'utf8');
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, 'utf8');
  }
}

/** 直接写 n 轮对话进记录（seq 连续，成对） */
async function seedTurns(n, textOf = i => `第${i}轮`) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push({ seq: i * 2 - 1, role: 'user', text: `${textOf(i)}问`, at: 't' });
    lines.push({ seq: i * 2, role: 'assistant', text: `${textOf(i)}答`, at: 't' });
  }
  await fs.writeFile(path.join(dir, '对话.jsonl'), lines.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const MIN = `系统层:\n  - 名字: 底\n    内容: 你是说书人\n`;

describe('配置解析', () => {
  it('没有编排.yaml → ORCH_NO_CONFIG', async () => {
    await expect(loadOrchestration(dir)).rejects.toMatchObject({ code: 'ORCH_NO_CONFIG' });
  });

  it('最小配置吃到全部默认值', async () => {
    await scaffold(MIN);
    const cfg = await loadOrchestration(dir);
    expect(cfg.最大输出).toBe(2000);
    expect(cfg.上下文预算).toBe(60000);
    expect(cfg.历史).toEqual({ 文件: '对话.jsonl', 保留轮数: 40 });
    expect(cfg.摘要).toMatchObject({ 启用: true, 保留轮数: 12, 触发轮数: 24, 长度: 500 });
    expect(cfg.模型).toBeNull();
  });

  it('旋钮覆盖：模型 / 最大输出 / 上下文预算 / 摘要档位', async () => {
    await scaffold(`模型: claude-sonnet-4-6\n最大输出: 999\n上下文预算: 1234\n摘要:\n  启用: false\n  保留轮数: 3\n  触发轮数: 7\n${MIN}`);
    const cfg = await loadOrchestration(dir);
    expect(cfg.模型).toBe('claude-sonnet-4-6');
    expect(cfg.最大输出).toBe(999);
    expect(cfg.上下文预算).toBe(1234);
    expect(cfg.摘要).toMatchObject({ 启用: false, 保留轮数: 3, 触发轮数: 7 });
  });

  it('条目同时给文件和内容 → 拒', async () => {
    await scaffold(`系统层:\n  - 名字: 双\n    文件: a.md\n    内容: b\n`);
    await expect(loadOrchestration(dir)).rejects.toThrow('二选一');
  });

  it('条目两者都不给 → 拒', async () => {
    await scaffold(`系统层:\n  - 名字: 空\n`);
    await expect(loadOrchestration(dir)).rejects.toThrow('既没有');
  });

  it('系统层带触发 → 拒（触发只许住尾部）', async () => {
    await scaffold(`系统层:\n  - 名字: 违规\n    内容: x\n    触发: [剑]\n`);
    await expect(loadOrchestration(dir)).rejects.toThrow('只能住尾部');
  });

  it('摘要触发轮数 ≤ 保留轮数 → 拒', async () => {
    await scaffold(`摘要:\n  保留轮数: 10\n  触发轮数: 10\n${MIN}`);
    await expect(loadOrchestration(dir)).rejects.toThrow('必须大于');
  });
});

describe('编译：系统层与尾部', () => {
  it('文件引用逃逸文件夹 → 拒', async () => {
    await scaffold(`系统层:\n  - 名字: 逃\n    文件: ../外面.md\n`);
    await expect(compileContext({ dir, userInput: '你好' })).rejects.toThrow('跑出了演出文件夹');
  });

  it('引用的文件不存在 → 报条目名字', async () => {
    await scaffold(`系统层:\n  - 名字: 世界观\n    文件: 设定/无.md\n`);
    await expect(compileContext({ dir, userInput: '你好' })).rejects.toThrow('世界观');
  });

  it('系统层按配置顺序拼接，停用条目跳过', async () => {
    await scaffold(
      `系统层:\n  - 名字: 甲\n    文件: 设定/甲.md\n  - 名字: 停\n    内容: 不该出现\n    停用: true\n  - 名字: 乙\n    内容: 乙文\n`,
      { '设定/甲.md': '甲文' },
    );
    const c = await compileContext({ dir, userInput: '你好' });
    expect(c.system).toBe('甲文\n\n乙文');
    const 停 = c.meta.条目.find(e => e.名字 === '停');
    expect(停).toMatchObject({ 进入: false, 因: '停用' });
  });

  it('尾部资料块按顺序拼进当轮 user 消息，输入在最后', async () => {
    await scaffold(`${MIN}尾部:\n  - 名字: 场景\n    内容: 雨夜\n  - 名字: 提示\n    内容: 短句\n`);
    const c = await compileContext({ dir, userInput: '推门' });
    const last = c.messages[c.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe('<资料 名="场景">\n雨夜\n</资料>\n\n<资料 名="提示">\n短句\n</资料>\n\n推门');
  });

  it('触发：当轮输入命中→进；最近历史命中→进；只在久远历史命中→不进', async () => {
    await scaffold(`${MIN}尾部:\n  - 名字: 战\n    内容: 战斗提示\n    触发: [拔剑]\n`);
    // 当轮输入命中
    let c = await compileContext({ dir, userInput: '我拔剑' });
    expect(c.messages.at(-1).content).toContain('战斗提示');
    // 最近历史命中（窗口=最近 8 条记录）
    await seedTurns(2, i => (i === 2 ? '拔剑' : '走路'));
    c = await compileContext({ dir, userInput: '然后呢' });
    expect(c.messages.at(-1).content).toContain('战斗提示');
    expect(c.meta.条目.find(e => e.名字 === '战')).toMatchObject({ 进入: true, 因: '触发命中' });
    // 只在久远历史命中：塞 6 轮无关对话把它挤出窗口
    await seedTurns(6, i => (i === 1 ? '拔剑' : '喝茶'));
    c = await compileContext({ dir, userInput: '然后呢' });
    expect(c.messages.at(-1).content).not.toContain('战斗提示');
    expect(c.meta.条目.find(e => e.名字 === '战')).toMatchObject({ 进入: false, 因: '未触发' });
  });
});

describe('编译：历史、预算、摘要', () => {
  it('保留轮数截断，首条必是 user', async () => {
    await scaffold(`历史:\n  保留轮数: 3\n${MIN}`);
    await seedTurns(5);
    const c = await compileContext({ dir, userInput: '继续' });
    expect(c.messages).toHaveLength(3 * 2 + 1);
    expect(c.messages[0]).toEqual({ role: 'user', content: '第3轮问' });
    expect(c.meta.历史).toMatchObject({ 总轮数: 5, 进入轮数: 3 });
  });

  it('预算挤压从最旧丢整轮，帐记在 meta', async () => {
    // 每轮约 40 token；预算刚够 2 轮 + 固定部分
    await scaffold(`上下文预算: 200\n${MIN}`);
    await seedTurns(5, i => `第${i}轮${'字'.repeat(16)}`);
    const c = await compileContext({ dir, userInput: '继续' });
    expect(c.messages[0].role).toBe('user');
    expect(c.meta.历史.预算丢弃轮数).toBeGreaterThan(0);
    expect(c.meta.历史.进入轮数 + c.meta.历史.预算丢弃轮数).toBe(5);
    expect(c.meta.估算.合计).toBeLessThanOrEqual(200);
  });

  it('摘要边界之前的轮次不进；前情提要注入第一条 user 消息', async () => {
    await scaffold(MIN);
    await seedTurns(5);
    await writeSummary(dir, { 至: 6, 内容: '前三轮里他们结了仇' });   // 折叠掉 1-3 轮
    const c = await compileContext({ dir, userInput: '继续' });
    expect(c.messages).toHaveLength(2 * 2 + 1);                        // 只剩 4、5 轮
    expect(c.messages[0].content).toBe('<前情提要>\n前三轮里他们结了仇\n</前情提要>\n\n第4轮问');
    expect(c.messages[1].content).toBe('第4轮答');
    expect(c.meta.历史.摘要已折叠).toBe(true);
  });

  it('历史被全部折叠时，前情提要进当轮输入', async () => {
    await scaffold(MIN);
    await seedTurns(3);
    await writeSummary(dir, { 至: 6, 内容: '一切都结束了' });
    const c = await compileContext({ dir, userInput: '尾声' });
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].content).toBe('<前情提要>\n一切都结束了\n</前情提要>\n\n尾声');
  });
});

describe('记录层', () => {
  it('appendTurn 成对追加、seq 连续、读回一致', async () => {
    await scaffold(MIN);
    const cfg = await loadOrchestration(dir);
    await appendTurn(dir, cfg, '甲', '乙');
    await appendTurn(dir, cfg, '丙', '丁');
    const log = await readLog(dir, cfg);
    expect(log.map(r => [r.seq, r.role, r.text])).toEqual([
      [1, 'user', '甲'], [2, 'assistant', '乙'], [3, 'user', '丙'], [4, 'assistant', '丁'],
    ]);
  });

  it('坏行跳过不炸', async () => {
    await scaffold(MIN);
    await fs.writeFile(path.join(dir, '对话.jsonl'),
      '{"seq":1,"role":"user","text":"好","at":"t"}\n{残}\n{"seq":2,"role":"assistant","text":"行","at":"t"}\n');
    const log = await readLog(dir, await loadOrchestration(dir));
    expect(log).toHaveLength(2);
  });

  it('摘要原子写读回', async () => {
    await writeSummary(dir, { 至: 8, 内容: '提要' });
    expect(await readSummary(dir)).toMatchObject({ 至: 8, 内容: '提要' });
  });
});

describe('摘要触发判定（纯函数）', () => {
  const cfg = { 摘要: { 启用: true, 保留轮数: 2, 触发轮数: 4 } };
  const mk = n => {
    const rs = [];
    for (let i = 1; i <= n; i++) {
      rs.push({ seq: i * 2 - 1, role: 'user', text: `${i}问` }, { seq: i * 2, role: 'assistant', text: `${i}答` });
    }
    return rs;
  };

  it('没到触发线 → null；关掉 → null', () => {
    expect(needsSummary(mk(3), null, cfg)).toBeNull();
    expect(needsSummary(mk(9), null, { 摘要: { ...cfg.摘要, 启用: false } })).toBeNull();
  });

  it('到线折叠：保留最近 保留轮数，新边界落在保留区之前', () => {
    const need = needsSummary(mk(4), null, cfg);
    expect(need.至).toBe(4);                        // 折 1-2 轮，保留 3-4 轮
    expect(need.fold.map(r => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it('已有摘要时只数边界后的活轮次', () => {
    expect(needsSummary(mk(5), { 至: 4, 内容: 'x' }, cfg)).toBeNull();   // 活 3 轮 < 4
    const need = needsSummary(mk(6), { 至: 4, 内容: 'x' }, cfg);          // 活 4 轮 → 折
    expect(need.至).toBe(8);
    expect(need.fold.map(r => r.seq)).toEqual([5, 6, 7, 8]);
  });
});

describe('token 估算', () => {
  it('中文≈字数，英文≈四字符一枚', () => {
    expect(estTokens('十个汉字十个汉字十字')).toBe(10);
    expect(estTokens('abcdefgh')).toBe(2);
    expect(estTokens('')).toBe(0);
  });
});
