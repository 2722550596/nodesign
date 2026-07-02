import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Sparkles, ArrowRight, X, Upload, Search } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { TEMPLATE_CATALOG, buildPrefillMessage } from '../lib/template-catalog.js';
import { timeAgo } from '../lib/helpers.js';

/**
 * TemplateMarket — Skill 市场（/templates）
 *
 * M1 范式：
 *   一张卡片 = 一组「skill + 预设风格 + 示例主题」（不是单 skill）
 *   同 skill 多 sample → 用户一眼看出"同 skill 出货差异巨大" portfolio 卖点
 *
 * 选用动线：
 *   卡片"使用此模板" → UseTemplateModal
 *     · compose 子页：编辑主题（默认 sampleTopic 占位，可改）
 *     · 两个出口：
 *         a) 新建项目 + 进入  → createProject(kind='project') + navigate work + state.initialMessage
 *         b) 选已有项目继续  → 切到 pickProject 子页 → 列已 hydrate 的 projects → navigate
 *
 * prefill 文案在 buildPrefillMessage 里组装，灌进 navigate state.initialMessage；
 * ProjectWorkspace mount 后 ~250ms 自动 send 首条 turn（沿用 Home QuickEntry 范式）。
 */
export default function TemplateMarket() {
  const [open, setOpen] = useState(null);  // null | template object

  return (
    <AppShell
      breadcrumb={[{ label: '/', href: '/' }, { label: 'Skill 市场' }]}
      actions={
        <Link to="/skills" style={iconBtnStyle}>
          <Upload size={14} /> 上传我的 skill
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
            }}>Skill 市场</h1>
          </div>
          <p style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2,
            lineHeight: 1.6, margin: 0, maxWidth: 640,
          }}>
            挑一个起手隐喻 / 风格作为出发点 — agent 会根据你的实际主题做内容的二次创作；
            同一个 skill 可以衍生出多种风格，所以即使从相同模板起手，最终也会做出风格完全不同的 deck。
          </p>
        </header>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: GAP.xl,
        }}>
          {TEMPLATE_CATALOG.map(t => (
            <TemplateCard key={t.id} template={t} onUse={() => setOpen(t)} />
          ))}
        </div>

        <div style={{
          marginTop: GAP.page,
          padding: `${GAP.lg}px ${GAP.xl}px`,
          background: COLOR.bgCard,
          border: `1px dashed ${COLOR.borderMd}`,
          borderRadius: 12,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          lineHeight: 1.65,
        }}>
          ⓘ 没看到想要的风格？模板背后是一个 SDK skill，
          你可以<Link to="/skills" style={{ color: COLOR.text2, textDecoration: 'underline' }}>上传自己的 skill plugin</Link>
          扩展橱窗，或<Link to="/" style={{ color: COLOR.text2, textDecoration: 'underline' }}>直接对话</Link>让 agent 自由发挥（不锁定 skill）。
        </div>
      </div>

      {open && (
        <UseTemplateModal
          template={open}
          onClose={() => setOpen(null)}
        />
      )}
    </AppShell>
  );
}

// ──────── TemplateCard ────────

