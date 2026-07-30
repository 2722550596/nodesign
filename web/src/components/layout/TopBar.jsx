import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { LogOut, AlertTriangle } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * 用户角标（2026-07-30 多用户内测；07-30 晚收成头像）
 *
 * 原来是「用户名 + 今日用量 + ⚠ + 登出」四件横排，顶栏本来就挤。收成一个头像点开菜单。
 *
 * 但**用量警告不能一起收进去**：内测有日限额，撞上了是硬失败（429 + 白话 toast），
 * 收进 popover 等于毫无预警。所以头像平时安静，接近限额时加一圈警告色描边——
 * 常驻的只剩"要不要紧"这一个比特，细节点开看。
 *
 * 轮询也因此不能改成"打开才拉"（那样描边永远不会亮），只是从 90s 放慢到 5 分钟。
 */
function UserBadge() {
  const authUser = useGlobalStore(s => s.authUser);
  const [usage, setUsage] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!authUser) return undefined;
    let dead = false;
    const pull = () => {
      fetch('/api/me/usage').then(r => (r.ok ? r.json() : null))
        .then(u => { if (!dead && u) setUsage(u); })
        .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 300_000);
    return () => { dead = true; clearInterval(t); };
  }, [authUser]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!authUser) return null;
  const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const nearCap = usage?.limit != null && usage.usedToday >= usage.limit * 0.8;
  const initial = (authUser.username || '?').trim().slice(0, 1).toUpperCase();

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        title={authUser.username}
        style={{
          width: 26, height: 26, borderRadius: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600,
          color: COLOR.text2,
          background: 'rgba(0,0,0,0.045)',
          border: nearCap ? `1.5px solid ${COLOR.warn}` : '1.5px solid transparent',
          cursor: 'pointer',
          padding: 0,
        }}
      >{initial}</button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6,
          minWidth: 176,
          background: '#fff',
          border: `1px solid ${COLOR.borderMd}`,
          borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
          padding: GAP.xs,
          zIndex: 60,
        }}>
          <div style={{
            padding: `${GAP.sm}px ${GAP.md}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text,
          }}>
            {authUser.username}
            {usage && (
              <div style={{ marginTop: 3, color: nearCap ? COLOR.warn : COLOR.sub, fontSize: 10 }}>
                今日 {fmt(usage.usedToday)}{usage.limit != null ? ` / ${fmt(usage.limit)}` : ''}
              </div>
            )}
          </div>
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px 0` }} />
          {authUser.role === 'admin' && (
            <Link to="/admin/issues" onClick={() => setOpen(false)} style={menuItem}>
              <AlertTriangle size={12} /> Harness 问题库
            </Link>
          )}
          <button
            onClick={async () => {
              try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* */ }
              window.location.reload();
            }}
            style={{ ...menuItem, width: '100%', border: 0, background: 'transparent', cursor: 'pointer' }}
          ><LogOut size={12} /> 登出</button>
        </div>
      )}
    </div>
  );
}

const menuItem = {
  display: 'flex', alignItems: 'center', gap: GAP.sm,
  padding: `${GAP.sm}px ${GAP.md}px`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
  color: COLOR.text2, textDecoration: 'none',
  borderRadius: 6,
  textAlign: 'left',
};

/**
 * TopBar — 顶栏（h: 56px）
 *
 * @param {object} props
 * @param {Array<{label, to?}>} [props.breadcrumb]  - 面包屑 [{label:'Nodesign', to:'/'}, {label:'项目名'}]
 * @param {ReactNode} [props.actions]               - 右侧操作区（按钮组）
 *
 * 注：原来还有个 status 药丸（运行中 / 上次失败 / 就绪），全仓没有任何路由传过它，
 * 2026-07-30 删掉。agent 在不在跑由聊天流尾部的占位行说，那儿才是用户看着的地方。
 */
/**
 * 面包屑单级。三种形态：
 *   to        路由跳转（Link）
 *   onClick   同页动作（比如画布从工作区退回项目区）
 *   都没有    当前位置，纯文本
 * 前两种带 hover 底色 + 手型，明确"这里可以按"。
 */
function Crumb({ item, last }) {
  const interactive = !!(item.to || item.onClick);
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '3px 8px',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    fontFamily: 'inherit', fontSize: 'inherit',
    color: interactive ? COLOR.text2 : COLOR.text,
    fontWeight: interactive ? 400 : 500,
    textDecoration: 'none',
    cursor: interactive ? 'pointer' : 'default',
    maxWidth: 280,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    transition: 'background 0.15s, color 0.15s',
  };
  const hoverOn = (e) => {
    if (!interactive) return;
    e.currentTarget.style.background = 'rgba(0,0,0,0.055)';
    e.currentTarget.style.color = COLOR.text;
  };
  const hoverOff = (e) => {
    if (!interactive) return;
    e.currentTarget.style.background = 'transparent';
    e.currentTarget.style.color = COLOR.text2;
  };
  const inner = (
    <>
      {item.icon}
      {item.label}
      {item.hint && <span style={{ color: COLOR.sub, fontFamily: FONT_MONO, fontSize: 11 }}>{item.hint}</span>}
    </>
  );
  if (item.to) {
    return (
      <Link to={item.to} title={item.title} style={base} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>{inner}</Link>
    );
  }
  if (item.onClick) {
    return (
      <button onClick={item.onClick} title={item.title} style={base} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>{inner}</button>
    );
  }
  return <span title={item.title} style={{ ...base, ...(last ? {} : {}) }}>{inner}</span>;
}

export default function TopBar({ breadcrumb = [], actions }) {
  return (
    <header style={{
      height: 56,
      flexShrink: 0,
      background: '#fff',
      borderBottom: `1px solid ${COLOR.border}`,
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${GAP.xl}px`,
      gap: GAP.lg,
      boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
    }}>
      {/* Logo */}
      <Link to="/" style={{
        display: 'flex',
        alignItems: 'center',
        gap: GAP.md,
        fontFamily: FONT_MONO,
        fontSize: FONT_SIZE.h2,
        fontWeight: 600,
        color: COLOR.text,
        letterSpacing: '-0.01em',
      }}>
        <span style={{
          width: 24, height: 24, borderRadius: 6,
          background: COLOR.btn, color: COLOR.btnText,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700,
        }}>N</span>
        Nodesign
      </Link>

      {/* Breadcrumb —— 可点的一级做成 hover 高亮的小块，一眼看出能按 */}
      {breadcrumb.length > 0 && (
        <>
          <span style={{ color: COLOR.dim, fontSize: FONT_SIZE.lg }}>/</span>
          <nav style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2, minWidth: 0 }}>
            {breadcrumb.map((item, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.sm, minWidth: 0 }}>
                {i > 0 && <span style={{ color: COLOR.dim }}>/</span>}
                <Crumb item={item} last={i === breadcrumb.length - 1} />
              </span>
            ))}
          </nav>
        </>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Actions */}
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md }}>{actions}</div>}

      {/* 用户角标（用户名 · 今日用量 · 登出）*/}
      <UserBadge />
    </header>
  );
}
