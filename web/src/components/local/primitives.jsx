// web/src/components/local/primitives.jsx — 设置页小件（文本框 / 下拉 / 区块 / 红绿点），
// 与 admin/primitives.jsx 同一套纸面语言；那边是控制台专用，这边是本地版设置专用，别互相 import 免得
// 两个页面的改动互相牵扯。
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, FONT_KAI } from '../../lib/theme.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

export const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: `${GAP.sm}px ${GAP.md}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text,
  background: COLOR.bgWhite, border: `1px solid ${COLOR.borderMd}`, borderRadius: RADIUS.lg, outline: 'none',
  boxShadow: PAPER_SHADOW.far,
};

export function TextInput({ value, onChange, placeholder, type = 'text', mono = true, width }) {
  return (
    <input type={type} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, fontFamily: mono ? FONT_MONO : FONT_SANS, ...(width ? { width } : {}) }} />
  );
}

export function Select({ value, onChange, options, width }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, ...(width ? { width } : {}) }}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? (o === '' ? '（空）' : o) : o.label;
        return <option key={v} value={v}>{label}</option>;
      })}
    </select>
  );
}

export function Section({ title, desc, actions, children }) {
  return (
    <section style={{ marginBottom: GAP.xxl }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.md, marginBottom: GAP.sm }}>
        <h2 style={{ margin: 0, fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, color: COLOR.text }}>{title}</h2>
        {desc && <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{desc}</span>}
        <span style={{ flex: 1 }} />
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, style }) {
  return (
    <div style={{ background: COLOR.bgWhite, borderRadius: RADIUS.lg, boxShadow: PAPER_SHADOW.far, padding: GAP.lg, ...style }}>{children}</div>
  );
}

export function Dot({ ok }) {
  const color = ok === true ? COLOR.success : ok === false ? COLOR.error : COLOR.sub;
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color, marginRight: 6, verticalAlign: 'middle' }} />;
}

export function Hint({ children }) {
  return <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 3 }}>{children}</div>;
}

export function Err({ children }) {
  if (!children) return null;
  return <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.error, marginTop: 3 }}>{children}</div>;
}

export function Btn({ children, onClick, disabled, primary, danger, small }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: small ? `2px ${GAP.md}px` : `${GAP.sm}px ${GAP.lg}px`,
      fontFamily: FONT_SANS, fontSize: small ? FONT_SIZE.xs : FONT_SIZE.sm, fontWeight: primary ? 600 : 400,
      color: primary ? COLOR.btnText : danger ? COLOR.error : COLOR.text3,
      background: primary ? (disabled ? COLOR.dim : COLOR.btn) : 'transparent',
      border: primary ? 0 : `1px solid ${danger ? COLOR.error : COLOR.borderMd}`, borderRadius: RADIUS.lg,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled && !primary ? 0.5 : 1,
    }}>{children}</button>
  );
}
