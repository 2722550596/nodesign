// web/src/components/local/EnvKeys.jsx — 钥匙与开关（<dataRoot>/.env 白名单）。值只在输入框里存在，
// 服务端回的是打码预览；清空 = 删键。保存后钥匙类立刻生效，能力表随响应刷新。
import { useState, useEffect } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Local } from '../../lib/api.js';
import { Card, TextInput, Select, Hint, Err, Btn, Dot } from './primitives.jsx';

export default function EnvKeys({ onCapabilities, showToast }) {
  const [keys, setKeys] = useState(null);     // 服务端视图
  const [edits, setEdits] = useState({});     // key → 新值（'' = 清空）
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reload = () => Local.env().then((r) => { setKeys(r.keys); setEdits({}); }).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, []);

  if (!keys) return <Card><span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{err || '读取中…'}</span></Card>;
  const groups = [...new Set(keys.map((k) => k.group))];
  const dirty = Object.keys(edits).length > 0;

  const save = async (values) => {
    setBusy(true); setErr('');
    try {
      const r = await Local.saveEnv(values);
      setKeys(r.keys); setEdits({});
      onCapabilities?.(r.capabilities);
      showToast?.(r.changed.length ? `已保存 ${r.changed.join(', ')}` : '没有变化', 'info');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Card>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: GAP.lg }}>
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text4, marginBottom: GAP.sm, letterSpacing: 1 }}>{g}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: `${GAP.sm}px ${GAP.lg}px`, alignItems: 'start' }}>
            {keys.filter((k) => k.group === g).map((k) => {
              const editing = k.key in edits;
              return [
                <div key={k.key + '-l'} style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, paddingTop: 6 }}>
                  <Dot ok={k.set ? true : null} />{k.label}
                  <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{k.key}</div>
                </div>,
                <div key={k.key + '-v'}>
                  {k.options
                    ? <Select width={220} value={editing ? edits[k.key] : (k.preview || '')} options={k.options} onChange={(v) => setEdits({ ...edits, [k.key]: v })} />
                    : <TextInput type={k.secret ? 'password' : 'text'} value={editing ? edits[k.key] : ''} placeholder={k.set ? `已配 ${k.preview}（留空不改；要清除请输入 - ）` : '未配'}
                      onChange={(v) => setEdits({ ...edits, [k.key]: v })} />}
                  {k.hint && <Hint>{k.hint}</Hint>}
                </div>,
              ];
            })}
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: GAP.md, alignItems: 'center' }}>
        <Btn primary disabled={!dirty || busy} onClick={() => {
          // 约定：输入单个 "-" = 清除这个键
          const values = Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, v === '-' ? null : v]));
          save(values);
        }}>{busy ? '保存中…' : '保存钥匙'}</Btn>
        {dirty && <Btn onClick={() => setEdits({})}>放弃改动</Btn>}
        <Err>{err}</Err>
      </div>
    </Card>
  );
}
