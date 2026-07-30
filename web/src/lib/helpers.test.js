import { describe, it, expect } from 'vitest';
import { timeAgo, formatDate } from './helpers.js';

describe('timeAgo — SQLite 无时区时间戳按 UTC 解', () => {
  const sqliteStamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

  it('6 小时前的 SQLite 时间戳显示 6 小时前（不受本地时区影响）', () => {
    expect(timeAgo(sqliteStamp(6 * 3600_000))).toBe('6 小时前');
  });
  it('刚落库的显示刚刚', () => {
    expect(timeAgo(sqliteStamp(1000))).toBe('刚刚');
  });
  it('30 分钟前', () => {
    expect(timeAgo(sqliteStamp(30 * 60_000))).toBe('30 分钟前');
  });
  it('带 Z 的 ISO 串照常', () => {
    expect(timeAgo(new Date(Date.now() - 2 * 3600_000).toISOString())).toBe('2 小时前');
  });
  it('空值 / 垃圾值返空串', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo('not a date')).toBe('');
    expect(formatDate('not a date')).toBe('');
  });
  it('formatDate 也按 UTC 解无时区串', () => {
    expect(formatDate('2026-07-30 02:08:17')).toMatch(/^2026-07-3[01]$/);
  });
});
