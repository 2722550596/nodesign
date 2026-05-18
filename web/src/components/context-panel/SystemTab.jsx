import { useState, useEffect, useCallback, useRef } from 'react';
import { Upload, Trash2, BookOpen, Box } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useProjectStore } from '../../stores/projectStore.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Plugins } from '../../lib/api.js';

/**
 * System tab — 当前 session 的 skill / plugin / DS / model 显示 + spec 摘要 + project 级 plugin 上传
 *
 * 数据源：
 *   - systemInfo（来自 SDK run.system_init，projectStore 已缓存）
 *     → skills 数组 + plugins 数组 + model + cwd
 *   - project 级 plugin 列表（GET /api/projects/:pid/plugins）独立调
 *
 * 操作：
 *   - 上传 zip 到 project 级（POST /api/projects/:pid/plugins/install）
 *   - 卸载 project 级 plugin（DELETE /api/projects/:pid/plugins/:name）
 *   - 新 session 才生效（v1 不做 hot-reload）
 *
 * 全局/用户级 plugin 管理走单独的 /skills 页面（不在本 panel）。
 */
export default function SystemTab({ project, deckSpec, projectId }) {
  const systemInfo = useProjectStore(s => s.contextByProject[projectId]?.systemInfo || null);
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);

  const [projectPlugins, setProjectPlugins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { plugins } = await Plugins.listProject(projectId);
      setProjectPlugins(plugins || []);
    } catch (err) {
      console.error('[SystemTab] listProject plugins failed:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpload = useCallback(async (file, force = false) => {
    if (!file || !projectId) return;
    setUploading(true);
    try {
      const result = await Plugins.installProject(projectId, file, { force });
      const name = result?.installed?.name;
      showToast(`已装 plugin \`${name}\`（新会话生效）`, 'success');
      if (result?.warnings?.length) {
        showToast(`警告：${result.warnings.join('；')}`, 'warn');
      }
      await refresh();
    } catch (err) {
      // 409 → 二次确认覆盖
      if (err.status === 409 && err.body?.existing) {
        const ok = await confirm({
          title: '覆盖已装 plugin？',
          message: `已装 \`${err.body.existing.name}@${err.body.existing.version}\`，将覆盖为 \`${err.body.incoming.name}@${err.body.incoming.version}\`。`,
          confirmLabel: '覆盖',
          cancelLabel: '取消',
          danger: true,
        });
        if (ok) {
          await handleUpload(file, true);
        }
        return;
      }
      const detail = err.body?.errors?.length ? `：${err.body.errors.join('；')}` : '';
      showToast(`安装失败${detail || `：${err.message}`}`, 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [projectId, refresh, showToast, confirm]);

  const handleUninstall = useCallback(async (name) => {
    const ok = await confirm({
      title: '卸载 plugin？',
      message: `从 project 移除 \`${name}\`（新会话生效）。文件会被删除。`,
      confirmLabel: '卸载',
      cancelLabel: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await Plugins.removeProject(projectId, name);
      showToast(`已卸载 \`${name}\``, 'success');
      await refresh();
    } catch (err) {
      showToast(`卸载失败：${err.message}`, 'error');
    }
  }, [projectId, refresh, showToast, confirm]);

  // systemInfo 里 skills 可能是 [{name, source, tokens}] 或字符串数组，双兼容
  const sessionSkills = Array.isArray(systemInfo?.skills)
    ? systemInfo.skills.map(s => (typeof s === 'string' ? s : (s.name || s.id))).filter(Boolean)
    : [];
  const sessionPlugins = Array.isArray(systemInfo?.plugins)
    ? systemInfo.plugins.map(p => (typeof p === 'string' ? p : (p.name || p.id))).filter(Boolean)
    : [];

  return (
    <div style={{ padding: GAP.lg, display: 'flex', flexDirection: 'column', gap: GAP.xl }}>

      <Section label="本会话的 Skills">
        {sessionSkills.length === 0 ? (
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
            （等会话起动后从 SDK system_init 拉取）
          </span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.xs }}>
            {sessionSkills.map(name => (
              <Chip key={name} icon={BookOpen} label={name} />
            ))}
          </div>
        )}
      </Section>

      <Section label="本会话的 Plugins">
        {sessionPlugins.length === 0 ? (
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>—</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.xs }}>
            {sessionPlugins.map(name => (
              <Chip key={name} icon={Box} label={name} />
            ))}
          </div>
        )}
      </Section>

      <Section label="Project 级 Plugins">
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs, marginBottom: GAP.sm }}>
          {loading && projectPlugins.length === 0 ? (
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
              加载中…
            </span>
          ) : projectPlugins.length === 0 ? (
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
              暂无（上传 zip 安装到本 project）
            </span>
          ) : (
            projectPlugins.map(p => (
              <ProjectPluginRow key={p.name} plugin={p} onUninstall={() => handleUninstall(p.name)} />
            ))
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.zip,application/zip,text/markdown,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs + 1}px ${GAP.md}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
            color: COLOR.text2,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 6,
            cursor: uploading ? 'not-allowed' : 'pointer',
            opacity: uploading ? 0.6 : 1,
          }}
        >
          <Upload size={11} /> {uploading ? '安装中…' : '上传 skill / plugin'}
        </button>
        <div style={{
          marginTop: GAP.xs,
          fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, lineHeight: 1.5,
        }}>
          支持单 .md / skill zip / 完整 plugin zip。仅装到本 project；全局可见的走右上角 Skill 页面。新会话生效。
        </div>
      </Section>

      <Section label="模型">
        <KV k="LLM" v={systemInfo?.model || '—'} />
        {systemInfo?.cwd && <KV k="cwd" v={systemInfo.cwd} />}
      </Section>

      {/* Spec 摘要 */}
      {deckSpec && (
        <Section label="设计意图（spec）">
          <KV k="metaphor" v={deckSpec.meta?.metaphor || '—'} />
          <KV k="audience" v={deckSpec.meta?.audience || '—'} />
          {deckSpec.meta?.intent && (
            <div style={{
              marginTop: GAP.sm,
              padding: GAP.md,
              background: COLOR.bgCard,
              border: `1px solid ${COLOR.borderLt}`,
              borderRadius: 6,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
              color: COLOR.text2, lineHeight: 1.6,
            }}>
              {deckSpec.meta.intent}
            </div>
          )}

          {/* outline */}
          {deckSpec.outline && deckSpec.outline.length > 0 && (
            <>
              <div style={{
                marginTop: GAP.lg,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                marginBottom: GAP.sm,
              }}>页面 outline ({deckSpec.outline.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
                {deckSpec.outline.map(p => (
                  <div key={p.id} style={{
                    padding: `${GAP.xs + 1}px ${GAP.md}px`,
                    fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                    background: 'rgba(0,0,0,0.025)',
                    borderRadius: 4,
                    display: 'flex', gap: GAP.sm, alignItems: 'baseline',
                  }}>
                    <span style={{ fontFamily: FONT_MONO, color: COLOR.sub, minWidth: 24 }}>{String(p.index).padStart(2, '0')}</span>
                    <span style={{ color: COLOR.text3, minWidth: 64, fontFamily: FONT_MONO, fontSize: 10, textTransform: 'uppercase' }}>{p.layout}</span>
                    <span style={{ color: COLOR.text2, flex: 1, lineHeight: 1.4 }}>{p.intent}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      )}
    </div>
  );
}

function ProjectPluginRow({ plugin, onUninstall }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: GAP.sm,
      padding: `${GAP.xs + 1}px ${GAP.sm}px`,
      background: 'rgba(0,0,0,0.025)',
      borderRadius: 4,
    }}>
      <Box size={11} color={COLOR.text4} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.xs }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text2 }}>
            {plugin.name}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
            {plugin.version}
          </span>
          <span style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub }}>
            · {plugin.skills?.length || 0} skill
          </span>
        </div>
        {plugin.description && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, lineHeight: 1.4,
            marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={plugin.description}>
            {plugin.description}
          </div>
        )}
      </div>
      <button
        onClick={onUninstall}
        title="卸载"
        style={{
          background: 'transparent', border: 'none',
          color: COLOR.sub, cursor: 'pointer',
          padding: 2,
        }}
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

function Chip({ icon: Icon, label }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: `2px ${GAP.sm}px`,
      fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
      color: COLOR.text2,
      background: 'rgba(0,0,0,0.04)',
      borderRadius: 100,
    }}>
      <Icon size={10} color={COLOR.text4} />
      {label}
    </span>
  );
}

function Section({ label, children }) {
  return (
    <div>
      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        textTransform: 'uppercase', letterSpacing: '0.05em',
        marginBottom: GAP.sm,
      }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
        {children}
      </div>
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div style={{
      display: 'flex',
      gap: GAP.md,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
    }}>
      <span style={{ color: COLOR.sub, minWidth: 70 }}>{k}</span>
      <span style={{ color: COLOR.text2, flex: 1, wordBreak: 'break-word' }}>{v}</span>
    </div>
  );
}
