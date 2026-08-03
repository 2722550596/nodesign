import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Sparkles, Wrench, LayoutTemplate, MoreHorizontal, Copy, Trash2, Edit2, ArrowUp } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import CreateProjectModal from '../components/project/CreateProjectModal.jsx';
import ComposerTray from '../components/chat/ComposerTray.jsx';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Sessions, Assets } from '../lib/api.js';
import { timeAgo } from '../lib/helpers.js';

/**
 * Home 页 — 入口流程重构
 *
 * 两条通道：
 *   1. 大输入框（QuickEntry）— 一句话直接建真项目并进 Workspace（名字先垫后由会话摘要正名）
 *   2. 标准项目（CreateProjectModal）— 顶栏「+ 新建项目」 → Modal → Hub
 *
 * 三块内容（从上到下）：
 *   [QuickEntry]            ← 闪聊入口
 *   [最近闪聊 list]          ← kind=quick 的项目下的最近 sessions（Sessions.recent）
 *   [我的项目 grid]          ← kind=project 的项目（hydrate({ kind:'project' })）
 *                              卡片封面 = iframe(最新任务的首个产物)
 */
export default function Home() {
  const navigate = useNavigate();
  const projects = useProjectStore(s => s.projects);
  const hydrated = useProjectStore(s => s.hydrated);
  const hydrating = useProjectStore(s => s.hydrating);
  const error = useProjectStore(s => s.error);
  const hydrate = useProjectStore(s => s.hydrate);
  const [createOpen, setCreateOpen] = useState(false);
  // 空状态示例 chip → 预填顶部输入框（不直接发 turn：让用户看到内容、可改可删）
  const [prefill, setPrefill] = useState(null);   // { text, ts }

  useEffect(() => {
    if (!hydrated && !hydrating) {
      hydrate({ kind: 'project' }).catch(() => { /* error 由 store 记录 */ });
    }
  }, [hydrated, hydrating, hydrate]);

  const openCreate = () => setCreateOpen(true);

  return (
    <AppShell
      actions={
        <>
          <Link to="/gallery" style={iconBtnStyle}><LayoutTemplate size={14} /> 橱窗</Link>
          <Link to="/skills" style={iconBtnStyle}><Wrench size={14} /> Skill</Link>
          <button style={primaryBtnStyle} onClick={openCreate}>
            <Plus size={14} /> 新建项目
          </button>
        </>
      }
    >
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>

        {/* 闪聊入口 */}
        <section style={{ marginBottom: GAP.xxl }}>
          <QuickEntry prefill={prefill} />
        </section>

        {/* 最近闪聊（无内容时不显示）*/}
        <RecentQuickSection />

        {/* 我的项目 */}
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.lg }}>
            <h2 style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600,
              color: COLOR.text, letterSpacing: '-0.01em', margin: 0,
            }}>我的项目</h2>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
              {projects.length} 个项目
            </span>
          </div>

          {!hydrated && hydrating ? (
            <LoadingState />
          ) : error ? (
            <ErrorState message={error} onRetry={() => hydrate({ kind: 'project' }).catch(() => {})} />
          ) : projects.length === 0 ? (
            <EmptyState
              onCreate={openCreate}
              onPick={(text) => {
                setPrefill({ text, ts: Date.now() });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: GAP.lg,
            }}>
              {projects.map(p => <ProjectCard key={p.id} project={p} />)}
            </div>
          )}
        </section>
      </div>

      <CreateProjectModal
        show={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(proj) => {
          // 2026-07-27 起工作台是项目主页 —— 新建项目直接进画布
          navigate(`/projects/${proj.id}/work`);
        }}
      />
    </AppShell>
  );
}

// ── QuickEntry ── Home 顶部大输入框（闪聊入口）

/**
 * 随机问候语池。mount 时挑一条；按时间段（早/午/晚）+ 通用各占一半。
 * 写得轻松点，不要"AI 助手"那种正经话。
 */
