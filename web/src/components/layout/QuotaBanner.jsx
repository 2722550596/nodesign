/**
 * QuotaBanner — 顶部横幅（额度预警 + 站内公告，2026-07-31）
 *
 * 两类消息共用一个壳，因为它们抢的是同一块像素，分成两个组件迟早会同时出现然后
 * 互相盖住。数据也共用一次请求：/api/me/usage 顺带返回当前公告。
 *
 * **额度档**：75 / 90 / 100 三档，黄 / 红 / 红，每档每天只弹一次（记 localStorage，
 * 键带 +08 日期，跟服务端日界同一口径）。75/90 档 12 秒自动收，100 档常驻到手关
 * —— 那是硬失败状态，收掉等于没提醒。额度口径是金额但只展示百分比（见 api/me.js）。
 *
 * **公告**：admin 发的话（重启预告 / 更新说明 / 出了什么事）。**不自动收**，
 * 挂到用户自己关掉，关过的记 localStorage 不再弹。
 * 没做跑马灯：滚动的字读起来更慢不是更快，而且自动滚动对前庭敏感的人是硬伤
 * （WCAG 要求可暂停）。"怕人看不到"的解法是不自动消失 + 全站都在，不是让它动。
 * 入场给一次下滑动画，一次性的，不循环。
 *
 * 轮询 60s + 窗口重获焦点补一次 + 监听 nd-usage-refresh（turn 结束时派发）。
 * admin 不限额（capped=false），额度档对 admin 天然静默；公告 admin 照看
 * —— 自己发的话自己也该看见长什么样。
 */

import { useEffect, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { FONT_MONO } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';

const TIERS = [100, 90, 75];
const AUTO_HIDE_MS = 12_000;

const LEVEL_BG = {
  info: 'rgba(42, 88, 133, 0.96)',
  warn: 'rgba(184, 92, 26, 0.96)',
  alert: 'rgba(184, 58, 42, 0.96)',
};

/** 服务端日界是 +08:00，横幅"每天一次"的日期必须用同一时区算 */
function dayKeyShanghai() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const quotaSeenKey = (tier) => `nd-quota-banner:${dayKeyShanghai()}:${tier}`;
// 公告的已读不带日期：一条公告关掉就是永久关掉，跨天不该复活
const noticeSeenKey = (id) => `nd-notice-seen:${id}`;

function tierFor(pct) {
  for (const t of TIERS) if (pct >= t) return t;
  return null;
}

function seen(key) {
  try { return !!localStorage.getItem(key); } catch { return false; }
}
function markSeen(key) {
  try { localStorage.setItem(key, '1'); } catch { /* 不可用就每次都弹，宁多勿漏 */ }
}

export default function QuotaBanner() {
  const authUser = useGlobalStore((s) => s.authUser);
  // banners: [{ key, kind: 'quota'|'notice', bg, text, sticky }]
  const [banners, setBanners] = useState([]);

  const push = useCallback((b) => {
    setBanners((cur) => (cur.some((x) => x.key === b.key) ? cur : [...cur, b]));
  }, []);

  const pull = useCallback(() => {
    fetch('/api/me/usage')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (!u) return;

        // 公告：一次只有一条生效，关过就不再弹
        if (u.notice?.id && !seen(noticeSeenKey(u.notice.id))) {
          push({
            key: `notice:${u.notice.id}`,
            kind: 'notice',
            seenKey: noticeSeenKey(u.notice.id),
            bg: LEVEL_BG[u.notice.level] || LEVEL_BG.info,
            text: u.notice.body,
            sticky: true,
          });
        }

        // 额度档。试用号（kind=lifetime）不许诺"明天刷新"——没有那回事
        if (!u.capped) return;
        const trial = u.kind === 'lifetime';
        const tier = tierFor(u.pct || 0);
        if (tier == null || seen(quotaSeenKey(tier))) return;
        markSeen(quotaSeenKey(tier));
        push({
          key: `quota:${tier}`,
          kind: 'quota',
          bg: tier >= 90 ? LEVEL_BG.alert : LEVEL_BG.warn,
          text: tier >= 100
            ? (trial ? '试用额度已用完，感谢体验！想继续用可以联系站主' : '今日额度已用完，明天零点自动刷新')
            : `${trial ? '试用' : '今日'}额度已用 ${Math.min(100, Math.round(u.pct))}%`,
          sticky: tier >= 100,
        });
      })
      .catch(() => { /* fail-soft */ });
  }, [push]);

  useEffect(() => {
    if (!authUser) return undefined;
    pull();
    const t = setInterval(pull, 60_000);
    const onFocus = () => pull();
    window.addEventListener('focus', onFocus);
    window.addEventListener('nd-usage-refresh', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('nd-usage-refresh', onFocus);
    };
  }, [authUser, pull]);

  // 非 sticky 的自动收；sticky 的等用户动手
  useEffect(() => {
    const timers = banners.filter((b) => !b.sticky).map((b) => setTimeout(() => {
      setBanners((cur) => cur.filter((x) => x.key !== b.key));
    }, AUTO_HIDE_MS));
    return () => timers.forEach(clearTimeout);
  }, [banners]);

  const dismiss = (b) => {
    if (b.seenKey) markSeen(b.seenKey);
    setBanners((cur) => cur.filter((x) => x.key !== b.key));
  };

  if (banners.length === 0) return null;

  return (
    <div style={{
      position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)',
      zIndex: 90,
      display: 'flex', flexDirection: 'column', gap: 6,
      maxWidth: 'min(560px, calc(100vw - 32px))',
    }}>
      {/* 一次性下滑入场。不循环 —— 持续动效换不来注意力，只换来烦躁 */}
      <style>{'@keyframes nd-banner-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}'}</style>
      {banners.map((b) => (
        <div
          key={b.key}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px',
            borderRadius: 8,
            background: b.bg,
            color: '#fff',
            fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.5,
            boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
            animation: 'nd-banner-in 0.22s ease-out',
            whiteSpace: 'pre-wrap',
          }}
        >
          <span style={{ flex: 1 }}>{b.text}</span>
          <button
            onClick={() => dismiss(b)}
            title="关闭"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 18, height: 18, padding: 0, flexShrink: 0,
              background: 'rgba(255,255,255,0.16)', color: '#fff',
              border: 'none', borderRadius: 4, cursor: 'pointer',
            }}
          ><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}
