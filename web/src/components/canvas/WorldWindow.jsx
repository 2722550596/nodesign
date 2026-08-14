import { useState, useMemo, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Map as MapIcon, BookOpen, RotateCw, ExternalLink } from 'lucide-react';
import ArtifactWindow, { exportToolGroup } from './ArtifactWindow.jsx';
import WorldMap from './WorldMap.jsx';
import { Assets } from '../../lib/api.js';
import { joinRel } from '../../lib/paths.js';
import { versionOfFile } from '../../lib/file-versions.js';
import { COLOR, GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';

/**
 * WorldWindow —— 世界的那扇窗（2026-08-07）
 *
 * 在这之前 world 是三种产物里唯一没有窗的：画布卡片展开就地嵌一块 420px 高的
 * 地图，想看世界书得被踢去开那份 .md —— 等于「打开世界」这个动作在三种形态里
 * 有三种结果。
 *
 * 这扇窗给它补上，两个视图：
 *   - **地图**：WorldMap，跟卡片里嵌的是同一个组件（同一份画法，不做第二套）
 *   - **世界书**：世界.md 的正文，按文章排版读
 *
 * 地图仍然只读。角色在哪个地点不是布局属性，是世界状态本身（文件夹树），
 * 拖着换地方等于 mv —— 那是阶段 3 的事，不在这扇窗的职责里。
 */
export default function WorldWindow({
  projectId,
  task,
  base,
  entry = '世界.md',
  title,
  nodes = [],
  /** 服务端给的可导出格式 + 导出动作（2026-08-13 从顶栏搬进工具栏） */
  artifactExports = null, onExport = null,
  /** 工具组交给外层那条常驻工具栏（窗自己不渲工具栏了） */
  onToolbarGroups = null,
  fileVersions = null,
  onClose,
}) {
  const [tab, setTab] = useState('map');
  const [reloadKey, setReloadKey] = useState(0);
  const [book, setBook] = useState(null);

  // 同 SiteWindow：根上的世界 base 是空串，老 `tasks/` 兜底在扁平世界是错路径
  const baseRel = base || task || '';
  const bookPath = joinRel(baseRel, entry);
  const bookVersion = versionOfFile(fileVersions, bookPath);

  // 世界书按需拉：进这扇窗多数时候是来看地图的
  useEffect(() => {
    if (tab !== 'book') return;
    let cancelled = false;
    setBook(null);
    fetch(`${Assets.artifactFileUrl(projectId, bookPath)}?v=${bookVersion}-${reloadKey}`)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(t => { if (!cancelled) setBook(t); })
      .catch(() => { if (!cancelled) setBook(`还没有 ${entry}。世界的设定写在这份文件里。`); });
    return () => { cancelled = true; };
  }, [tab, projectId, bookPath, bookVersion, reloadKey, entry]);

  const counts = useMemo(() => {
    const list = nodes || [];
    // 容器不算地点（收纳态，设计上明确不是地点）—— 口径跟服务端 describe()
    // 和画布卡片上那行字保持一致，三处对不上会像 bug
    return {
      places: list.filter(n => n.type === 'place').length,
      chars: list.filter(n => n.type === 'character').length,
    };
  }, [nodes]);

  const groups = [
    exportToolGroup({ kind: 'world', exports: artifactExports, onExport }),
    {
      id: 'mode',
      type: 'mode',
      value: tab,
      onChange: setTab,
      items: [
        { id: 'map', icon: MapIcon, label: '地图', title: '谁此刻在哪儿' },
        { id: 'book', icon: BookOpen, label: '世界书', title: entry },
      ],
    },
    {
      id: 'actions',
      items: [
        { id: 'reload', icon: RotateCw, title: '刷新', onClick: () => setReloadKey(k => k + 1) },
        {
          id: 'open', icon: ExternalLink, title: '在新标签页打开世界书',
          onClick: () => window.open(Assets.artifactFileUrl(projectId, bookPath), '_blank', 'noopener'),
        },
      ],
    },
  ].filter(Boolean);   // 没有导出格式时那一组是 null

  return (
    <ArtifactWindow
      kind="world"
      title={title || task}
      subtitle={nodes.length ? `${counts.places} 个地点 · ${counts.chars} 个角色` : '地图还是空的'}
      onClose={onClose}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
    >
      {tab === 'map' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: COLOR.bg }}>
          <WorldMap projectId={projectId} base={baseRel} nodes={nodes} />
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: COLOR.bg }}>
          <div style={{
            maxWidth: 720, margin: '0 auto', padding: `${GAP.xl}px ${GAP.lg}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.8,
          }}>
            {book === null
              ? <span style={{ color: COLOR.sub }}>读取中…</span>
              : <ReactMarkdown>{book}</ReactMarkdown>}
          </div>
        </div>
      )}
    </ArtifactWindow>
  );
}