const GREETINGS_GENERIC = [
  '今天想做点什么？',
  '嗨，想做个什么东西？',
  '说一句，我帮你画出来',
  '灵感来了？敲下来试试',
  '随便聊聊，看能做出什么',
  '把脑子里那张图描述一下',
  '今天想折腾点什么？',
];
const GREETINGS_MORNING = ['早，今天先做哪个？', '早上好 ☕ 想做什么？'];
const GREETINGS_AFTERNOON = ['下午想做点什么？', '午后小憩，做点什么？'];
const GREETINGS_EVENING = ['晚上有想做的吗？说说看', '深夜灵感最值钱，敲下来'];

function pickGreeting() {
  const h = new Date().getHours();
  let pool = GREETINGS_GENERIC;
  if (h >= 6 && h < 11) pool = pool.concat(GREETINGS_MORNING);
  else if (h >= 13 && h < 18) pool = pool.concat(GREETINGS_AFTERNOON);
  else if (h >= 21 || h < 4) pool = pool.concat(GREETINGS_EVENING);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 输入框 placeholder 例子池——给用户一个具体的起点示例，比"agent 自己判断…"
 * 那种过程描述更直观。mount 时随机挑一条。
 */
const PLACEHOLDER_EXAMPLES = [
  '比如：给我的新歌做一个歌词视觉页',
  '比如：春节活动海报，暖色调',
  '比如：作品集主页，安静一点的',
  '比如：同人本的宣传图，暗色系',
  '比如：一篇长文的阅读页，衬线字',
  '比如：把这半年做的东西整理成一份 deck',
  '想画个什么？说说看',
  '把脑子里的画面写下来…',
];

function pickPlaceholder() {
  return PLACEHOLDER_EXAMPLES[Math.floor(Math.random() * PLACEHOLDER_EXAMPLES.length)];
}

function QuickEntry({ prefill }) {
  const navigate = useNavigate();
  const createProject = useProjectStore(s => s.createProject);
  const showToast = useGlobalStore(s => s.showToast);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [greeting] = useState(pickGreeting);  // mount 时挑一次，刷新换一个
  const [placeholder] = useState(pickPlaceholder);
  // 暂存附件（QuickEntry 阶段还没 project，只能存 File 对象，submit 时再 createProject + 上传）
  // chip 形态：path/error 都 undefined → ComposerTray 显示 "上传中…"（实际是"待上传"，hover 看 title）
  const [attachments, setAttachments] = useState([]);
  // [{ id, type:'asset', name, size, mime, _file: File }]
  const ref = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 280) + 'px';
  }, [text]);

  // 空状态示例 chip 点击 → 填入并聚焦（ts 变化允许重复点同一条）
  useEffect(() => {
    if (!prefill?.text) return;
    setText(prefill.text);
    ref.current?.focus();
  }, [prefill]);

  const handlePickFile = (file) => {
    const tempId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setAttachments(arr => [...arr, {
      id: tempId, type: 'asset',
      name: file.name, size: file.size, mime: file.type,
      _file: file,  // 暂存 File 等 submit 时统一上传
    }]);
  };
  const handleRemoveAtt = (id) => setAttachments(arr => arr.filter(a => a.id !== id));

  const submit = async () => {
    const v = text.trim();
    if (!v || submitting) return;
    setSubmitting(true);
    try {
      // 1. 直接建**真项目**（2026-07-28：首页不再有"闪聊"这个二等公民）。
      //    名字先用用户这句话垫着，标 autoNamed —— 第一轮跑完服务端会用 SDK helper
      //    写的会话摘要正名一次，用户之后随时可以在项目里「⋯ → 重命名」改。
      const projName = v.slice(0, 24) + (v.length > 24 ? '…' : '');
      const proj = await createProject({
        name: projName || '新项目',
        autoNamed: true,
      });
      // 2. 上传暂存的附件到新 project（单文件失败不阻塞其他，让用户看到 toast 自决）
      const ready = [];
      for (const a of attachments) {
        if (!a._file) continue;
        try {
          const { asset } = await Assets.upload(proj.id, a._file);
          ready.push({ type: 'asset', path: asset.path, name: asset.name, size: asset.size, mime: asset.mime });
        } catch (err) {
          showToast(`${a.name} 上传失败：${err.message}`, 'error');
        }
      }
      // 3. 跳 Workspace 把首条消息 + attachments 塞 location.state；ProjectWorkspace 的
      //    initialMessage useEffect（mount 后 250ms 等 WS 上线）单点负责发首条 turn。
      //    旧实现这里也调 Turn.send 预发一条 → 后端 isNewSession=true 起 session A，
      //    Workspace 上线后又发一条 → 起 session B，导致每次闪聊创 2 个 session。
      navigate(`/projects/${proj.id}/work`, {
        state: { initialMessage: v, attachments: ready },
      });
    } catch (err) {
      showToast(`创建失败：${err.message}`, 'error');
      setSubmitting(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const empty = !text.trim();

  return (
    <div>
      <h1 style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
        color: COLOR.text, letterSpacing: '-0.01em',
        margin: `0 0 ${GAP.lg}px 0`,
        textAlign: 'center',
      }}>{greeting}</h1>
      <div style={{
      background: COLOR.bgWhite,
      border: `1px solid ${COLOR.borderMd}`,
      borderRadius: 16,
      padding: `${GAP.lg}px ${GAP.lg}px ${GAP.md}px`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      transition: 'border-color 0.15s, box-shadow 0.15s',
    }}>
      <textarea
        ref={ref}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder}
        rows={1}
        disabled={submitting}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          resize: 'none',
          fontFamily: FONT_SANS,
          fontSize: FONT_SIZE.lg,
          lineHeight: 1.55,
          color: COLOR.text,
          padding: `${GAP.sm}px 0 ${GAP.md}px`,
          maxHeight: 280,
          minHeight: 32,
          overflow: 'auto',
          boxSizing: 'border-box',
          opacity: submitting ? 0.5 : 1,
        }}
      />
      <ComposerTray items={attachments} onRemove={handleRemoveAtt} />
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
        <button
          title="上传附件（图片 / PDF / HTML / 等）"
          onClick={() => fileInputRef.current?.click()}
          disabled={submitting}
          style={{
            width: 28, height: 28, borderRadius: 14,
            background: 'transparent',
            border: `1px solid ${submitting ? COLOR.borderLt : COLOR.borderMd}`,
            color: submitting ? COLOR.sub : COLOR.text2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (!submitting) e.currentTarget.style.borderColor = COLOR.text2; }}
          onMouseLeave={e => { if (!submitting) e.currentTarget.style.borderColor = COLOR.borderMd; }}
        >
          <Plus size={14} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.pptx,.docx,.html,.htm,.png,.jpg,.jpeg,.svg,.webp,.md,.txt"
          onChange={(e) => {
            Array.from(e.target.files || []).forEach(handlePickFile);
            e.target.value = '';
          }}
          style={{ display: 'none' }}
        />
        <span style={{ flex: 1 }} />
        <button
          onClick={submit}
          disabled={empty || submitting}
          title={submitting ? '创建中…' : '发送（Enter）'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
            color: COLOR.btnText,
            background: empty ? COLOR.dim : COLOR.btn,
            border: `1px solid ${empty ? COLOR.dim : COLOR.btn}`,
            borderRadius: RADIUS.xl,
            cursor: empty ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s',
            opacity: submitting ? 0.6 : 1,
          }}
          onMouseEnter={e => { if (!empty && !submitting) e.currentTarget.style.background = COLOR.btnHover; }}
          onMouseLeave={e => { if (!empty && !submitting) e.currentTarget.style.background = COLOR.btn; }}
        >
          {submitting ? '创建中…' : '发送'}
          <ArrowUp size={13} strokeWidth={2.25} />
        </button>
      </div>
    </div>
    </div>
  );
}

