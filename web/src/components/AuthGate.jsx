/**
 * AuthGate — 登录墙（2026-07-30 多用户版）
 *
 * 挂载时查 /api/auth/status：
 *   - required=false（dev 模式）或已有有效身份 → 渲染 app，并把 user 挂到
 *     globalStore（顶栏显示用户名 / 登出、admin 判定都从那读）
 *   - 否则渲染登录页；「邀请码注册」tab 给内测新用户自助开号
 *
 * 全局 401：api.js jsonRequest 收到 401 时派发 `nd:unauthorized` window 事件，
 * 这里监听 → 回登录态（解决 cookie 过期后散落报错、WS 4401 停止重连后卡死）。
 *
 * cookie 是 HttpOnly + 30 天，同源 fetch 自动携带。
 */

import { useEffect, useState } from 'react';
import { useGlobalStore } from '../stores/globalStore.js';

const S = {
  page: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#FAF8F3', fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  card: { width: 340, padding: '40px 36px', textAlign: 'center' },
  logo: {
    display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 22,
    fontWeight: 700, fontSize: 18, color: '#1F1B16', letterSpacing: '0.02em',
  },
  logoMark: {
    width: 26, height: 26, borderRadius: 6, background: '#1F1B16', color: '#FAF8F3',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
  },
  tabs: { display: 'flex', gap: 4, marginBottom: 18, justifyContent: 'center' },
  tab: (active) => ({
    padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
    border: 'none', borderRadius: 8,
    background: active ? '#1F1B16' : 'transparent',
    color: active ? '#FAF8F3' : '#8D8578',
  }),
  input: {
    width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 14,
    fontFamily: 'inherit', border: '1px solid #DDD6CA', borderRadius: 10,
    background: '#FFFFFF', color: '#1F1B16', outline: 'none', marginBottom: 12,
  },
  button: {
    width: '100%', padding: '12px 0', fontSize: 14, fontFamily: 'inherit', fontWeight: 600,
    border: 'none', borderRadius: 10, background: '#1F1B16', color: '#FAF8F3',
    cursor: 'pointer',
  },
  error: { color: '#B4231F', fontSize: 12, minHeight: 18, margin: '10px 0 0' },
  hint: { color: '#8D8578', fontSize: 12, marginTop: 20 },
};

export default function AuthGate({ children }) {
  // checking | login | ok
  const [phase, setPhase] = useState('checking');
  const [mode, setMode] = useState('login');   // login | register
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const applyStatus = (s) => {
    if (!s.required || s.authed) {
      useGlobalStore.getState().setAuthUser?.(s.user || null);
      setPhase('ok');
    } else {
      setPhase('login');
    }
  };

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then(applyStatus)
      .catch(() => setPhase('login'));
  }, []);

  // 全局 401（api.js 派发）→ 回登录态。WS 4401 断连后接口一定跟着 401，同一条路收口
  useEffect(() => {
    const onUnauthorized = () => {
      useGlobalStore.getState().setAuthUser?.(null);
      setPhase((p) => (p === 'ok' ? 'login' : p));
    };
    window.addEventListener('nd:unauthorized', onUnauthorized);
    return () => window.removeEventListener('nd:unauthorized', onUnauthorized);
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy || !username || !password) return;
    if (mode === 'register' && !inviteCode) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register'
          ? { username, password, inviteCode }
          : { username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        useGlobalStore.getState().setAuthUser?.(data.user || null);
        setPhase('ok');
      } else {
        setError(data.error || `${mode === 'register' ? '注册' : '登录'}失败 (${res.status})`);
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'ok') return children;
  if (phase === 'checking') return <div style={S.page} />;

  const isRegister = mode === 'register';
  return (
    <div style={S.page}>
      <form style={S.card} onSubmit={submit}>
        <div style={S.logo}>
          <span style={S.logoMark}>N</span>
          Nodesign
        </div>
        <div style={S.tabs}>
          <button type="button" style={S.tab(!isRegister)} onClick={() => { setMode('login'); setError(''); }}>登录</button>
          <button type="button" style={S.tab(isRegister)} onClick={() => { setMode('register'); setError(''); }}>邀请码注册</button>
        </div>
        <input
          style={S.input}
          value={username}
          placeholder="用户名"
          autoFocus
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          style={S.input}
          type="password"
          value={password}
          placeholder={isRegister ? '设置密码（至少 8 位）' : '密码'}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          onChange={(e) => setPassword(e.target.value)}
        />
        {isRegister && (
          <input
            style={S.input}
            value={inviteCode}
            placeholder="邀请码（nd-xxxxxxxx）"
            onChange={(e) => setInviteCode(e.target.value)}
          />
        )}
        <button style={S.button} type="submit" disabled={busy}>
          {busy ? '验证中…' : isRegister ? '注册并进入' : '进去'}
        </button>
        <p style={S.error}>{error}</p>
        <p style={S.hint}>小范围内测 · 凭邀请进入</p>
      </form>
    </div>
  );
}
