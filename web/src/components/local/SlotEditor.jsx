// web/src/components/local/SlotEditor.jsx — 模型插槽编辑（<dataRoot>/config.json 的 upstreams + models）。
//
// 表单字段按服务端 enums（GET /api/local/config）生成，字段名与 server/runtime/local-config.js 的 schema
// 一一对应 —— 这里不另起一份字段清单。保存 = PUT 原始对象，服务端校验后把 errors 回来标红；表是加载时冻结的，
// 所以保存后要「重启」才生效（页头按钮）。每行有「体检」：POST /api/local/models/:id/probe 五项红绿。
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Local } from '../../lib/api.js';
import { Card, TextInput, Select, Hint, Err, Btn, Dot } from './primitives.jsx';

const EMPTY_UPSTREAM = { baseUrl: '', protocol: 'anthropic', key: '' };
const EMPTY_MODEL = { id: '', label: '', window: 200000, upstream: '', wireModel: '' };

function errorsFor(errors, whereRe) {
  return (errors || []).filter((e) => whereRe.test(e.where)).map((e) => e.message).join('；');
}

const num = (v) => (v === '' || v == null ? undefined : Number(v));

export default function SlotEditor({ config, setConfig, errors, enums, active, needsRestart, onSave, saving, showToast }) {
  const [probe, setProbe] = useState({});        // id → { busy, result }
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  const upstreams = config.upstreams || {};
  const models = config.models || [];

  const setUp = (id, patch) => setConfig({ ...config, upstreams: { ...upstreams, [id]: { ...upstreams[id], ...patch } } });
  const renameUp = (oldId, newId) => {
    if (newId === oldId) return;
    const next = {}; for (const [k, v] of Object.entries(upstreams)) next[k === oldId ? newId : k] = v;
    setConfig({ ...config, upstreams: next, models: models.map((m) => (m.upstream === oldId ? { ...m, upstream: newId } : m)) });
  };
  const delUp = (id) => { const next = { ...upstreams }; delete next[id]; setConfig({ ...config, upstreams: next }); };
  const setModel = (i, patch) => setConfig({ ...config, models: models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const delModel = (i) => setConfig({ ...config, models: models.filter((_, j) => j !== i) });
  const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));

  const runProbe = async (id) => {
    setProbe((p) => ({ ...p, [id]: { busy: true } }));
    try { const r = await Local.probe(id); setProbe((p) => ({ ...p, [id]: { result: r } })); }
    catch (e) { setProbe((p) => ({ ...p, [id]: { result: { error: e.message } } })); showToast?.(`体检失败：${e.message}`, 'error'); }
  };

  if (jsonMode) {
    return (
      <Card>
        <div style={{ display: 'flex', gap: GAP.md, marginBottom: GAP.sm, alignItems: 'center' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>直接编辑 config.json（形状见 server/runtime/local-config.js 文件头）</span>
          <span style={{ flex: 1 }} />
          <Btn small onClick={() => { try { setConfig(JSON.parse(jsonText)); setJsonErr(''); setJsonMode(false); } catch (e) { setJsonErr(`JSON 不合法：${e.message}`); } }}>应用到表单</Btn>
          <Btn small onClick={() => { setJsonMode(false); setJsonErr(''); }}>取消</Btn>
        </div>
        <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false}
          style={{ width: '100%', minHeight: 320, boxSizing: 'border-box', fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text, background: COLOR.bgWhite, border: `1px solid ${COLOR.borderMd}`, borderRadius: RADIUS.lg, padding: GAP.md }} />
        <Err>{jsonErr}</Err>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.lg }}>
      <div style={{ display: 'flex', gap: GAP.md, alignItems: 'center' }}>
        <Btn primary disabled={saving} onClick={onSave}>{saving ? '保存中…' : '保存插槽'}</Btn>
        {needsRestart && <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.warn }}>已保存，重启后生效（页头「重启」）</span>}
        <span style={{ flex: 1 }} />
        <Btn small onClick={() => { setJsonText(JSON.stringify(config, null, 2)); setJsonMode(true); }}>JSON 模式</Btn>
      </div>
      <Err>{errorsFor(errors, /^\((根|文件)\)/)}</Err>

      {/* 上游 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, marginBottom: GAP.sm }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2 }}>上游（API 地址 + 钥匙）</span>
          <Btn small onClick={() => { let i = 1; while (upstreams[`upstream${i}`]) i++; setUp(`upstream${i}`, EMPTY_UPSTREAM); }}><Plus size={12} /> 加一个</Btn>
        </div>
        {Object.keys(upstreams).length === 0 && <Hint>还没有上游。先加上游（中转站 / 兼容 OpenAI 或 Anthropic 协议的任何端点），再在下面加模型行指向它。</Hint>}
        <div style={{ display: 'grid', gap: GAP.md }}>
          {Object.entries(upstreams).map(([id, u]) => (
            <Card key={id} style={{ padding: GAP.md }}>
              <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 140px 130px 1fr 28px', gap: GAP.sm, alignItems: 'center' }}>
                <TextInput value={id} onChange={(v) => renameUp(id, v)} placeholder="id（字母数字）" />
                <TextInput value={u.baseUrl} onChange={(v) => setUp(id, { baseUrl: v })} placeholder="https://api.example.com（不带 /v1）" />
                <Select value={u.protocol || 'anthropic'} options={enums.PROTOCOLS} onChange={(v) => setUp(id, { protocol: v })} />
                <Select value={u.authStyle || ''} options={['', ...enums.AUTH_STYLES]} onChange={(v) => setUp(id, clean({ authStyle: v }) .authStyle ? { authStyle: v } : { authStyle: undefined })} />
                <TextInput type="password" value={u.key || ''} onChange={(v) => setUp(id, { key: v })} placeholder={u.keyEnv ? `从 env ${u.keyEnv} 取` : 'API key（或在 JSON 模式填 keyEnv）'} />
                <button onClick={() => delUp(id)} title="删除" style={{ border: 0, background: 'transparent', color: COLOR.sub, cursor: 'pointer' }}><Trash2 size={14} /></button>
              </div>
              <Hint>协议：anthropic = /v1/messages 原生；openai-chat = /chat/completions（经转换层）。authStyle 留空按协议默认（anthropic→x-api-key，openai-chat→bearer）。</Hint>
              <Err>{errorsFor(errors, new RegExp(`^upstreams\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`))}</Err>
            </Card>
          ))}
        </div>
      </div>

      {/* 模型 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, marginBottom: GAP.sm }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2 }}>模型行（进 picker 的每一行）</span>
          <Btn small onClick={() => setConfig({ ...config, models: [...models, { ...EMPTY_MODEL, upstream: Object.keys(upstreams)[0] || '' }] })}><Plus size={12} /> 加一行</Btn>
        </div>
        <div style={{ display: 'grid', gap: GAP.md }}>
          {models.map((m, i) => {
            const pr = probe[m.id];
            const isActive = active?.includes(m.id);
            return (
              <Card key={i} style={{ padding: GAP.md }}>
                <div style={{ display: 'grid', gridTemplateColumns: '150px 150px 1fr 120px 150px 1fr 28px', gap: GAP.sm, alignItems: 'center' }}>
                  <TextInput value={m.id} onChange={(v) => setModel(i, { id: v })} placeholder="id（给 picker 用）" />
                  <TextInput mono={false} value={m.label} onChange={(v) => setModel(i, { label: v })} placeholder="显示名" />
                  <TextInput mono={false} value={m.desc || ''} onChange={(v) => setModel(i, { desc: v })} placeholder="一句话说明（可空）" />
                  <TextInput type="number" value={m.window ?? ''} onChange={(v) => setModel(i, { window: num(v) })} placeholder="窗口 tokens" />
                  <Select value={m.upstream || ''} options={['', ...Object.keys(upstreams)]} onChange={(v) => setModel(i, { upstream: v })} />
                  <TextInput value={m.wireModel} onChange={(v) => setModel(i, { wireModel: v })} placeholder="上游真名（发给上游的 model）" />
                  <button onClick={() => delModel(i)} title="删除" style={{ border: 0, background: 'transparent', color: COLOR.sub, cursor: 'pointer' }}><Trash2 size={14} /></button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '150px 150px 150px 120px 1fr', gap: GAP.sm, alignItems: 'center', marginTop: GAP.sm }}>
                  <Select value={m.thinking || 'strip'} options={enums.THINKING_MODES.map((t) => ({ value: t, label: `thinking: ${t}` }))} onChange={(v) => setModel(i, { thinking: v })} />
                  <Select value={m.reasoningEffort || ''} options={[{ value: '', label: 'effort: 不传' }, ...enums.REASONING_EFFORTS.map((t) => ({ value: t, label: `effort: ${t}` }))]} onChange={(v) => setModel(i, { reasoningEffort: v || undefined })} />
                  <Select value={m.brand || 'custom'} options={enums.BRANDS.map((b) => ({ value: b, label: `标: ${b}` }))} onChange={(v) => setModel(i, { brand: v })} />
                  <TextInput type="number" value={m.maxOutput ?? ''} onChange={(v) => setModel(i, { maxOutput: num(v) })} placeholder="maxOutput" />
                  <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'center', justifyContent: 'flex-end' }}>
                    <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: isActive ? COLOR.success : COLOR.sub }}>{isActive ? '● 生效中' : '○ 未生效（保存并重启）'}</span>
                    <Btn small disabled={!isActive || pr?.busy} onClick={() => runProbe(m.id)}>{pr?.busy ? '体检中…' : '体检'}</Btn>
                  </div>
                </div>
                <Hint>窗口 = 上游真实上下文（填大了撑满时上游 400，填小了白扔容量）。重试/续接/价目/liftImages/fastModel 等少用字段在 JSON 模式里填，字段名同内置表。</Hint>
                <Err>{errorsFor(errors, new RegExp(`^models(\\[${i}\\]| \\(${(m.id || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\))`))}</Err>
                {pr?.result && <ProbeResult r={pr.result} />}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ProbeResult({ r }) {
  if (r.error) return <Err>{r.error}</Err>;
  return (
    <div style={{ marginTop: GAP.sm, borderTop: `1px solid ${COLOR.borderLt}`, paddingTop: GAP.sm }}>
      {r.checks.map((c) => (
        <div key={c.id} style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text3, padding: '2px 0' }}>
          <Dot ok={c.ok} /><b style={{ color: COLOR.text2 }}>{c.label}</b>
          {c.level === 'info' && <span style={{ color: COLOR.sub }}>（参考）</span>}
          <span style={{ fontFamily: FONT_MONO, color: COLOR.sub, marginLeft: 6 }}>{c.ms ? `${(c.ms / 1000).toFixed(1)}s` : ''}</span>
          <span style={{ marginLeft: 8 }}>{c.note}</span>
        </div>
      ))}
    </div>
  );
}
