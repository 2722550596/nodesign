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
 * 服务端那份答案一半是瞬态的（`live` 来自进程内 registry，pm2 重启就没了 —— 这是
 * 对的：浏览器真的没了），一半落盘（上次逛到哪）。桌面上那张浏览器卡吃的是后者，
 * 所以卡活得比实例长；这个 hook 只管"要不要**替他把窗弹出来**"。
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
        if (!alive) return;
        // ⭐ **只有 agent 正举着手才自动弹窗**（2026-08-18 加了桌面卡之后收紧）。
        // 原来是"浏览器活着就开窗"，那是**卡片还不存在时**唯一的找回办法；
        // 现在打开项目会被一扇全屏窗糊住，而用户可能只是来看别的东西。
        // 活着但没在求助 → 桌面上那张浏览器卡会写着"在跑"，他想看自己双击。
        if (!st?.live || !st?.help) return;
        setBrowseWin({ url: st.url || null, help: st.help });
      })
      .catch(() => { /* 没有就没有，不打扰 */ });
    return () => { alive = false; };
  }, [projectId]);

  return [browseWin, setBrowseWin];
}
