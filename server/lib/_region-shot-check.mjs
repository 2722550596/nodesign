/**
 * 圈选评论的真跑校验：chromium 真截一张、落盘、再被 get_pending_changes 取回来。
 *
 * 为什么必须真跑：这条链上每一环都是"看起来对但可能不对"的类型 ——
 * 滚动会被文档末尾夹住、裁剪框可能越界、webp 编码可能失败、工具那边路径
 * 拼错了也只会安静地少一张图。纯函数测不到任何一环。
 *
 * 跑法：node server/lib/_region-shot-check.mjs
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-region-'));
process.env.PROJECTS_DATA_DIR = process.env.PROJECTS_DATA_DIR || TMP;

const { renderRegionShot, saveRegionShot, SHOT_DIR } = await import('./region-shot.js');
const { makeGetPendingChangesTool } = await import('../engine/mcp/tools/get-pending-changes.js');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

// 一张有明确色块的长页面：能按坐标验证截对了地方
const PAGE = path.join(TMP, 'page.html');
await fs.writeFile(PAGE, `<!doctype html><meta charset="utf-8"><title>t</title>
<body style="margin:0">
  <div style="height:400px;background:#ffffff"></div>
  <div id="red" style="position:absolute;left:100px;top:600px;width:200px;height:120px;background:#ff0000"></div>
  <div style="height:1200px"></div>
</body>`, 'utf8');

const viewport = { width: 900, height: 600 };

// ── 1. 截的是圈住的那块，不是页首 ──────────────────────────────────────
{
  const { buffer, clip } = await renderRegionShot({
    absPath: PAGE, region: { x: 100, y: 600, w: 200, h: 120 }, viewport,
  });
  ok('出图有内容', buffer.length > 100, `${buffer.length} 字节`);

  const { default: sharp } = await import('sharp');
  const meta = await sharp(buffer).metadata();
  ok('出图是 webp', meta.format === 'webp', meta.format);
  // 圈 200×120 + 两边各 32 余量 = 264×184
  ok('出图尺寸 = 圈 + 余量', meta.width === 264 && meta.height === 184, `${meta.width}×${meta.height}`);

  // 中心点必须是红的 —— 截错地方（比如没滚动、按页首裁）这里就是白的
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (meta.width * Math.floor(meta.height / 2) + Math.floor(meta.width / 2)) * 3;
  ok('圈中心确实是目标色块', data[px] > 200 && data[px + 1] < 60 && data[px + 2] < 60,
    `rgb(${data[px]},${data[px + 1]},${data[px + 2]})`);
  ok('裁剪框在视口内', clip.x >= 0 && clip.y >= 0
    && clip.x + clip.width <= viewport.width && clip.y + clip.height <= viewport.height,
    JSON.stringify(clip));
}

// ── 2. 页尾附近：滚动被夹住时裁剪框要跟着修正 ──────────────────────────
{
  const { clip } = await renderRegionShot({
    absPath: PAGE, region: { x: 0, y: 1500, w: 300, h: 100 }, viewport,
  });
  // 文档高 1600，视口 600 → 最大 scrollTop 1000。想滚到 1468 会被夹到 1000，
  // 于是圈在视口里的 y 是 1468-1000=468，不是 0。夹不住的话截出来的是错的一块。
  ok('页尾的圈按真实滚动量修正', clip.y > 300, `clip.y=${clip.y}`);
  ok('修正后仍不越界', clip.y + clip.height <= viewport.height, JSON.stringify(clip));
}

// ── 3. 落盘 + 被 get_pending_changes 取回来 ────────────────────────────
{
  const sessionRoot = path.join(TMP, 'session');
  await fs.mkdir(sessionRoot, { recursive: true });
  const { buffer } = await renderRegionShot({
    absPath: PAGE, region: { x: 100, y: 600, w: 200, h: 120 }, viewport,
  });
  const rel = await saveRegionShot(sessionRoot, 'rgn_test', buffer);
  ok('落盘路径在 region-shots/ 下', rel === `${SHOT_DIR}/rgn_test.webp`, rel);
  ok('文件真的写出来了', (await fs.stat(path.join(sessionRoot, rel))).size === buffer.length);

  await fs.writeFile(path.join(sessionRoot, 'pending-changes.json'), JSON.stringify({
    items: [{
      id: 'rgn_test', kind: 'region-comment', path: 'tasks/t/index.html',
      text: '这块太挤', region: { x: 100, y: 600, w: 200, h: 120 }, viewport,
      elements: [{ tag: 'div', text: '', anchor: { path: 'body>div' } }],
      shot: rel, ts: new Date().toISOString(),
    }],
  }), 'utf8');

  const t = makeGetPendingChangesTool({ workspaceRoot: sessionRoot });
  const res = await t.handler({});
  const images = res.content.filter(c => c.type === 'image');
  ok('工具把圈选截图挂进结果里', images.length === 1, `${images.length} 张`);
  ok('图是 webp', images[0]?.mimeType === 'image/webp', images[0]?.mimeType);
  ok('图数据是那张图', images[0]?.data === buffer.toString('base64'));
  ok('文字块里带得出圈选内容', res.content[0].text.includes('这块太挤'));

  // 图丢了不能把整个工具带崩 —— 元素清单本身就够干活
  await fs.rm(path.join(sessionRoot, rel));
  const res2 = await t.handler({});
  ok('截图丢了工具照样返回', !res2.isError);
  ok('截图丢了会说一声', res2.content.some(c => c.type === 'text' && c.text.includes('读不到')));
}

await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});

if (fails.length) {
  console.error(`\n✗ ${fails.length} 条失败 / ${pass + fails.length} 条：`);
  fails.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log(`✓ 圈选截图 ${pass}/${pass} 条全过`);