function TemplateCard({ template, onUse }) {
  const [hover, setHover] = useState(false);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: '#fff',
        border: `1px solid ${hover ? COLOR.borderMd : COLOR.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: hover
          ? '0 12px 28px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.05)'
          : '0 1px 3px rgba(0,0,0,0.04)',
        transform: hover ? 'translateY(-3px)' : 'none',
        transition: 'all 0.28s cubic-bezier(0.25, 1, 0.5, 1)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <ThumbBox template={template} />

      <div style={{ padding: `${GAP.lg}px ${GAP.lg}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.sm, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs, flexWrap: 'wrap' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontFamily: FONT_MONO, fontSize: 10, color: template.accent || COLOR.brown,
            padding: '2px 7px',
            background: 'rgba(0,0,0,0.03)',
            borderRadius: 100,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: 3, background: template.accent || COLOR.brown }} />
            {template.styleTag}
          </span>
        </div>

        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 600,
          color: COLOR.text, letterSpacing: '-0.005em',
        }}>{template.title}</div>

        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          lineHeight: 1.55,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>{template.description}</div>

        <div style={{ display: 'flex', gap: GAP.xs, flexWrap: 'wrap', marginTop: 2 }}>
          {template.tags.map(t => (
            <span key={t} style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
              padding: '1px 7px',
              background: 'rgba(0,0,0,0.025)',
              borderRadius: 4,
            }}>{t}</span>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: GAP.sm, marginTop: GAP.sm,
        }}>
          <span style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }} title="模板背后的 skill">
            {template.skillName}
          </span>
          <button
            onClick={onUse}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              padding: `${GAP.xs + 1}px ${GAP.lg}px`,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
              color: COLOR.btnText, background: COLOR.btn,
              border: `1px solid ${COLOR.btn}`,
              borderRadius: 8,
              cursor: 'pointer',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = COLOR.btnHover}
            onMouseLeave={e => e.currentTarget.style.background = COLOR.btn}
          >
            使用此模板 <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────── ThumbBox ────────
// MVP placeholder：暖色 gradient + 风格 accent 描边 + title 排版预览。
// 等 4 个 brief 真图跑出来 → 替换为 <img src={template.thumb} />。

function ThumbBox({ template }) {
  if (template.thumb) {
    return (
      <div style={{ aspectRatio: '4 / 3', overflow: 'hidden', background: COLOR.bgCard }}>
        <img src={template.thumb} alt={template.title}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
    );
  }

  // Placeholder：用风格 accent 色合成的"假封面" — 区别于 4 张卡片，避免视觉雷同
  const accent = template.accent || COLOR.brown;
  const isSwiss = template.styleTag.includes('瑞士');

  return (
    <div style={{
      aspectRatio: '4 / 3',
      position: 'relative',
      background: isSwiss
        ? `linear-gradient(135deg, #fafaf6 0%, #f0f0eb 100%)`
        : `linear-gradient(135deg, #fdf8f0 0%, #f4ebdb 100%)`,
      overflow: 'hidden',
      borderBottom: `1px solid ${COLOR.borderLt}`,
    }}>
      {/* 瑞士风：网格点阵；杂志风：流体椭圆 */}
      {isSwiss ? (
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.35 }}>
          <defs>
            <pattern id={`grid-${template.id}`} width="14" height="14" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill={accent} opacity="0.4" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#grid-${template.id})`} />
        </svg>
      ) : (
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.28 }} viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
          <ellipse cx="80" cy="240" rx="200" ry="80" fill={accent} opacity="0.4" />
          <ellipse cx="340" cy="60" rx="160" ry="60" fill={accent} opacity="0.3" />
        </svg>
      )}

      {/* 假封面排版 */}
      <div style={{
        position: 'absolute', inset: 0,
        padding: '14% 12%',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      }}>
        <div style={{
          fontFamily: isSwiss ? FONT_SANS : "'Georgia', 'Noto Serif SC', serif",
          fontSize: FONT_SIZE.xs, color: accent, fontWeight: 600,
          letterSpacing: isSwiss ? '0.12em' : '0',
          textTransform: isSwiss ? 'uppercase' : 'none',
        }}>
          {isSwiss ? 'SAMPLE' : '— 样例 —'}
        </div>
        <div style={{
          fontFamily: isSwiss ? FONT_SANS : "'Georgia', 'Noto Serif SC', serif",
          fontSize: isSwiss ? 22 : 20,
          fontWeight: isSwiss ? 700 : 500,
          color: '#2a2418',
          lineHeight: 1.2,
          letterSpacing: isSwiss ? '-0.01em' : '0',
          textAlign: isSwiss ? 'left' : 'left',
        }}>
          {template.sampleTopic}
        </div>
        <div style={{
          fontFamily: FONT_MONO,
          fontSize: 9, color: COLOR.sub,
          opacity: 0.7,
        }}>
          waiting for real preview · {template.skillName}
        </div>
      </div>
    </div>
  );
}

// ──────── UseTemplateModal ────────

