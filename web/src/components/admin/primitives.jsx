// web/src/components/admin/primitives.jsx — 控制台小件（2026-08-20 从 AdminConsole.jsx
// 拆出，行数棘轮；样式原样）。
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

// ── 小件 ──────────────────────────────────────────────────────────────

export function Chip({ children, color }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: `1px ${GAP.md}px`, borderRadius: RADIUS.pill,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 600,
      color, background: `color-mix(in srgb, ${color} 12%, transparent)`,
    }}>{children}</span>
  );
}

export function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text3 }}>{label}</span>
      {children}
    </label>
  );
}

export function NumInput({ value, onChange, placeholder }) {
  return (
    <input
      type="number"
      min="0"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: 110, padding: `${GAP.sm}px ${GAP.md}px`,
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text,
        background: COLOR.bgWhite, border: `1px solid ${COLOR.borderMd}`, borderRadius: RADIUS.lg, outline: 'none',
        boxShadow: PAPER_SHADOW.far,
      }}
    />
  );
}

export function PrimaryBtn({ children, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: `${GAP.sm}px ${GAP.xl}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600,
        color: COLOR.btnText, background: disabled ? COLOR.dim : COLOR.btn,
        border: 0, borderRadius: RADIUS.lg, cursor: disabled ? 'default' : 'pointer',
      }}
    >{children}</button>
  );
}

export function GhostBtn({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: `${GAP.sm}px ${GAP.lg}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: COLOR.text3, background: 'transparent',
        border: `1px solid ${COLOR.borderMd}`, borderRadius: RADIUS.lg, cursor: 'pointer',
      }}
    >{children}</button>
  );
}

export function IconBtn({ children, title, onClick, danger }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 26, height: 26, borderRadius: RADIUS.md,
        background: 'transparent', border: 0, cursor: 'pointer',
        color: danger ? COLOR.error : COLOR.sub,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >{children}</button>
  );
}

