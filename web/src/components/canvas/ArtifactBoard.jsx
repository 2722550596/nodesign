import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Image as ImageIcon, FileText, Layers, Plus, ExternalLink, RefreshCw } from 'lucide-react';
import { Assets, Sessions } from '../../lib/api.js';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * ArtifactBoard —— 工作台产物墙（2026-07-27 v1）
 *
 * Lovart 式工作台的第一步：agent 产出的一切在这里成为可交互的物件。
 * v1 物件两类：
 *   - 图片（generated 生成图 + 上传素材）—— 单击加入上下文托盘（下一条消息
 *     作为 attachment 带给 agent，和 Lovart "点击物件进入对话上下文" 同语义），
 *     角标打开原图
 *   - deck 草稿（project 下的 sessions）—— 单击跳转到该 session 继续迭代
 *
 * 未来扩展（数据模型已预留 kind 字段）：灵感便签 / 视频关键帧 / 文案块 /
 * 拼接时序 / 视频成品。加 kind 就是加一种卡片渲染。
 *
 * 数据源：GET /:pid/artifacts（文件系统即真相）+ Sessions.list。
 * refreshToken 变化时重拉（ProjectWorkspace 在 run.image_generated /
 * run.file_changed 时 bump reloadToken，正好复用）。
 */
