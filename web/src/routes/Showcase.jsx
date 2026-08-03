import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Upload, Trash2, Store, ArrowRight } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { Me } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { timeAgo } from '../lib/helpers.js';

/**
 * Showcase — 个人作品橱窗（/gallery，替掉原来的假模板市场）
 *
 * 老的 /templates 是四张硬编码卡片，指着一个根本没装的 skill，封面全是
 * "waiting for real preview"，而且它的前提（先给你一个预设风格）跟现在 skill
 * 的方法论正相反——deskskill 说的是"形态和风格都跟用户探索出来，不预设范式"。
 *
 * 这一页反过来：卡片是**你自己做出来的东西**，每张背后绑着从那次探索里固化出来的
 * skill（agent 调 crystallize_skill 产生）。第一次仍然从问题长出骨架，第二次开始
 * 你有资格复用自己的结论。
 *
 * 市场（下别人发布的 skill）先留入口不开：SKILL.md 会整段进 agent 上下文，等于
 * 让陌生人往你的会话里写指令，得先有发布审核和可见范围才能开。
 */
export default function Showcase() {
  const [entries, setEntries] = useState(null);   // null = 加载中
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);

  useEffect(() => {
    let dead = false;
    Me.showcase()
      .then(({ entries: list = [] }) => { if (!dead) setEntries(list); })
      .catch(() => { if (!dead) setEntries([]); });
    return () => { dead = true; };
  }, []);

  const handleRemove = async (entry) => {
    if (!(await confirm({
      title: '移出橱窗',
      message: `把「${entry.title}」从橱窗里拿掉？作品本身和 skill 都还在，只是不在这里展示。`,
      confirmLabel: '移出',
      danger: true,
    }))) return;
    try {
      await Me.removeShowcase(entry.id);
      setEntries(list => list.filter(e => e.id !== entry.id));
      showToast('已移出橱窗', 'info');
    } catch (err) {
      showToast(`移出失败：${err.message}`, 'error');
    }
  };

  return (
    <AppShell
      breadcrumb={[{ label: '我的橱窗' }]}
      actions={
        <Link to="/skills" style={iconBtnStyle}>
          <Upload size={14} /> Skill 管理
        </Link>
      }
    >
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>
        <header style={{ marginBottom: GAP.xxl + 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginBottom: GAP.sm }}>
            <Sparkles size={18} color={COLOR.gold} />
            <h1 style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
              color: COLOR.text, letterSpacing: '-0.01em', margin: 0,
            }}>我的橱窗</h1>
          </div>
          <p style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2,
            lineHeight: 1.6, margin: 0, maxWidth: 680,
          }}>
            做完并且你想留下的东西放在这里，每件背后绑着那次探索固化出来的 skill。
            下次开新会话点名这个 skill，agent 会带着当初的判断依据起手，而不是从零猜。
          </p>
        </header>

        {entries === null ? (
          <div style={loadingStyle}>加载中…</div>
        ) : entries.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: GAP.xl,
          }}>
            {entries.map(e => (
              <ShowcaseCard key={e.id} entry={e} onRemove={() => handleRemove(e)} />
            ))}
          </div>
        )}

        <MarketPlaceholder />
      </div>
    </AppShell>
  );
}

function EmptyState() {
  return (
    <div style={{
      padding: `${GAP.page}px ${GAP.xl}px`,
      background: COLOR.bgCard,
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: RADIUS.xxl,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
      lineHeight: 1.75, maxWidth: 680,
    }}>
      <div style={{ fontWeight: 500, color: COLOR.text, marginBottom: GAP.sm }}>橱窗还是空的</div>
      做完一件你满意的东西之后，跟 agent 说一句「把这套风格留下来」——
      它会把这次探索的判断依据（为什么这个字号阶梯、你否掉了什么、这套气质在什么场合会失效）
      写成一个你自己的 skill，作品连同这个 skill 一起进橱窗。
      <div style={{ marginTop: GAP.md, color: COLOR.sub, fontSize: FONT_SIZE.xs }}>
        注意它收的是方法论不是成品：存成品是模板，换个主题就崩；存判断依据才谈得上复用。
      </div>
    </div>
  );
}

