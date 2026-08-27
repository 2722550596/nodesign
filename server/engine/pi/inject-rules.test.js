/**
 * inject-rules.js 回归：懒注入映射 / write kind 判据 / 失败建议分流 / rate-limit 判别。
 * 语义源对照：agent/hooks/pre-injectors.js（触发键）、agent/hooks/failure.js（建议分流）、
 * docs/engine-pi-rp-migration.md 附录 C（rate-limit 启发式）。
 */
import { describe, it, expect } from 'vitest';
import {
  LAZY_INJECTIONS, WRITE_KIND_FILES, READ_PAGE_REMINDER,
  injectionFor, kindOfWritePath, failureAdvice, isRateLimitSignal,
} from './inject-rules.js';

describe('injectionFor 懒注入映射', () => {
  it('注册表 7 个 md 文件名与 prompts/tools/ 实际一致', () => {
    const files = new Set([...LAZY_INJECTIONS.values()].map(v => v.file));
    files.add(WRITE_KIND_FILES.deck.file);
    files.add(WRITE_KIND_FILES.site.file);
    expect([...files].sort()).toEqual([
      'direct-edit-protocol.md',
      'generate-image-cookbook.md',
      'hybrid-reference.md',
      'paint-still-cookbook.md',
      'roll-film-cookbook.md',
      'site-reference.md',
      'tweaks-syntax.md',
    ]);
  });

  it('get_pending_changes → direct-edit-protocol.md', () => {
    expect(injectionFor('get_pending_changes')).toMatchObject({ key: 'direct-edit-protocol', file: 'direct-edit-protocol.md' });
  });

  it('generate_image → cookbook + ReadPageReminder 内联前缀', () => {
    const hit = injectionFor('generate_image');
    expect(hit).toMatchObject({ key: 'generate-image-cookbook', file: 'generate-image-cookbook.md' });
    expect(hit.inlinePrefix).toBe(READ_PAGE_REMINDER);
    // 内联文本逐字要点（pre-injectors.js:199-204 照搬）
    expect(hit.inlinePrefix).toContain('[generate_image 目标页提醒]');
    expect(hit.inlinePrefix).toContain('建议先 Read 一下');
    expect(hit.inlinePrefix).toContain('本提醒每 session 只触发一次');
  });

  it('paint_still 与 lookup_tags 共享同一 key（先查后画，合计只注一次）', () => {
    const a = injectionFor('paint_still');
    const b = injectionFor('lookup_tags');
    expect(a).toMatchObject({ key: 'paint-still-cookbook', file: 'paint-still-cookbook.md' });
    expect(b.key).toBe(a.key);
    expect(b.file).toBe(a.file);
  });

  it('roll_film → roll-film-cookbook.md；expose_tweaks → tweaks-syntax.md', () => {
    expect(injectionFor('roll_film')).toMatchObject({ key: 'roll-film-cookbook', file: 'roll-film-cookbook.md' });
    expect(injectionFor('expose_tweaks')).toMatchObject({ key: 'tweaks-syntax', file: 'tweaks-syntax.md' });
  });

  it('未注册工具返 null（含 pi 内建工具与空值）', () => {
    for (const t of ['read', 'edit', 'grep', 'find', 'ls', 'screenshot_canvas', 'pin_to_board', '', null, undefined]) {
      expect(injectionFor(t), String(t)).toBeNull();
    }
  });
});

describe('write 的 kind 判据（kindOfWritePath + injectionFor）', () => {
  it('根上散装 .html → deck（canvas.html 与任意名）', () => {
    expect(injectionFor('write', { path: 'canvas.html' })).toMatchObject({ key: 'hybrid-reference', file: 'hybrid-reference.md' });
    expect(injectionFor('write', { path: '鉴赏页.html' })).toMatchObject({ key: 'hybrid-reference' });
    expect(kindOfWritePath('a/b/主稿.html')).toBe('deck');
  });

  it('index.html（任意层）→ site：根站 / 构建目录 / pretty-URL 子页', () => {
    expect(injectionFor('write', { path: 'index.html' })).toMatchObject({ key: 'site-reference', file: 'site-reference.md' });
    expect(injectionFor('write', { path: 'dist/index.html' })).toMatchObject({ key: 'site-reference' });
    expect(injectionFor('write', { path: 'my-site/about/index.html' })).toMatchObject({ key: 'site-reference' });
  });

  it('绝对路径与 file_path 兼容别名同样判定', () => {
    expect(injectionFor('write', { path: '/ws/proj/canvas.html' })).toMatchObject({ key: 'hybrid-reference' });
    expect(injectionFor('write', { file_path: 'site/index.html' })).toMatchObject({ key: 'site-reference' });
  });

  it('非 html 入口不注入（word .docx / md / 无扩展名）', () => {
    expect(injectionFor('write', { path: '文档.docx' })).toBeNull();
    expect(injectionFor('write', { path: 'notes/todo.md' })).toBeNull();
    expect(injectionFor('write', { path: 'Makefile' })).toBeNull();
    expect(injectionFor('write', {})).toBeNull();
  });

  it('.htm 老写法按 html 处理；大小写不敏感', () => {
    expect(kindOfWritePath('old.htm')).toBe('deck');
    expect(kindOfWritePath('Index.HTML')).toBe('site');
  });
});

