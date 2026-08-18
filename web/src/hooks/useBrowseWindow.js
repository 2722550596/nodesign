/**
 * web/src/hooks/useBrowseWindow.js — 浏览器窗的开关状态（2026-08-18）
 *
 * 窗本身是**会话级瞬态**（不是产物，不落盘），平时由两个一次性事件开：
 * `run.browser_opened` / `run.browser_help`。
 *
 * ⛔ 于是刷新一下页面就断了：窗没了，而且没有任何入口能再把它开出来。如果 agent
 * 正举着手等人过验证墙，用户从头到尾看不见它举手 —— 两分钟后 agent 超时、
 * 告诉用户"这个站从这台机器过不去"，而那两分钟其实是有人在的。
 * 所以进项目时问服务端一句"现在什么状况"（浏览器在跑吗、是不是有人在等）。
 *
 * 服务端那份答案也是瞬态的（进程内的 registry），pm2 重启就没了 —— 这是对的：
 * 浏览器真的没了。
 */

import { useState, useEffect } from 'react';
import { Browse } from '../lib/api.js';

/**
 * @param {string} projectId
 * @returns {[{url: string|null, help: string|null}|null, Function]}
 */
export function useBrowseWindow(projectId) {
  const [browseWin, setBrowseWin] = useState(null);

  useEffect(() => {
    let alive = true;
    Browse.state(projectId)
      .then((st) => {
        if (!alive || !st?.live) return;
        setBrowseWin({ url: st.url || null, help: st.help || null });
      })
      .catch(() => { /* 没有就没有，不打扰 */ });
    return () => { alive = false; };
  }, [projectId]);

  return [browseWin, setBrowseWin];
}