// ── RecentQuickSection ── Home 中间一段：最近闪聊 list

function RecentQuickSection() {
  const [sessions, setSessions] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Sessions.recent({ limit: 5, kind: 'quick' })
      .then(({ sessions: list = [] }) => {
        if (!cancelled) {
          setSessions(list);
          setLoaded(true);
        }
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);

  const handleDelete = async (s) => {
    const title = s.customTitle || s.summary || s.firstPrompt || s.projectName || '未命名对话';
    if (!(await confirm({
      title: '删除对话',
      message: `删除对话「${title}」？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await Sessions.remove(s.projectId, s.sessionId);
      setSessions(prev => prev.filter(x => x.sessionId !== s.sessionId));
      showToast('已删除', 'info');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  if (!loaded || sessions.length === 0) return null;

  return (
    <section style={{ marginBottom: GAP.xxl }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.md }}>
        <h2 style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 600,
          color: COLOR.text2, letterSpacing: '-0.01em', margin: 0,
        }}>最近对话</h2>
      </div>
      <div style={{
        background: COLOR.bgWhite,
        border: `1px solid ${COLOR.borderLt}`,
        borderRadius: RADIUS.xl,
        overflow: 'hidden',
      }}>
        {sessions.map((s, i) => (
          <RecentQuickRow
            key={`${s.projectId}/${s.sessionId}`}
            session={s}
            isFirst={i === 0}
            onDelete={() => handleDelete(s)}
          />
        ))}
      </div>
    </section>
  );
}

function RecentQuickRow({ session: s, isFirst, onDelete }) {
  const [hover, setHover] = useState(false);
  const handleDeleteClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    onDelete?.();
  };
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative' }}
    >
      <Link
        to={`/projects/${s.projectId}/sessions/${s.sessionId}`}
        style={{
          display: 'flex', alignItems: 'center', gap: GAP.md,
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderTop: isFirst ? 'none' : `1px solid ${COLOR.borderLt}`,
          textDecoration: 'none',
          background: hover ? 'rgba(0,0,0,0.018)' : 'transparent',
          transition: 'background 0.15s',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
            color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginBottom: GAP.xxs,
          }}>
            {s.customTitle || s.summary || s.firstPrompt || s.projectName || '未命名对话'}
          </div>
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }}>
            最后消息 {s.lastModified ? timeAgo(new Date(s.lastModified).toISOString()) : ''}
          </div>
        </div>
        <span style={{
          color: COLOR.dim, fontSize: FONT_SIZE.md,
          opacity: hover ? 0 : 1,
          transition: 'opacity 0.15s',
          width: 28, textAlign: 'right',
        }}>›</span>
      </Link>
      {hover && (
        <button
          onClick={handleDeleteClick}
          title="删除对话"
          style={{
            position: 'absolute',
            top: '50%', right: GAP.md,
            transform: 'translateY(-50%)',
            width: 26, height: 26, borderRadius: RADIUS.sm,
            background: 'rgba(255,255,255,0.95)',
            border: `1px solid ${COLOR.borderMd}`,
            color: COLOR.text2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 2,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = COLOR.error; e.currentTarget.style.borderColor = COLOR.error; }}
          onMouseLeave={e => { e.currentTarget.style.color = COLOR.text2; e.currentTarget.style.borderColor = COLOR.borderMd; }}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

// ── ProjectCard ── 网格卡片（封面 = iframe 最新 canvas.html）

function ProjectCard({ project }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const navigate = useNavigate();
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const prompt = useGlobalStore(s => s.prompt);

  const dot = project.status === 'running' ? COLOR.warn : project.status === 'failed' ? COLOR.error : COLOR.success;

  const handleRename = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    const next = await prompt({
      title: '重命名项目',
      initialValue: project.name,
      placeholder: '项目名',
      validate: (v) => v.trim() ? null : '不能为空',
    });
    if (!next || !next.trim() || next === project.name) return;
    try {
      await updateProject(project.id, { name: next.trim() });
      showToast(`已重命名为「${next.trim()}」`, 'success');
    } catch (err) {
      showToast(`重命名失败：${err.message}`, 'error');
    }
  };
  const handleDuplicate = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    try {
      const copy = await duplicateProject(project.id);
      if (copy) showToast(`已复制为「${copy.name}」`, 'success');
    } catch (err) {
      showToast(`复制失败：${err.message}`, 'error');
    }
  };
  const handleDelete = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    if (!(await confirm({
      title: '删除项目',
      message: `删除「${project.name}」？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await deleteProject(project.id);
      showToast('项目已删除', 'info');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setMenuOpen(false); }}
      style={{ position: 'relative' }}
    >
      <Link to={`/projects/${project.id}/work`} style={{
        display: 'block',
        padding: GAP.lg,
        background: COLOR.bgWhite,
        border: `1px solid ${COLOR.border}`,
        borderRadius: RADIUS.xxl,
        boxShadow: hover ? '0 6px 18px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.03)',
        borderColor: hover ? COLOR.borderMd : COLOR.border,
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'all 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
      }}>
        {/* Thumbnail：服务端截的最新产物封面，没有就占位 */}
        <ThumbnailBox project={project} hasCover />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.sm }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 500, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {project.name}
          </div>
          <span style={{ width: 6, height: 6, borderRadius: RADIUS.xs, background: dot, flexShrink: 0, marginLeft: GAP.md }} />
        </div>
        {project.description && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
            lineHeight: 1.5,
            marginBottom: GAP.sm,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {project.description}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{project.skill}</span>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{timeAgo(project.updatedAt)}</span>
        </div>
      </Link>

      {/* Hover 时显示 ⋯ */}
      {hover && (
        <button
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
          style={{
            position: 'absolute', top: 8, right: 8,
            width: 28, height: 28, borderRadius: RADIUS.md,
            background: 'rgba(255,255,255,0.95)',
            border: `1px solid ${COLOR.borderMd}`,
            color: COLOR.text2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
            zIndex: 2,
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}

      {menuOpen && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'absolute', top: 40, right: 8,
            minWidth: 140,
            background: COLOR.bgWhite,
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: RADIUS.lg,
            boxShadow: SHADOW.pop,
            padding: GAP.xs,
            zIndex: 5,
          }}>
          <MenuItem icon={<Edit2 size={12} />} label="重命名" onClick={handleRename} />
          <MenuItem icon={<Copy size={12} />} label="复制" onClick={handleDuplicate} />
          <MenuItem icon={<Trash2 size={12} />} label="删除" onClick={handleDelete} danger />
        </div>
      )}
    </div>
  );
}

/**
 * 缩略图：服务端截的封面图（GET /api/projects/:pid/cover）
 *
 * 两版演进（2026-07-30）：
 *   老版 iframe 挂 sessions/<sid>/canvas.html —— 形态注册表落地后产物搬进
 *   tasks/<任务>/，这条路只剩后端占位页，封面于是常年一片灰。
 *   改成 iframe 指向真实产物后又撞第二个坎：sandbox 不给 allow-scripts（一屏
 *   十几张卡不能各跑一遍动画/3D），凡是靠 JS 出画面的产物照样白板。
 *   最终落在服务端截图：脚本在 chromium 里真跑一次，浏览器只收一张 JPEG。
 *
 * 画幅：出图比例由产物形态决定（deck 是画幅本身，site 是 1440×900 首屏），
 * 前端不预设——onLoad 读 naturalWidth/Height 拿真实比例再定容器，加载前用
 * 16:10 占位。204（没产物 / 截图环境不可用）走占位框。
 */
const DEFAULT_RATIO = 16 / 10;

function ThumbnailBox({ project, hasCover }) {
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  const [failed, setFailed] = useState(false);

  useEffect(() => { setFailed(false); }, [project.id]);

  const wrap = {
    width: '100%',
    aspectRatio: String(ratio),
    borderRadius: RADIUS.lg,
    marginBottom: GAP.lg,
    overflow: 'hidden',
    background: COLOR.bgCard,
    position: 'relative',
  };

  if (!hasCover || failed) {
    return (
      <div style={{
        ...wrap,
        aspectRatio: String(DEFAULT_RATIO),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.dim,
      }}>
        {project.summary || '还没有产物'}
      </div>
    );
  }

  return (
    <div style={wrap}>
      <img
        src={Assets.coverUrl(project.id)}
        alt={`${project.name} 预览`}
        loading="lazy"
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          // 空响应（204）在部分浏览器也会触发 load，宽高为 0 → 当没封面
          if (!w || !h) setFailed(true);
          else setRatio(w / h);
        }}
        onError={() => setFailed(true)}
        style={{
          width: '100%', height: '100%',
          objectFit: 'cover', objectPosition: 'top',
          display: 'block', border: 0,
        }}
      />
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `${GAP.sm}px ${GAP.md + 2}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: danger ? COLOR.error : COLOR.text2,
        background: 'transparent',
        borderRadius: RADIUS.sm,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(184,58,42,0.08)' : 'rgba(0,0,0,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon} {label}
    </button>
  );
}

function LoadingState() {
  return (
    <div style={{
      padding: `${GAP.page}px ${GAP.page}px`,
      textAlign: 'center',
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub,
    }}>
      加载项目中…
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div style={{
      padding: `${GAP.page}px ${GAP.page}px`,
      textAlign: 'center',
      background: COLOR.bgWhite,
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: RADIUS.xxl,
    }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, color: COLOR.error, marginBottom: GAP.sm }}>
        加载失败
      </div>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub, marginBottom: GAP.xl }}>
        {message || '后端可能没启动。检查 server 是否在 :4001 上跑。'}
      </div>
      <button onClick={onRetry} style={{
        padding: `${GAP.md}px ${GAP.xxl}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
        color: COLOR.bgWhite, background: COLOR.btn,
        border: `1px solid ${COLOR.btn}`,
        borderRadius: RADIUS.lg,
      }}>
        重试
      </button>
    </div>
  );
}