describe('failureAdvice 失败建议分流', () => {
  const run = (toolName, errorText, extra = {}) =>
    failureAdvice({ toolName, isError: true, errorText, ...extra });

  it('screenshot_canvas 三路常见原因', () => {
    const a = run('screenshot_canvas', 'spawn playwright ENOENT');
    expect(a).toContain('截图失败');
    expect(a).toContain('fullPage:false');
  });

  it('bash 分支保留（pi 未开 bash，兜底语义）', () => {
    const a = run('bash', 'exit 126');
    expect(a).toContain('Bash 命令失败');
    expect(a).toContain('检查 stderr');
  });

  it('*_batch 勿整批重跑', () => {
    const a = run('browser_batch', 'step 3 failed: timeout');
    expect(a).toContain('**不要整批重跑**');
    expect(a).toContain('只从失败那一步起继续');
  });

  it('write / edit 三路检查', () => {
    expect(run('write', 'EACCES')).toContain('write 失败。检查');
    expect(run('edit', 'old_string not found')).toContain('old_string 是否完整匹配');
  });

  it('read 建议', () => {
    const a = run('read', 'ENOENT: no such file');
    expect(a).toContain('read 失败');
    expect(a).toContain('确认路径相对 workspace');
  });

  it('generate_image 六路错因分流', () => {
    expect(run('generate_image', 'HTTP 429 rate limit')).toContain('网关限流（429）');
    expect(run('generate_image', 'HTTP 502 gateway timeout')).toContain('网关 / 上游临时故障');
    expect(run('generate_image', 'safety policy blocked')).toContain('模型拒生');
    expect(run('generate_image', 'HTTP 400 bad request')).toContain('Prompt 或参数问题（400）');
    expect(run('generate_image', 'ENOENT reference not found')).toContain('referenceImages 路径错');
    expect(run('generate_image', 'quota budget exceeded')).toContain('配额 / 预算限制');
    // 未知错因兜底：默认重试不是放弃
    expect(run('generate_image', 'weird unknown')).toContain('错因未知');
    expect(run('generate_image', 'weird unknown')).toContain('**默认应重试 1-2 次**');
  });

  it('通用兜底分支', () => {
    const a = run('roll_film', 'upstream exploded');
    expect(a).toContain('roll_film 失败：upstream exploded');
    expect(a).toContain('先重试 1 次');
  });

  it('⭐ seccomp/unshare 分支确已删除（bwrap 沙盒随 M2 移除）', () => {
    const a = run('bash', 'apply-seccomp: unshare(CLONE_NEWUSER) EINVAL');
    expect(a).not.toContain('seccomp');
    expect(a).not.toContain('unshare');
    expect(a).not.toContain('原样再跑一次');
  });

  it('isError 为假 / is_interrupt 为真 → 不注入', () => {
    expect(failureAdvice({ toolName: 'bash', isError: false, errorText: 'x' })).toBeNull();
    expect(failureAdvice({ toolName: 'bash', isError: true, errorText: 'x', isInterrupt: true })).toBeNull();
  });

  it('错误文本截断 500 字（对齐源行为）', () => {
    const a = run('roll_film', 'E'.repeat(800));
    expect(a).toContain('E'.repeat(500));
    expect(a).not.toContain('E'.repeat(501));
  });
});

describe('isRateLimitSignal rate-limit 判别', () => {
  it('status 429 → 限流', () => {
    expect(isRateLimitSignal({ status: 429, headers: {} })).toMatchObject({ isRateLimit: true });
    expect(isRateLimitSignal({ status: 429 }).detail).toContain('429');
  });

  it('retry-after 头存在 → 限流（大小写不敏感）', () => {
    expect(isRateLimitSignal({ status: 200, headers: { 'Retry-After': '30' } })).toMatchObject({ isRateLimit: true });
    expect(isRateLimitSignal({ status: 503, headers: { 'retry-after': '5' } }).detail).toContain('5');
  });

  it('errorMessage 文本三路 → 限流', () => {
    expect(isRateLimitSignal({ errorMessage: 'rate limit exceeded' })).toMatchObject({ isRateLimit: true });
    expect(isRateLimitSignal({ errorMessage: 'Too Many Requests' })).toMatchObject({ isRateLimit: true });
    expect(isRateLimitSignal({ errorMessage: 'upstream said 429' })).toMatchObject({ isRateLimit: true });
  });

  it('正常响应 / 5xx 过载 / 空 retry-after → null', () => {
    expect(isRateLimitSignal({ status: 200, headers: { 'content-type': 'application/json' } })).toBeNull();
    expect(isRateLimitSignal({ status: 529, headers: {}, errorMessage: 'overloaded_error: Overloaded' })).toBeNull();
    expect(isRateLimitSignal({ status: 500, headers: { 'retry-after': '   ' } })).toBeNull();
    expect(isRateLimitSignal({})).toBeNull();
  });
});
