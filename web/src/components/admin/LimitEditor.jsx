// web/src/components/admin/LimitEditor.jsx — 用户行的限额/外审/本地产线编辑器与外审档章
// （2026-08-20 从 AdminConsole.jsx 拆出，行数棘轮）。
import { useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { Admin } from '../../lib/api-admin.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Segmented } from '../../routes/Issues.jsx';
import { Chip, Field, NumInput, PrimaryBtn, GhostBtn } from './primitives.jsx';

// 外审档章：显示实际生效档，显式设过的加个点（区分"我设的"和"跟着默认走"）。
// 08-20 起两个旋钮并排：订阅模型（Sonnet/Opus）一枚、本地/中转（qwen、gemini）一枚。
const MOD_LEVEL_META = {
  off: { label: '外审关', color: COLOR.sub },
  loose: { label: '外审宽松', color: COLOR.text3 },
  strict: { label: '外审严格', color: COLOR.brown },
};

export function ModLevelChip({ u }) {
  const knobs = [
    ['订阅', u.effectiveModerationLevel, u.moderationLevel],
    ['本地/中转', u.effectiveModerationLevelApi, u.moderationLevelApi],
  ];
  return (
    <>
      {knobs.map(([name, eff, explicit]) => {
        const meta = MOD_LEVEL_META[eff || 'loose'] || MOD_LEVEL_META.loose;
        const pinned = !!explicit;
        return (
          <span key={name} title={`${name}模型：${pinned ? '按账号单独设置' : '跟随默认档'}`}>
            <Chip color={meta.color}>{name} · {meta.label.replace('外审', '')}{pinned ? ' ·' : ''}</Chip>
          </span>
        );
      })}
    </>
  );
}

export function LimitEditor({ u, onDone, onCancel }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [daily, setDaily] = useState(u.dailyCostLimitUsd ?? '');
  const [lifetime, setLifetime] = useState(u.lifetimeCostLimitUsd ?? '');
  // '' = 跟随默认档（存 null）；其余三档是显式覆盖。两个旋钮各自独立（08-20）。
  const [level, setLevel] = useState(u.moderationLevel ?? '');
  const [levelApi, setLevelApi] = useState(u.moderationLevelApi ?? '');
  const [localGen, setLocalGen] = useState(u.allowLocalGen ? '1' : '0');
  const [saving, setSaving] = useState(false);
  const isAdmin = u.role === 'admin';

  const save = async () => {
    const num = (v) => (v === '' || v === null ? null : Number(v));
    if ([daily, lifetime].some(v => v !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0))) {
      showToast('限额需为非负数字，留空表示默认/无', 'error');
      return;
    }
    setSaving(true);
    try {
      const patch = {
        moderationLevel: level === '' ? null : level,
        moderationLevelApi: levelApi === '' ? null : levelApi,
      };
      if (!isAdmin) {
        patch.dailyCostLimitUsd = num(daily); patch.lifetimeCostLimitUsd = num(lifetime);
        patch.localGen = localGen === '1';
      }
      await Admin.patchUser(u.id, patch);
      showToast(`已更新 ${u.username}`, 'success');
      onDone();
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
      setSaving(false);
    }
  };

  return (
    <div style={{
      marginTop: GAP.lg, paddingTop: GAP.lg, borderTop: `1px solid ${COLOR.borderLt}`,
      display: 'flex', alignItems: 'flex-end', gap: GAP.xl, flexWrap: 'wrap',
    }}>
      {!isAdmin && (
        <>
          <Field label="日限额 $（留空 = 默认 $50）">
            <NumInput value={daily} onChange={setDaily} placeholder="50" />
          </Field>
          <Field label="终身额度 $（留空 = 无，走日限）">
            <NumInput value={lifetime} onChange={setLifetime} placeholder="—" />
          </Field>
        </>
      )}
      <Field label="内容外审 · 订阅模型（Sonnet/Opus）">
        <Segmented value={level} onChange={setLevel} options={[
          ['', '跟随默认'], ['off', '关闭'], ['loose', '宽松'], ['strict', '严格'],
        ]} />
      </Field>
      <Field label="内容外审 · 本地/中转（Qwen、Gemini）">
        <Segmented value={levelApi} onChange={setLevelApi} options={[
          ['', '跟随默认'], ['off', '关闭'], ['loose', '宽松'], ['strict', '严格'],
        ]} />
      </Field>
      {!isAdmin && (
        <Field label="本地产线（生图/视频盒子）">
          <Segmented value={localGen} onChange={setLocalGen} options={[
            ['0', '未开通'], ['1', '开通'],
          ]} />
        </Field>
      )}
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, flex: 1, minWidth: 220, lineHeight: 1.5 }}>
        {!isAdmin && <>终身额度非空即生效且取代日限：对全史花费封顶、不刷新（试用口径）。<br /></>}
        两个旋钮按模型通路各自生效（订阅模型跑在站主账号上，本地/中转只花电费或 API 钱），互不牵连。
        外审默认档两边相同：试用号严格 / 正式号宽松 / admin 关闭。宽松只拦硬违规
        （未成年人色情、恐怖主义、武器毒品、犯罪教程、恶意软件、教唆自残、人肉），
        虚构里的暴力与成人向情节放行；严格再加色情、美化暴力、群体仇恨。
      </div>
      <div style={{ display: 'flex', gap: GAP.sm }}>
        <PrimaryBtn onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</PrimaryBtn>
        <GhostBtn onClick={onCancel}>取消</GhostBtn>
      </div>
    </div>
  );
}

// ── 邀请码 ────────────────────────────────────────────────────────────

