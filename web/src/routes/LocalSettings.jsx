// web/src/routes/LocalSettings.jsx — 本地分发版设置页（/settings，08-22）。
//
// 四块：状态（数据目录 / 版本 / 重启）、模型（API Key + 折叠起来的模型插槽 config.json）、本机能力（一张表）、其他钥匙与开关（.env 白名单）。
// 全部数据来自 /api/local/*（只在 NODESIGN_PROFILE=local 下存在）；hosted 下进来只会看到空态说明。
import { useState, useEffect, useCallback } from 'react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../lib/theme.js';
import { Local } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Section, Card, Btn, Err, Fold, Dot } from '../components/local/primitives.jsx';
import CapabilityTable from '../components/local/CapabilityTable.jsx';
import EnvKeys from '../components/local/EnvKeys.jsx';
import SlotEditor from '../components/local/SlotEditor.jsx';

export default function LocalSettings() {
  const showToast = useGlobalStore((s) => s.showToast);
  const [status, setStatus] = useState(null);
  const [cfg, setCfg] = useState(null);          // { raw, errors, enums, activeExternalModels, path }
  const [draft, setDraft] = useState(null);      // 正在编辑的 raw
  const [saving, setSaving] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const reload = useCallback(() => {
    Promise.all([Local.status(), Local.config()])
      .then(([s, c]) => { setStatus(s); setCfg(c); setDraft(c.raw); setLoadErr(''); })
      .catch((e) => setLoadErr(e.message));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await Local.saveConfig(draft);
      setCfg((c) => ({ ...c, errors: r.errors, raw: draft, exists: true }));
      setNeedsRestart(true);
      showToast(r.errors.length ? `已保存，但有 ${r.errors.length} 处问题（见红字），对应行不会生效` : '已保存，重启后生效', r.errors.length ? 'warn' : 'info');
    } catch (e) { showToast(`保存失败：${e.message}`, 'error'); } finally { setSaving(false); }
  };

  const restart = async () => {
    setRestarting(true);
    try { await Local.restart(); } catch { /* 进程正在退，请求可能断 */ }
    // 轮询 health 直到新进程起来再刷新
    const deadline = Date.now() + 30_000;
    const tick = async () => {
      try {
        const r = await fetch('/api/local/status');
        if (r.ok) { const s = await r.json(); if (s.pid !== status?.pid) { window.location.reload(); return; } }
      } catch { /* 还没起来 */ }
      if (Date.now() < deadline) setTimeout(tick, 700); else { setRestarting(false); showToast('重启超时，手动刷新看看', 'error'); }
    };
    setTimeout(tick, 1200);
  };

  const crumbs = [{ label: '设置' }];

  if (loadErr) {
    return (
      <AppShell breadcrumb={crumbs}>
        <div style={{ maxWidth: 720, margin: '40px auto', fontFamily: FONT_SANS, color: COLOR.text3 }}>
          <Err>{loadErr}</Err>
          <p style={{ fontSize: FONT_SIZE.sm }}>这一页只在本地分发版（NODESIGN_PROFILE=local）可用；线上多用户站没有 /api/local。</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumb={crumbs} actions={
      <Btn onClick={restart} disabled={restarting || !status}>{restarting ? '重启中…' : '重启'}</Btn>
    }>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${GAP.xl}px ${GAP.xl}px 80px` }}>
        <Section title="状态">
          <Card>
            {!status ? <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>读取中…</span> : (
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3, display: 'grid', gridTemplateColumns: '120px 1fr', gap: `${GAP.xs}px ${GAP.lg}px` }}>
                <span>版本</span><span style={{ fontFamily: FONT_MONO }}>nodesign {status.version} · pid {status.pid}</span>
                <span>数据目录</span><span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{status.dataRoot}</span>
                <span>配置文件</span><span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{status.configPath}</span>
                <span>插槽问题</span><span>{status.modelConfigErrors?.length ? status.modelConfigErrors.map((e, i) => <div key={i} style={{ color: COLOR.error }}>{e.where}: {e.message}</div>) : '无'}</span>
              </div>
            )}
          </Card>
        </Section>

        <Section title="模型" desc="先把这块配好，模型选择器里才会出现可选项">
          <Card>
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3, marginBottom: GAP.md }}>
              <Dot ok={status?.claudeAuth ? true : false} />
              {status?.claudeAuth === 'api_key' ? 'Claude 行可选：走 API Key'
                : status?.claudeAuth === 'login' ? 'Claude 行可选：用的是本机 claude login 的登录态'
                  : '还没配：填下面的 API Key，或在终端里 claude login 一次（之后点右上角「重启」）'}
            </div>
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, fontWeight: 500, marginBottom: GAP.xs }}>Anthropic 格式接口 → Claude 行</div>
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: GAP.sm }}>Claude 官方，或兼容 Anthropic 格式的中转站。填好就有 Sonnet / Opus 可选；不填也行，本机 claude login 过就用那份登录态。</div>
            <EnvKeys only={['模型']} bare showToast={showToast} onSaved={() => Local.status().then(setStatus).catch(() => {})}
              onCapabilities={(caps) => setStatus((s) => (s ? { ...s, capabilities: caps.map((c) => ({ ...c, tools: s.capabilities.find((x) => x.id === c.id)?.tools || [] })) } : s))} />
            <Fold title="OpenAI 格式接口 / 其他服务商 → 模型插槽" desc="DeepSeek、OpenAI、智谱、通义、OpenRouter、本机 Ollama…（也能再接别的 Anthropic 格式端点）">
              {cfg && draft ? (
                <SlotEditor config={draft} setConfig={setDraft} errors={cfg.errors} enums={cfg.enums} active={cfg.activeExternalModels}
                  needsRestart={needsRestart} onSave={save} saving={saving} showToast={showToast} />
              ) : <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>读取中…</span>}
            </Fold>
          </Card>
        </Section>

        <Section title="本机能力" desc="启动时探的；装好东西后「重启」重探">
          <CapabilityTable capabilities={status?.capabilities} />
        </Section>

        <Section title="其他钥匙与开关" desc={`写进 ${status?.dataRoot || '~/.nodesign'}/.env，钥匙类保存即生效`}>
          <EnvKeys exclude={['模型']} showToast={showToast} onCapabilities={(caps) => setStatus((s) => (s ? { ...s, capabilities: caps.map((c) => ({ ...c, tools: s.capabilities.find((x) => x.id === c.id)?.tools || [] })) } : s))} />
        </Section>
      </div>
    </AppShell>
  );
}
