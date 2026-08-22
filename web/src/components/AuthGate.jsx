/**
 * AuthGate — 登录墙（2026-07-30 多用户版；2026-08-03 线索墙改版；2026-08-17 拆场景 + 定格轮播）
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
 *
 * ## 这个文件现在只剩三件事
 *
 * 鉴权、**壳**（板面 / 标题 / 登记卡 / 缩放）、轮播的接线。墙上钉的那些纸不在这儿
 * —— 一套构图一个文件，住在 `login-wall/scenes/`，材质词汇在 `login-wall/wall-css.js`。
 * 切口是用户当初定的那句「能共用的是材质，不是坐标」。
 *
 * 壳里为什么留着标题和登记卡：它们是**跨场景不变的锚**。墙可以换故事，但访客得
 * 认得出这是哪儿、进门的门在哪；全都跟着换，这页就没有身份了。所以新场景设计时
 * 要绕开左上角标题区和右侧登记卡那两块地。
 *
 * 这个页面在鉴权之前，不能走 /api，也绝不引用真实用户数据，墙上内容全是写死的样例。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useGlobalStore } from '../stores/globalStore.js';
import { Underline } from './PaperBits.jsx';
import { WALL_CSS } from './login-wall/wall-css.js';
import { DESIGN_W, SAFE_H, NARROW_W } from './login-wall/geometry.js';
import { SCENES } from './login-wall/scenes/index.js';
import { useSceneCarousel } from './login-wall/useSceneCarousel.js';
import Scene from './login-wall/Scene.jsx';

export default function AuthGate({ children }) {
  // checking | login | ok
  const [phase, setPhase] = useState('checking');
  const [mode, setMode] = useState('login');   // login | register
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [openReg, setOpenReg] = useState(false);   // 服务端 /api/auth/status 的 openRegistration：没邀请码也能开号（08-21）
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const rootRef = useRef(null);

  const applyStatus = (s) => {
    setOpenReg(!!s.openRegistration);
    useGlobalStore.getState().setAuthProfile?.(s.profile);
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

  // 墙按安全框 contain、顶边对齐：竖向富余留给底边，顶边永不裁
  useLayoutEffect(() => {
    if (phase !== 'login') return undefined;
    const fit = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setNarrow(w < NARROW_W);
      if (rootRef.current) {
        rootRef.current.style.setProperty('--s', String(Math.min(w / DESIGN_W, h / SAFE_H)));
      }
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [phase]);
  // 墙轮着播：只在真正显示墙的时候转（窄屏只有登记卡，没有墙可换）
  const { scene, phase: scenePhase } = useSceneCarousel(SCENES, {
    enabled: phase === 'login' && !narrow,
  });

  async function submit(e) {
    e.preventDefault();
    if (busy || !username || !password) return;
    if (mode === 'register' && !inviteCode && !openReg) return;
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
  if (phase === 'checking') return <div style={{ minHeight: '100vh', background: '#F0EADB' }} />;

  const isRegister = mode === 'register';

  const form = (
    <>
      <h2>来访登记</h2>
      <div className="m">{openReg ? '免费开放中 · 邀请码可解锁 Claude' : '小范围内测中'}</div>
      <div className="ndw-tabs">
        <button type="button" className={isRegister ? '' : 'on'}
          onClick={() => { setMode('login'); setError(''); }}>
          登录{!isRegister && <Underline />}
        </button>
        <button type="button" className={isRegister ? 'on' : ''}
          onClick={() => { setMode('register'); setError(''); }}>
          {openReg ? '注册' : '邀请码注册'}{isRegister && <Underline />}
        </button>
      </div>
      <div className="ndw-field">
        <label htmlFor="ndw-u">用户名 · USERNAME</label>
        <input id="ndw-u" value={username} placeholder="写下用户名" autoFocus
          autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="ndw-field">
        <label htmlFor="ndw-p">密码 · PASSWORD</label>
        <input id="ndw-p" type="password" value={password}
          placeholder={isRegister ? '设置密码，至少 8 位' : '写下密码'}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          onChange={(e) => setPassword(e.target.value)} />
      </div>
      {isRegister && (
        <div className="ndw-field">
          <label htmlFor="ndw-i">邀请码 · INVITE{openReg ? '（可选）' : ''}</label>
          <input id="ndw-i" value={inviteCode} placeholder={openReg ? '有就填，解锁 Claude 订阅模型' : 'nd-xxxxxxxx'}
            onChange={(e) => setInviteCode(e.target.value)} />
        </div>
      )}
      <p className="ndw-err">{error}</p>
      <button className="go" type="submit" disabled={busy}>
        {busy ? '核 对 中' : isRegister ? '开 号' : '进 门'}
      </button>
      <p className="foot">{openReg ? '直接开号即可，免费模型人人可用；有邀请码的填进去解锁对应档位。' : '目前仅限受邀开号。'}</p>
    </>
  );

  return (
    <div className={`ndw${narrow ? ' narrow' : ''}`} ref={rootRef}>
      <style>{WALL_CSS}</style>

      {!narrow && (
        <>
          <div className="ndw-ghost" style={{ left: '2%', top: '64%', width: 132, height: 96, transform: 'rotate(-2deg)' }} />
          <div className="ndw-ghost" style={{ left: '90.5%', top: '10%', width: 108, height: 148, transform: 'rotate(1.6deg)' }} />
          <div className="ndw-ghost" style={{ left: '6.5%', top: '11%', width: 92, height: 70, transform: 'rotate(2.4deg)' }} />
          <div className="ndw-ghost" style={{ left: '85%', top: '76%', width: 150, height: 104, transform: 'rotate(-1.2deg)' }} />
        </>
      )}
      {narrow ? (
        <form className="ndw-card ndw-solo" onSubmit={submit}>
          <span className="brand">Nodesign</span>
          {form}
        </form>
      ) : (
        <div className="ndw-stage">
          {/* 跨场景不变的锚（一）：认得出这是哪儿 */}
          <div className="ndw-head">
            <div className="row">
              <span className="ndw-logo">Nodesign</span>
              <span className="ndw-anno">创作者的 agent 工作间</span>
            </div>
            <h1>想到，<span className="u">做出来<Underline w={1.8} /></span>，验一遍</h1>
            <p className="ndw-sub">不用会画图，也不用学工具。</p>
          </div>

          {/* 会换的那一半：一套构图 = 一个场景文件 */}
          <Scene scene={scene} phase={scenePhase} />

          {/* 跨场景不变的锚（二）：线索的终点，门 */}
          <form className="ndw-card" onSubmit={submit}>
            <span className="pin" />
            <div className="ndw-stamp">凭邀请</div>
            {form}
          </form>
        </div>
      )}
    </div>
  );
}
