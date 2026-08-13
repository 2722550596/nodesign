/**
 * SitePublishControl — 站点窗头部的「上线」控件（2026-08-02）
 *
 * 三态：未发布（上线按钮，两击确认 —— 发到公网是外发动作）→ 发布中（转圈，
 * deploy 同步等 30-90s）→ 已发布（绿点 + 链接 + 更新 / 下线）。
 * 下线同样两击确认。403（试用号 / 超额）直接把服务端的白话文案 toast 出来。
 *
 * ## 配色：墨面，不是纸面（2026-08-13）
 *
 * 它 08-13 从窗口头部的名牌条搬进了那条常驻工具栏，而工具栏是**墨色**的
 * （INK_SURFACE）。搬过去时只是塞了个纸色底的盒子把它裹住 —— 一条工具栏上
 * 两种物料，看着就是没做完。现在整个换到 INK_SURFACE 那套：底色透明、字用
 * 墙色、hover 用同一档半透明白。
 *
 * 唯一保留的彩色是**状态色**：已发布那颗绿点、下线确认那一下的红。
 * 它们不是装饰，是"这东西现在在公网上"和"你正要把它撤下来"。
 */

import { useEffect, useRef, useState } from 'react';
import { Rocket, ExternalLink, Copy, RefreshCw, CloudOff, Loader2 } from 'lucide-react';
import { GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { INK_SURFACE } from '../../lib/paper.js';
import { Publish } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

export default function SitePublishControl({ projectId, task }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [site, setSite] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);       // 发布/下线进行中
  const [confirm, setConfirm] = useState(null);  // 'publish' | 'unpublish' | null
  const confirmTimer = useRef(null);

  useEffect(() => {
    let alive = true;
    Publish.get(projectId, task)
      .then(d => { if (alive) { setSite(d.site); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [projectId, task]);

  useEffect(() => () => clearTimeout(confirmTimer.current), []);
  const arm = (kind) => {
    setConfirm(kind);
    clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirm(null), 3500);
  };

  const doPublish = async () => {
    setConfirm(null);
    setBusy(true);
    try {
      const { site: s, warning } = await Publish.publish(projectId, task);
      setSite(s);
      showToast(`已上线：${s.url}（新站点子域名生效可能要等一两分钟）${warning ? ` · ${warning}` : ''}`, 'success');
    } catch (err) {
      showToast(err.message || '发布失败', 'error');
    }
    setBusy(false);
  };

  const doUnpublish = async () => {
    setConfirm(null);
    setBusy(true);
    try {
      await Publish.unpublish(projectId, task);
      setSite(null);
      showToast('已下线，公网地址即刻失效', 'success');
    } catch (err) {
      showToast(err.message || '下线失败', 'error');
    }
    setBusy(false);
  };

  const copyUrl = () => {
    navigator.clipboard?.writeText(site.url)
      .then(() => showToast('地址已复制', 'success'))
      .catch(() => showToast(site.url, 'info'));
  };

  if (!loaded) return null;

  if (busy) {
    return (
      <span style={{ ...pill, color: INK_SURFACE.textDim }}>
        <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
        <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
        {site ? '更新中…' : '上线中…'}
      </span>
    );
  }

  if (!site) {
    return confirm === 'publish' ? (
      <button onClick={doPublish} style={{ ...pill, background: INK_SURFACE.active, color: INK_SURFACE.activeText, border: 0, cursor: 'pointer' }}>
        <Rocket size={11} /> 确认发到公网？
      </button>
    ) : (
      <button
        onClick={() => arm('publish')}
        title="发布到 Cloudflare Pages，任何人可访问"
        style={{ ...pill, background: 'transparent', border: `1px solid ${INK_SURFACE.hair}`, color: INK_SURFACE.text, cursor: 'pointer' }}
      >
        <Rocket size={11} /> 上线
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.xxs }}>
      <a
        href={site.url} target="_blank" rel="noreferrer"
        title={site.url}
        style={{
          ...pill, textDecoration: 'none', color: INK_SURFACE.text,
          background: 'rgba(120,190,120,0.16)', maxWidth: 190,
        }}
      >
        {/* 状态色留着：这颗绿点说的是「它现在在公网上」，不是装饰 */}
        <span style={{ width: 6, height: 6, borderRadius: RADIUS.round, background: '#6FBF6F', flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT_MONO }}>
          {site.url.replace(/^https:\/\//, '')}
        </span>
        <ExternalLink size={10} style={{ flexShrink: 0 }} />
      </a>
      <MiniBtn title="复制地址" onClick={copyUrl}><Copy size={11} /></MiniBtn>
      <MiniBtn title="把当前版本重新发布（地址不变）" onClick={doPublish}><RefreshCw size={11} /></MiniBtn>
      {confirm === 'unpublish' ? (
        <button onClick={doUnpublish} style={{ ...pill, background: '#C0504A', color: INK_SURFACE.text, border: 0, cursor: 'pointer' }}>
          确认下线？
        </button>
      ) : (
        <MiniBtn title="下线（公网地址失效）" danger onClick={() => arm('unpublish')}><CloudOff size={11} /></MiniBtn>
      )}
    </span>
  );
}

const pill = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '3px 9px', borderRadius: RADIUS.pill,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
};

function MiniBtn({ children, title, onClick, danger }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 22, height: 22, borderRadius: RADIUS.md,
        background: 'transparent', border: 0, cursor: 'pointer',
        color: danger ? '#E08A82' : INK_SURFACE.text,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = INK_SURFACE.hover; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >{children}</button>
  );
}