/**
 * 空状态（新号第一眼）：光说「还没有项目」新人不知道这东西能做什么。
 * 给几个可点的示例 prompt —— 点了只预填顶部输入框（可改可删），不直接开跑。
 */
const EMPTY_EXAMPLES = [
  '给我喜欢的歌做一个歌词视觉页',
  '做一个收集我笔下角色设定的档案站',
  '春节活动海报，暖色调',
  '把这半年做的东西整理成一份介绍 deck',
];

function EmptyState({ onCreate, onPick }) {
  return (
    <div style={{
      padding: `${GAP.page * 1.2}px ${GAP.page}px`,
      textAlign: 'center',
      background: COLOR.bgWhite,
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: RADIUS.xxl,
    }}>
      <Sparkles size={32} color={COLOR.dim} style={{ marginBottom: GAP.md }} />
      <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, color: COLOR.text2, marginBottom: GAP.sm }}>
        还没有作品
      </div>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, marginBottom: GAP.xl, lineHeight: 1.6 }}>
        在上面的输入框说一句话就能开工。没想好的话，点一个试试：
      </div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: GAP.md,
        justifyContent: 'center', marginBottom: GAP.xl,
      }}>
        {EMPTY_EXAMPLES.map((text) => (
          <button
            key={text}
            onClick={() => onPick?.(text)}
            style={{
              padding: `${GAP.sm + 1}px ${GAP.xl}px`,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
              color: COLOR.text2, background: COLOR.bgWhite,
              border: `1px solid ${COLOR.borderHv}`,
              borderRadius: RADIUS.pill,
              transition: 'border-color 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = COLOR.text2; e.currentTarget.style.color = COLOR.text; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = COLOR.borderHv; e.currentTarget.style.color = COLOR.text2; }}
          >
            {text}
          </button>
        ))}
      </div>
      <button onClick={onCreate} style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: COLOR.sub, background: 'transparent',
        textDecoration: 'underline', textUnderlineOffset: 3,
      }}>
        或者从「+ 新建项目」开始一件长期的事
      </button>
    </div>
  );
}

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
  padding: `${GAP.sm}px ${GAP.lg}px`,
  borderRadius: RADIUS.lg,
  background: 'transparent',
};

const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
  color: COLOR.btnText, background: COLOR.btn,
  padding: `${GAP.sm + 1}px ${GAP.xl}px`,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: RADIUS.lg,
};
