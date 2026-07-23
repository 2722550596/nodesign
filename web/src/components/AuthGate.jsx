/**
 * AuthGate — 单用户登录墙
 *
 * 挂载时查 /api/auth/status：
 *   - required=false（.env 未配密码，dev 模式）或已有有效 cookie → 直接渲染 app
 *   - 否则渲染密码页，POST /api/auth/login 成功后放行
 *
 * cookie 是 HttpOnly + 30 天，同源 fetch 自动携带，api.js 无需改动。
 */

import { useEffect, useState } from 'react';

const S = {
  page: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#FAF8F3', fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  card: { width: 340, padding: '40px 36px', textAlign: 'center' },
  logo: {
    display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 28,
    fontWeight: 700, fontSize: 18, color: '#1F1B16', letterSpacing: '0.02em',
  },
  logoMark: {
    width: 26, height: 26, borderRadius: 6, background: '#1F1B16', color: '#FAF8F3',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
  },
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
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((s) => setPhase(!s.required || s.authed ? 'ok' : 'login'))
      .catch(() => setPhase('login'));
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setPhase('ok');
      else setError(data.error || `登录失败 (${res.status})`);
    } catch {
      setError('网络错误，请重试');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'ok') return children;
  if (phase === 'checking') return <div style={S.page} />;

  return (
    <div style={S.page}>
      <form style={S.card} onSubmit={submit}>
        <div style={S.logo}>
          <span style={S.logoMark}>N</span>
          Nodesign
        </div>
        <input
          style={S.input}
          type="password"
          value={password}
          placeholder="访问密码"
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
        />
        <button style={S.button} type="submit" disabled={busy}>
          {busy ? '验证中…' : '进入工作台'}
        </button>
        <p style={S.error}>{error}</p>
        <p style={S.hint}>私有部署 · 仅限授权访问</p>
      </form>
    </div>
  );
}