function UseTemplateModal({ template, onClose }) {
  const navigate = useNavigate();
  const showToast = useGlobalStore(s => s.showToast);
  const createProject = useProjectStore(s => s.createProject);
  const projects = useProjectStore(s => s.projects);
  const hydrated = useProjectStore(s => s.hydrated);
  const hydrate = useProjectStore(s => s.hydrate);

  const [mode, setMode] = useState('compose');  // 'compose' | 'pickProject'
  const [topic, setTopic] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  // pickProject 模式：lazy hydrate（如果用户没去过 Home 还没拉过 projects）
  useEffect(() => {
    if (mode === 'pickProject' && !hydrated) {
      hydrate({ kind: 'project' }).catch(() => {});
    }
  }, [mode, hydrated, hydrate]);

  const launchInNewProject = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const projName = (topic.trim() || template.sampleTopic).slice(0, 40);
      const proj = await createProject({
        name: projName,
        kind: 'project',
        description: `${template.styleTag} · 来自 Skill 市场`,
      });
      const initialMessage = buildPrefillMessage(template, topic);
      navigate(`/projects/${proj.id}/work`, { state: { initialMessage } });
    } catch (err) {
      showToast(`创建项目失败：${err.message}`, 'error');
      setSubmitting(false);
    }
  };

  const launchInExistingProject = (projectId) => {
    const initialMessage = buildPrefillMessage(template, topic);
    navigate(`/projects/${projectId}/work`, { state: { initialMessage } });
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.35)',
        backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 600,
        padding: GAP.xl,
      }}
    >
      <div style={{
        background: COLOR.bgModal,
        borderRadius: 16,
        width: '100%',
        maxWidth: 520,
        maxHeight: '85vh',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
      }}>
        {/* 顶部 — 模板标识 + 关闭 */}
        <div style={{
          padding: `${GAP.lg}px ${GAP.xl}px`,
          borderBottom: `1px solid ${COLOR.borderLt}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: GAP.lg,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginBottom: 2 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontFamily: FONT_MONO, fontSize: 10,
                color: template.accent || COLOR.brown,
                padding: '2px 7px',
                background: 'rgba(0,0,0,0.03)',
                borderRadius: 100,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: 3, background: template.accent || COLOR.brown }} />
                {template.styleTag}
              </span>
            </div>
            <div style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600,
              color: COLOR.text, marginTop: 4,
            }}>{template.title}</div>
          </div>
          <button
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            style={{
              width: 28, height: 28, borderRadius: 14,
              background: 'transparent', border: 'none',
              color: COLOR.sub, cursor: submitting ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {mode === 'compose' ? (
          <ComposeBody
            template={template}
            topic={topic}
            setTopic={setTopic}
            submitting={submitting}
            onLaunchNew={launchInNewProject}
            onPickProject={() => setMode('pickProject')}
          />
        ) : (
          <PickProjectBody
            projects={projects}
            hydrated={hydrated}
            onBack={() => setMode('compose')}
            onPick={launchInExistingProject}
          />
        )}
      </div>
    </div>
  );
}

function ComposeBody({ template, topic, setTopic, submitting, onLaunchNew, onPickProject }) {
  return (
    <>
      <div style={{
        padding: `${GAP.xl}px ${GAP.xl}px ${GAP.lg}px`,
        flex: 1, overflow: 'auto',
      }}>
        <label style={{
          display: 'block',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3,
          marginBottom: GAP.sm, fontWeight: 500,
        }}>
          我的主题
          <span style={{ marginLeft: GAP.sm, color: COLOR.sub, fontWeight: 400 }}>
            (留空走样例主题)
          </span>
        </label>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={template.sampleTopic}
          rows={3}
          disabled={submitting}
          autoFocus
          style={{
            width: '100%',
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 10,
            padding: `${GAP.md}px ${GAP.lg}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
            color: COLOR.text, lineHeight: 1.55,
            outline: 'none', resize: 'vertical',
            boxSizing: 'border-box',
            opacity: submitting ? 0.6 : 1,
          }}
        />
        <div style={{
          marginTop: GAP.md,
          padding: `${GAP.sm}px ${GAP.lg}px`,
          background: 'rgba(0,0,0,0.025)',
          borderRadius: 8,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          lineHeight: 1.55,
        }}>
          进入会话后会自动告诉 agent 用 skill <code style={{ fontFamily: FONT_MONO, color: COLOR.text3 }}>{template.skillName}</code> + 你的主题；agent 第一步会加载 skill 方法论。
        </div>
      </div>

      <div style={{
        padding: `${GAP.lg}px ${GAP.xl}px`,
        borderTop: `1px solid ${COLOR.borderLt}`,
        display: 'flex', gap: GAP.sm, justifyContent: 'flex-end',
      }}>
        <button
          onClick={onPickProject}
          disabled={submitting}
          style={{
            padding: `${GAP.sm + 1}px ${GAP.xl}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
            color: COLOR.text2,
            background: 'transparent',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 8,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          选已有项目
        </button>
        <button
          onClick={onLaunchNew}
          disabled={submitting}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.sm + 1}px ${GAP.xl}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
            color: COLOR.btnText, background: COLOR.btn,
            border: `1px solid ${COLOR.btn}`,
            borderRadius: 8,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? '创建中…' : <>新建项目并开始 <ArrowRight size={13} /></>}
        </button>
      </div>
    </>
  );
}

function PickProjectBody({ projects, hydrated, onBack, onPick }) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(p => (p.name || '').toLowerCase().includes(q));
  }, [projects, filter]);

  return (
    <>
      <div style={{
        padding: `${GAP.lg}px ${GAP.xl}px ${GAP.md}px`,
        borderBottom: `1px solid ${COLOR.borderLt}`,
      }}>
        <div style={{ position: 'relative' }}>
          <Search
            size={14}
            color={COLOR.sub}
            style={{ position: 'absolute', top: '50%', left: 10, transform: 'translateY(-50%)' }}
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按项目名筛选…"
            autoFocus
            style={{
              width: '100%',
              padding: `${GAP.sm + 1}px ${GAP.lg}px ${GAP.sm + 1}px 32px`,
              background: '#fff',
              border: `1px solid ${COLOR.borderMd}`,
              borderRadius: 8,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
              color: COLOR.text, outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: `${GAP.sm}px ${GAP.md}px ${GAP.md}px` }}>
        {!hydrated ? (
          <div style={{
            padding: `${GAP.page}px ${GAP.xl}px`,
            textAlign: 'center',
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          }}>加载项目中…</div>
        ) : visible.length === 0 ? (
          <div style={{
            padding: `${GAP.xxl}px ${GAP.xl}px`,
            textAlign: 'center',
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, lineHeight: 1.6,
          }}>
            {projects.length === 0
              ? '还没有项目。点「新建项目并开始」 →'
              : '没有匹配的项目。'}
          </div>
        ) : (
          visible.map(p => (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: `${GAP.md}px ${GAP.lg}px`,
                background: 'transparent',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                marginBottom: 2,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.035)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: GAP.md,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, fontWeight: 500,
                    color: COLOR.text,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{p.name}</div>
                  {p.description && (
                    <div style={{
                      fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                      marginTop: 2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{p.description}</div>
                  )}
                </div>
                <span style={{
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                  flexShrink: 0,
                }}>
                  {p.updatedAt ? timeAgo(p.updatedAt) : ''}
                </span>
              </div>
            </button>
          ))
        )}
      </div>

      <div style={{
        padding: `${GAP.md}px ${GAP.xl}px`,
        borderTop: `1px solid ${COLOR.borderLt}`,
        display: 'flex', justifyContent: 'flex-start',
      }}>
        <button
          onClick={onBack}
          style={{
            padding: `${GAP.sm}px ${GAP.lg}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
            color: COLOR.text2,
            background: 'transparent',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          ← 返回
        </button>
      </div>
    </>
  );
}

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
  padding: `${GAP.sm}px ${GAP.lg}px`,
  borderRadius: 8,
  background: 'transparent',
  textDecoration: 'none',
};
