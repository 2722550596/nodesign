#!/usr/bin/env node
/**
 * server/scripts/notice.mjs — 发 / 看 / 撤站内公告（直连 SQLite）
 *
 * 走脚本不走 HTTP 的理由跟 invite.mjs 一样：服务没起来的时候也得能用。
 * 「重启前预告」这件事恰恰发生在服务即将不可用的时刻。
 *
 *   node server/scripts/notice.mjs "刚更新了用量统计，如果页面有异常刷新一下"
 *   node server/scripts/notice.mjs --level warn --hours 1 "五分钟后重启，正在跑的会中断"
 *   node server/scripts/notice.mjs --list
 *   node server/scripts/notice.mjs --retire            # 全部下架
 *   node server/scripts/notice.mjs --retire nt_xxx     # 撤某一条
 *
 * level: info（默认，蓝）/ warn（黄）/ alert（红）
 * hours: 多少小时后自动消失；不给就挂到手动撤
 */

import { createNotice, listNotices, retireNotice, retireAllNotices, getActiveNotice } from '../lib/notice-store.js';

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
}

const wantList = argv.includes('--list');
if (wantList) argv.splice(argv.indexOf('--list'), 1);
const retire = flag('retire');
const level = flag('level') || 'info';
const hours = flag('hours');

if (wantList) {
  const rows = listNotices();
  if (!rows.length) {
    console.log('(还没发过公告)');
  } else {
    const active = getActiveNotice();
    for (const n of rows) {
      const mark = active && n.id === active.id ? '● 生效中' : (n.active ? '○ 已过期' : '  已下架');
      console.log(`${mark}  ${n.id}  [${n.level}]  ${n.createdAt}${n.expiresAt ? ` → ${n.expiresAt}` : ''}`);
      console.log(`          ${n.body}`);
    }
  }
  process.exit(0);
}

if (retire) {
  if (retire === true) {
    console.log(`已下架 ${retireAllNotices()} 条`);
  } else if (retireNotice(retire)) {
    console.log(`已下架 ${retire}`);
  } else {
    console.error(`找不到 ${retire}`);
    process.exit(1);
  }
  process.exit(0);
}

const body = argv.join(' ').trim();
if (!body) {
  console.error('用法：node server/scripts/notice.mjs [--level info|warn|alert] [--hours N] "公告正文"');
  console.error('      node server/scripts/notice.mjs --list');
  console.error('      node server/scripts/notice.mjs --retire [id]');
  process.exit(1);
}

try {
  const n = createNotice({ body, level, expiresInHours: hours });
  console.log(`已发布 ${n.id}  [${n.level}]${n.expiresAt ? `  到期 ${n.expiresAt}` : '  不自动过期'}`);
  console.log(`  ${n.body}`);
  console.log('\n用户端最迟 60 秒内看到（横幅轮询周期）；切窗口回来会立刻补拉。');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
