import { useState, useRef, useEffect, useCallback } from 'react';
import { Cpu, Check, Loader2 } from 'lucide-react';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SANS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Sessions } from '../../lib/api.js';

/**
 * 模型选择 —— Composer 工具栏里的小 picker。
 *
 * **真相在服务端**（2026-07-30 重做）。原来这里只认 localStorage 里的偏好，
 * 而模型的实际值住在会话的 session-config.json：换台机器 / 清了缓存打开一个跑着
 * Opus 的会话，按钮写着 Sonnet，用户按 Sonnet 的心态发消息、烧的是 Opus 额度。
 * 更糟的是选「默认」根本不做任何事 —— 它只是"不发 model 字段"，服务端于是保持
 * 原样，会话一旦切到 Opus 就再也回不到 Sonnet。
 *
 * 现在分两种处境：
 *   - **会话已存在**：GET /sessions/:sid/model 拿生效值和可选清单，选中即
 *     PUT 回去（服务端写配置 + 让空闲的 query 重启）。localStorage 不参与。
 *   - **还没有会话**（首页快速开始 / 项目 Hub）：没有可写的对象，仍用
 *     localStorage 偏好，随第一条消息的 body.model 带过去建会话。
 *
 * 可选清单也来自服务端（model-context.js 的 SELECTABLE_MODELS）—— 前端硬编码
 * model id 写错一个字，spoofing 和真实容量两张表都查不到，两处都只会静默降级。
 */

/** 服务端拿不到时的兜底清单（离线 / 接口挂了也别让按钮变成死的） */
const FALLBACK_OPTIONS = [
  { id: 'claude-sonnet-5[1m]', label: 'Sonnet', desc: '快 · 日常改稿和铺页够用' },
  { id: 'claude-opus-5[1m]', label: 'Opus 5', desc: '前端与审美更强 · 烧订阅额度快得多，重活再开' },
];

function shortLabel(id, options) {
  if (!id) return '默认';
  const hit = options.find(o => o.id === id);
  if (hit) return hit.label;
  if (/opus/i.test(id)) return 'Opus';
  if (/sonnet/i.test(id)) return 'Sonnet';
  if (/haiku/i.test(id)) return 'Haiku';
  return id;
}

/**
 * 换模型的隐性代价：**提示词缓存是按模型绑定的**，换一个就等于整段上下文缓存作废。
 * 下一轮那些 token 不再按 $0.30/M 的缓存命中价读，而是按 $3/M 的 input 重读一遍，
 * 外加 $6.00/M 再写一次缓存 —— 同样一轮对话，切换前后 token 数几乎没变，钱差三十倍。
 *
 * 这是用量口径从 token 换成金额之后才看得见的东西，所以以前没法提醒。
 * 估算按 sonnet 标准价（$3/M input + $6.00/M 1 小时缓存写 = $9/M）：opus 更贵，
 * 报低不报高 —— 提醒的作用是让人知道"这一下不便宜"，不是给报价。
 */
const COLD_START_USD_PER_TOKEN = 9 / 1_000_000;
/** 低于这个上下文就不提醒：新会话切模型几乎免费，弹窗只会变成噪音 */
const WARN_FROM_TOKENS = 30_000;

