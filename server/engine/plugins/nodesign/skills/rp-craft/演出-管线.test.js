// @vitest-environment happy-dom
/**
 * 演出.template.js 的回归网（2026-08-15）。
 *
 * ⚠️ 文件名**不许带 `.template.`** —— 起手文件是按名字里有没有 `.template.` 挑的，
 * 叫 `演出.template.test.js` 会连测试一起拷进每个用户的工作区（08-15 真跑抓到）。
 *这份管线被抄进每一个演出文件夹，改坏了是
 * **所有演出一起坏**，所以把踩过的坑逐条钉住：
 *   - pathname 是编码过的，二次编码 → 404（写这份模块当天就中了一次）
 *   - SSE 事件跨 chunk 到，逐 chunk 解析会丢字
 *   - 输入法组字中的回车不是发送
 *   - 探针模式一个网络请求都不许打
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const 源 = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '演出.template.js'), 'utf8',
);

/** 把模块跑进当前 happy-dom 环境（它是 classic script，直接 eval 就行） */
function 装载() {
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="台"></div><textarea id="输入"></textarea><button id="发送"></button>';
  delete globalThis.ND演出;
  // eslint-disable-next-line no-new-func
  new Function('window', 源)(globalThis);
  return globalThis.ND演出;
}

/** 皮肤替身：把画出来的东西记在数组里 */
function 画本() {
  const 出 = { 用户: [], 演出: [], 提示: [], 出错: [] };
  const 台 = document.getElementById('台');
  return {
    出,
    画: {
      用户: (t) => { 出.用户.push(t); const el = document.createElement('div'); 台.appendChild(el); return el; },
      演出: () => {
        const i = 出.演出.push('') - 1;
        return { 写: (全) => { 出.演出[i] = 全; }, 完成: (全) => { 出.演出[i] = 全; }, 撤: () => { 出.演出.splice(i, 1); } };
      },
      提示: (t) => 出.提示.push(t),
      出错: (t) => 出.出错.push(t),
    },
  };
}

/** 造一条 SSE 响应，分片按给的切法来 */
function SSE响应(片段) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => (i < 片段.length ? { done: false, value: enc.encode(片段[i++]) } : { done: true }) }) },
  };
}

function 设地址(pathname) {
  globalThis.happyDOM?.setURL?.(`https://x.test${pathname}`);
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('URL 自省', () => {
  it('⚠️ 中文文件夹名要逐段解码：二次编码会让服务端 404', async () => {
    设地址(`/api/projects/proj_1/artifact-file/${encodeURIComponent('雾夜集市')}/index.html`);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }));
    globalThis.fetch = fetchMock;
    const { 画 } = 画本();
    装载().挂载({ 台: document.getElementById('台'), 画 });
    await new Promise(r => setTimeout(r, 0));
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('dir=%E9%9B%BE%E5%A4%9C%E9%9B%86%E5%B8%82');   // 单层编码
    expect(url).not.toContain('%25');                                     // 不是 %25E9…
  });
});

describe('探针模式', () => {
  it('认不出地址 → 渲样例、一个网络请求都不打', async () => {
    设地址('/somewhere/else.html');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const { 出, 画 } = 画本();
    const 场 = 装载().挂载({ 台: document.getElementById('台'), 画 });
    await new Promise(r => setTimeout(r, 0));
    expect(场.探针).toBe(true);
    expect(出.演出[0]).toContain('〔样例〕');
    expect(出.提示.join()).toContain('探针');
    await 场.发送('我走近摊子');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('隐私声明', () => {
  it('页面没写 nd-privacy 就自己补一条', async () => {
    设地址('/somewhere/else.html');
    globalThis.fetch = vi.fn();
    const { 画 } = 画本();
    装载().挂载({ 台: document.getElementById('台'), 画 });
    expect(document.querySelector('meta[name="nd-privacy"]')).toBeTruthy();
  });
});

describe('SSE 解析', () => {
  beforeEach(() => 设地址('/api/projects/p1/artifact-file/戏/index.html'));

  it('⚠️ 事件跨分片到也不丢字（中转站分片很粗）', async () => {
    const 片 = ['data: {"delta":"雾夜里，"}\n\n', 'data: {"del', 'ta":"灯亮着。"}\n\n', 'data: {"done":true,"text":"雾夜里，灯亮着。"}\n\n'];
    globalThis.fetch = vi.fn(async (u) => (String(u).includes('/log')
      ? { ok: true, status: 200, json: async () => ({ records: [] }) }
      : SSE响应(片)));
    const { 出, 画 } = 画本();
    const 场 = 装载().挂载({ 台: document.getElementById('台'), 画 });
    await new Promise(r => setTimeout(r, 0));
    await 场.发送('我走近摊子');
    expect(出.演出[出.演出.length - 1]).toBe('雾夜里，灯亮着。');
  });

  it('流里的 error → 撤掉气泡、报错、把话还回输入框', async () => {
    globalThis.fetch = vi.fn(async (u) => (String(u).includes('/log')
      ? { ok: true, status: 200, json: async () => ({ records: [] }) }
      : SSE响应(['data: {"error":"上游 503"}\n\n'])));
    const { 出, 画 } = 画本();
    const 输入 = document.getElementById('输入');
    const 场 = 装载().挂载({ 台: document.getElementById('台'), 输入, 画 });
    await new Promise(r => setTimeout(r, 0));
    await 场.发送('说点什么');
    expect(出.出错.join()).toContain('503');
    expect(输入.value).toBe('说点什么');
  });

  it('HTTP 错误按服务端话术报，没给话术就按状态码兜底', async () => {
    globalThis.fetch = vi.fn(async (u) => (String(u).includes('/log')
      ? { ok: true, status: 200, json: async () => ({ records: [] }) }
      : { ok: false, status: 409, json: async () => ({}) }));
    const { 出, 画 } = 画本();
    const 场 = 装载().挂载({ 台: document.getElementById('台'), 画 });
    await new Promise(r => setTimeout(r, 0));
    await 场.发送('抢跑');
    expect(出.出错.join()).toContain('正有一轮在跑');
  });
});

describe('输入法回车', () => {
  it('组字中的回车不发送，落定后的才发', async () => {
    设地址('/api/projects/p1/artifact-file/戏/index.html');
    const post = vi.fn(async () => SSE响应(['data: {"done":true,"text":"好"}\n\n']));
    globalThis.fetch = vi.fn(async (u) => (String(u).includes('/log')
      ? { ok: true, status: 200, json: async () => ({ records: [] }) } : post(u)));
    const { 画 } = 画本();
    const 输入 = document.getElementById('输入');
    装载().挂载({ 台: document.getElementById('台'), 输入, 画 });
    await new Promise(r => setTimeout(r, 0));
    输入.value = '组字中';
    输入.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    expect(post).not.toHaveBeenCalled();
    输入.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    expect(post).toHaveBeenCalled();
  });
});
