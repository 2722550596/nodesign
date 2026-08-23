import { describe, it, expect } from 'vitest';
import { parseChalk, renderChalk, chalkFileName } from './chalk.js';

describe('chalk（板书文件）', () => {
  it('render → parse 往返，普通便利贴不被当板书', () => {
    const raw = renderChalk({ body: '# 标题\n这版为什么这么改', by: 'agent', anchor: 'deck:主稿.html', replyTo: 'notes/板书/a.md', tag: 'g1', at: '2026-08-23T00:00:00.000Z' });
    const p = parseChalk(raw);
    expect(p.chalk).toEqual({ by: 'agent', at: '2026-08-23T00:00:00.000Z', anchor: 'deck:主稿.html', replyTo: 'notes/板书/a.md', tag: 'g1' });
    expect(p.body).toBe('# 标题\n这版为什么这么改');
    expect(parseChalk('---\nsession: abcdefgh\n---\n正文').chalk).toBeNull();
    expect(parseChalk('没有头').body).toBe('没有头');
  });
  it('文件名：时间戳 + 首行短名，去掉 md 符号', () => {
    const n = chalkFileName('## 三个方向：**先做黑板**', new Date('2026-08-23T07:08:09Z'));
    expect(n).toBe('20260823-070809-三个方向-先做黑板.md');
    expect(chalkFileName('', new Date('2026-08-23T07:08:09Z'))).toBe('20260823-070809-chalk.md');
  });
});