export default function ModelPicker({ disabled = false, projectId = null, sessionId = null, contextTokens = 0 }) {
  const modelPref = useGlobalStore(s => s.modelPref);
  const setModelPref = useGlobalStore(s => s.setModelPref);
  const showToast = useGlobalStore(s => s.showToast);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // 服务端口径：{ model, override, default, options }。没有会话时为 null
  const [remote, setRemote] = useState(null);
  const ref = useRef(null);

  const hasSession = !!(projectId && sessionId);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onClick); window.removeEventListener('keydown', onKey); };
  }, [open]);

  // 会话变了就重新问一次服务端。切走时清掉，免得把上一场的模型显示成这一场的
  useEffect(() => {
    if (!hasSession) { setRemote(null); return undefined; }
    let alive = true;
    Sessions.model(projectId, sessionId)
      .then((r) => { if (alive) setRemote(r); })
      .catch(() => { /* 拿不到就退回本地偏好显示 */ });
    return () => { alive = false; };
  }, [hasSession, projectId, sessionId]);

  const options = remote?.options?.length ? remote.options : FALLBACK_OPTIONS;
  // 生效值：有会话看服务端，没会话看本地偏好（本地 null = 跟随服务端默认）
  const effective = hasSession ? (remote?.model || null) : modelPref;
  // 打勾打在"用户选过的那一档"上：没覆盖就打在「默认」，跟按钮上显示的实际模型
  // 是两回事 —— 按钮说"现在跑什么"，勾说"你选了什么"
  const chosen = hasSession ? (remote?.override ?? null) : modelPref;
  const isDefault = chosen === null;

  const select = useCallback(async (id) => {
    setOpen(false);
    if (!hasSession) { setModelPref(id); return; }
    if (id === chosen) return;
    // 大上下文切模型要重新过一遍缓存，先把代价说清楚再让他按
    if (contextTokens >= WARN_FROM_TOKENS) {
      const est = contextTokens * COLD_START_USD_PER_TOKEN;
      const okToSwitch = window.confirm(
        `切换模型会让这个会话的缓存失效。\n\n`
        + `当前上下文 ${(contextTokens / 1000).toFixed(0)}k tokens，下一轮要重新读一遍，`
        + `大约多花 $${est.toFixed(2)}（之后恢复正常）。\n\n`
        + `对话和画布都不会丢。要切吗？`,
      );
      if (!okToSwitch) return;
    }
    const prev = remote;
    setSaving(true);
    // 乐观更新：点完立刻变，失败再退回去
    setRemote(r => ({ ...(r || {}), override: id, model: id || r?.default || null }));
    try {
      const r = await Sessions.setModel(projectId, sessionId, id);
      setRemote(r);
      // 本地偏好跟着走：下次在别处新建会话时用同一个选择
      setModelPref(id);
    } catch (err) {
      setRemote(prev);
      showToast(`切模型失败：${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [hasSession, chosen, remote, projectId, sessionId, setModelPref, showToast, contextTokens]);

  const label = shortLabel(effective, options);
  const busy = disabled || saving;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <style>{'@keyframes nd-model-spin { to { transform: rotate(360deg); } }'}</style>
      <button
        onClick={() => !busy && setOpen(v => !v)}
        disabled={busy}
        title={
          disabled ? '这一轮跑完再切（切换从下一条消息生效）'
            : hasSession
              ? `这个会话跑在 ${effective || options[0]?.id || '默认模型'}${isDefault ? '（跟随全局默认）' : ''}。切换从下一条消息生效，对话不丢`
              : `新会话将用 ${label}${isDefault ? '（跟随服务端默认）' : ''}`
        }
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          padding: `${GAP.xs}px ${GAP.sm}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
          color: isDefault ? COLOR.text2 : COLOR.btnText,
          background: isDefault ? 'transparent' : COLOR.btn,
          border: `1px solid ${isDefault ? COLOR.borderMd : COLOR.btn}`,
          borderRadius: RADIUS.md,
          cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.5 : 1,
          transition: 'all 0.15s',
        }}
      >
        {saving
          ? <Loader2 size={11} style={{ animation: 'nd-model-spin 0.9s linear infinite' }} />
          : <Cpu size={11} />}
        {label}
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0,
          minWidth: 240,
          background: COLOR.bgWhite,
          borderRadius: 2,
          boxShadow: SHADOW.pop,
          padding: GAP.xs,
          zIndex: 60,
        }}>
          <Option
            active={isDefault}
            label="默认"
            desc={remote?.default
              ? `跟随全局默认（${shortLabel(remote.default, options)}）`
              : '跟随服务端默认'}
            onClick={() => select(null)}
          />
          {options.map((o) => (
            <Option
              key={o.id}
              active={chosen === o.id}
              label={o.label}
              desc={o.desc}
              onClick={() => select(o.id)}
            />
          ))}
          <div style={{
            padding: `${GAP.xs}px ${GAP.md}px ${GAP.xs}px`, borderTop: `1px solid ${COLOR.borderLt}`,
            marginTop: GAP.xxs, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }}>
            {hasSession
              ? (contextTokens >= WARN_FROM_TOKENS
                ? `从下一条消息生效，对话与画布不丢。当前上下文 ${(contextTokens / 1000).toFixed(0)}k，换模型要重读一遍缓存，额外花约 $${(contextTokens * COLD_START_USD_PER_TOKEN).toFixed(2)}`
                : '从下一条消息生效，对话与画布不丢')
              : '这条只影响接下来新建的会话'}
          </div>
        </div>
      )}
    </div>
  );
}

function Option({ active, label, desc, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
        padding: `${GAP.sm}px ${GAP.md}px`,
        background: 'transparent', border: 'none', borderRadius: RADIUS.sm,
        cursor: 'pointer', textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ width: 13, flexShrink: 0, marginTop: GAP.xxs }}>
        {active && <Check size={12} color={COLOR.text} />}
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>
          {label}
        </span>
        <span style={{ display: 'block', fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 1 }}>
          {desc}
        </span>
      </span>
    </button>
  );
}