export default function ArtifactBoard({ projectId, currentSessionId, refreshToken, onAddToContext }) {
  const navigate = useNavigate();
  const [artifacts, setArtifacts] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addedPaths, setAddedPaths] = useState(() => new Set());

  const reload = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        Assets.artifacts(projectId).catch(() => ({ artifacts: [] })),
        Sessions.list(projectId, { limit: 24 }).catch(() => ({ sessions: [] })),
      ]);
      setArtifacts(Array.isArray(a?.artifacts) ? a.artifacts : []);
      setSessions(Array.isArray(s?.sessions) ? s.sessions : []);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { reload(); }, [reload, refreshToken]);

  const handleAdd = (item) => {
    if (!onAddToContext) return;
    onAddToContext({
      type: 'asset',
      path: item.path,
      name: item.name,
      size: item.size,
      mime: item.ext === '.png' ? 'image/png'
        : item.ext === '.webp' ? 'image/webp'
        : item.ext === '.gif' ? 'image/gif'
        : item.ext === '.svg' ? 'image/svg+xml'
        : item.ext === '.pdf' ? 'application/pdf'
        : 'image/jpeg',
    });
    setAddedPaths(prev => new Set(prev).add(item.path));
  };

  const thumbSrc = (item) => {
    if (!item.isImage) return null;
    if (item.hasThumb) {
      const base = item.name.replace(/\.[^.]+$/, '');
      return Assets.artifactFileUrl(projectId, `assets/generated/.thumbnails/${base}.thumb.jpg`);
    }
    return Assets.artifactFileUrl(projectId, item.path);
  };

  const images = artifacts.filter(a => a.isImage);
  const others = artifacts.filter(a => !a.isImage);

  return (
    <div style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      background: COLOR.bg,
      padding: GAP.page,
    }}>
      {/* deck 草稿区 */}
      <SectionTitle icon={Layers} label="DECK 草稿" count={sessions.length} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: GAP.lg, marginBottom: GAP.page }}>
        {sessions.map((s) => {
          const sid = s.sessionId || s.id;
          const isCurrent = sid === currentSessionId;
          return (
            <div
              key={sid}
              onClick={() => { if (!isCurrent) navigate(`/projects/${projectId}/sessions/${sid}`); }}
              style={{
                padding: GAP.lg,
                borderRadius: 10,
                border: `1px solid ${isCurrent ? COLOR.text : COLOR.borderLt}`,
                background: COLOR.bgCard,
                cursor: isCurrent ? 'default' : 'pointer',
                display: 'flex', flexDirection: 'column', gap: GAP.xs,
              }}
            >
              <div style={{
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.md, fontWeight: 600,
                color: COLOR.text,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {s.customTitle || s.title || s.summary || s.firstPrompt || '未命名 deck'}
              </div>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
                {isCurrent ? '当前会话' : formatTime(s.lastModified || s.mtime)}
              </div>
            </div>
          );
        })}
        {sessions.length === 0 && !loading && <EmptyHint text="还没有 deck 草稿" />}
      </div>

      {/* 图片产物区 */}
      <SectionTitle icon={ImageIcon} label="图片产物" count={images.length} extra={
        <button onClick={reload} title="刷新" style={iconBtnStyle}><RefreshCw size={12} /></button>
      } />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: GAP.lg, marginBottom: GAP.page }}>
        {images.map((item) => {
          const added = addedPaths.has(item.path);
          return (
            <div
              key={item.path}
              onClick={() => handleAdd(item)}
              title={added ? '已加入上下文托盘' : '点击加入上下文，下一条消息带给 agent'}
              style={{
                borderRadius: 10, overflow: 'hidden',
                border: `1px solid ${added ? COLOR.text : COLOR.borderLt}`,
                background: COLOR.bgCard, cursor: 'pointer',
                display: 'flex', flexDirection: 'column',
                position: 'relative',
              }}
            >
              <div style={{ aspectRatio: '4 / 3', overflow: 'hidden', background: '#f4f2ee' }}>
                <img
                  src={thumbSrc(item)}
                  alt={item.name}
                  loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </div>
              <div style={{
                padding: `${GAP.xs}px ${GAP.sm}px`,
                display: 'flex', alignItems: 'center', gap: GAP.xs,
              }}>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 9, letterSpacing: '0.05em',
                  color: item.kind === 'generated' ? '#7c6f5a' : COLOR.sub,
                  border: `1px solid ${COLOR.borderLt}`, borderRadius: 4, padding: '1px 4px',
                  flexShrink: 0,
                }}>
                  {item.kind === 'generated' ? '生成' : '上传'}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }}>
                  {item.name}
                </span>
                <a
                  href={Assets.artifactFileUrl(projectId, item.path)}
                  target="_blank" rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title="打开原图"
                  style={{ color: COLOR.sub, display: 'flex', flexShrink: 0 }}
                >
                  <ExternalLink size={11} />
                </a>
              </div>
              {added && (
                <div style={{
                  position: 'absolute', top: 6, right: 6,
                  background: COLOR.text, color: COLOR.bg, borderRadius: 6,
                  fontFamily: FONT_MONO, fontSize: 9, padding: '2px 6px',
                  display: 'flex', alignItems: 'center', gap: 3,
                }}>
                  <Plus size={9} /> 已入托盘
                </div>
              )}
            </div>
          );
        })}
        {images.length === 0 && !loading && <EmptyHint text="还没有图片产物 —— agent 生成或你上传后会出现在这里" />}
      </div>

      {/* 其他文件（pdf / zip / 音视频等，v1 只列出）*/}
      {others.length > 0 && (
        <>
          <SectionTitle icon={FileText} label="其他文件" count={others.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
            {others.map((item) => (
              <a
                key={item.path}
                href={Assets.artifactFileUrl(projectId, item.path)}
                target="_blank" rel="noreferrer"
                style={{
                  display: 'flex', alignItems: 'center', gap: GAP.sm,
                  padding: `${GAP.xs}px ${GAP.sm}px`, borderRadius: 6,
                  border: `1px solid ${COLOR.borderLt}`, background: COLOR.bgCard,
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text,
                  textDecoration: 'none',
                }}
              >
                <FileText size={12} color={COLOR.sub} />
                {item.name}
                <span style={{ color: COLOR.sub, marginLeft: 'auto' }}>{formatSize(item.size)}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SectionTitle({ icon: Icon, label, count, extra }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: GAP.xs,
      marginBottom: GAP.sm,
      fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, letterSpacing: '0.08em',
      color: COLOR.sub,
    }}>
      <Icon size={12} />
      {label}
      <span style={{ opacity: 0.6 }}>({count})</span>
      {extra}
    </div>
  );
}

function EmptyHint({ text }) {
  return (
    <div style={{
      gridColumn: '1 / -1',
      padding: GAP.lg, borderRadius: 8,
      border: `1px dashed ${COLOR.borderLt}`,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
      textAlign: 'center',
    }}>
      {text}
    </div>
  );
}

const iconBtnStyle = {
  marginLeft: 'auto', border: 0, background: 'transparent',
  color: COLOR.sub, cursor: 'pointer', display: 'flex', padding: 2,
};

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}