function ShowcaseCard({ entry, onRemove }) {
  const [hover, setHover] = useState(false);
  const [noCover, setNoCover] = useState(false);
  const workHref = entry.projectAlive ? `/projects/${entry.projectId}/work` : null;

  const cover = (
    <div style={{
      aspectRatio: '16 / 10',
      background: COLOR.bgCard,
      overflow: 'hidden',
      borderBottom: `1px solid ${COLOR.borderLt}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {noCover ? (
        <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.dim }}>
          {entry.projectAlive ? '封面生成中' : '原项目已删除'}
        </span>
      ) : (
        <img
          src={Me.showcaseCoverUrl(entry.id)}
          alt={entry.title}
          loading="lazy"
          onLoad={(e) => { if (!e.currentTarget.naturalWidth) setNoCover(true); }}
          onError={() => setNoCover(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top', display: 'block' }}
        />
      )}
    </div>
  );

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: COLOR.bgWhite,
        border: `1px solid ${hover ? COLOR.borderMd : COLOR.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: hover
          ? '0 12px 28px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.05)'
          : '0 1px 3px rgba(0,0,0,0.04)',
        transform: hover ? 'translateY(-3px)' : 'none',
        transition: 'all 0.28s cubic-bezier(0.25, 1, 0.5, 1)',
        display: 'flex', flexDirection: 'column',
        position: 'relative',
      }}
    >
      {workHref ? <Link to={workHref} style={{ display: 'block' }}>{cover}</Link> : cover}

      <div style={{ padding: `${GAP.lg}px ${GAP.lg}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.sm, flex: 1 }}>
        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 600,
          color: COLOR.text, letterSpacing: '-0.005em',
        }}>{entry.title}</div>

        {entry.note && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, lineHeight: 1.55,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{entry.note}</div>
        )}

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: GAP.sm, marginTop: GAP.sm }}>
          {entry.skillName ? (
            <span title="这件作品沉淀出来的 skill" style={{
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.brown,
              padding: `${GAP.xxs}px 7px`, background: 'rgba(0,0,0,0.03)', borderRadius: RADIUS.pill,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%',
            }}>
              <span style={{ width: 5, height: 5, borderRadius: RADIUS.xs, background: COLOR.brown, flexShrink: 0 }} />
              {entry.skillName}
            </span>
          ) : <span />}
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, flexShrink: 0 }}>
            {entry.createdAt ? timeAgo(entry.createdAt) : ''}
          </span>
        </div>
      </div>

      {hover && (
        <button
          onClick={onRemove}
          title="移出橱窗"
          style={{
            position: 'absolute', top: GAP.sm, right: GAP.sm,
            width: 26, height: 26, borderRadius: 13,
            background: 'rgba(255,255,255,0.92)',
            border: `1px solid ${COLOR.border}`,
            color: COLOR.sub, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        ><Trash2 size={12} /></button>
      )}
    </div>
  );
}

/** 市场入口：先占位不开（理由写在卡片里，别让人以为是忘了做） */
function MarketPlaceholder() {
  return (
    <div style={{
      marginTop: GAP.page,
      padding: `${GAP.xl}px`,
      background: COLOR.bgCard,
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: RADIUS.xxl,
      display: 'flex', alignItems: 'flex-start', gap: GAP.lg,
    }}>
      <Store size={18} color={COLOR.sub} style={{ flexShrink: 0, marginTop: GAP.xxs }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, fontWeight: 600,
          color: COLOR.text2, marginBottom: GAP.xs,
          display: 'flex', alignItems: 'center', gap: GAP.sm,
        }}>
          Skill 市场
          <span style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 400, color: COLOR.sub,
            padding: '1px 7px', background: 'rgba(0,0,0,0.04)', borderRadius: RADIUS.pill,
          }}>还没开</span>
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, lineHeight: 1.65 }}>
          发布自己的 skill、下别人的来用。开之前要先解决一件事：SKILL.md 会整段进 agent 的
          上下文，等于让陌生人往你的会话里写指令——得有发布审核和可见范围才敢开。
          现在要给朋友，先用 <Link to="/skills" style={{ color: COLOR.text2, textDecoration: 'underline' }}>Skill 管理</Link> 页导出/上传文件互传。
        </div>
      </div>
      <ArrowRight size={14} color={COLOR.dim} style={{ flexShrink: 0, marginTop: GAP.xs }} />
    </div>
  );
}

const loadingStyle = {
  padding: `${GAP.page}px ${GAP.xl}px`,
  textAlign: 'center',
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
};

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
  padding: `${GAP.sm}px ${GAP.lg}px`,
  borderRadius: RADIUS.lg,
  background: 'transparent',
  textDecoration: 'none',
};
