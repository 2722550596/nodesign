// web/src/components/local/CapabilityTable.jsx — 本机能力位一张表（GET /api/local/status 的 capabilities）
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Card, Dot } from './primitives.jsx';

export default function CapabilityTable({ capabilities }) {
  if (!capabilities?.length) return <Card><span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>还没探测</span></Card>;
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm }}>
        <tbody>
          {capabilities.map((c) => (
            <tr key={c.id} style={{ borderTop: `1px solid ${COLOR.borderLt}` }}>
              <td style={{ padding: `${GAP.sm}px ${GAP.lg}px`, whiteSpace: 'nowrap', verticalAlign: 'top', width: 220 }}>
                <Dot ok={c.available} /><span style={{ color: COLOR.text }}>{c.label}</span>
                {c.level === 'required' && !c.available && <span style={{ color: COLOR.error, marginLeft: 6, fontSize: FONT_SIZE.xs }}>必需</span>}
              </td>
              <td style={{ padding: `${GAP.sm}px ${GAP.lg}px`, verticalAlign: 'top', color: COLOR.text3 }}>
                <div>{c.uses}</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2, wordBreak: 'break-all' }}>{c.detail}</div>
                {!c.available && <div style={{ fontSize: FONT_SIZE.xs, color: COLOR.warn, marginTop: 2 }}>装法：{c.fix}</div>}
                {c.tools?.length > 0 && (
                  <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2 }}>
                    {c.available ? '管着' : '停用'}：{c.tools.join(' ')}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
