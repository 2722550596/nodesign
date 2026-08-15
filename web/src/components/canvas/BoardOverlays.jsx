/**
 * BoardOverlays —— 画布阅读器与浮层族（2026-08-14 可维护性行动 B5，从
 * BoardCanvas 原样抽出）。
 *
 * 三张浮层 + 进阅读器的路由表：
 *   makeBoardReaders       形态表 reader → 三种阅读器（memory / file / note）
 *   ProjectPanelOverlay    项目区四张卡（记忆 / 指引 / 品牌 / 文件）
 *   MarkdownViewerOverlay  markdown 阅读（便签全文 / 记忆 / 品牌）+ 任务贴就地编辑
 *   ImageDetailOverlay     图片详情（原图 / PROMPT 元数据 / 加入上下文）
 *
 * 浮层开关的 state（viewer / detail / projectPanel）留在 BoardCanvas —— ESC
 * 处理和打开入口（双击 / 卡片按钮 / 菜单）都在那边。这里只管"开着的时候长什么样"。
 *
 * 编辑草稿（原 viewerEdit）下沉成 MarkdownViewerOverlay 的本地 state：浮层
 * 关闭即卸载即弃稿。原实现草稿挂在 BoardCanvas 上，ESC 关闭那条路不清它 ——
 * 下次打开任意便签会直接跳进带陈稿的编辑态（潜伏边，抽出时一并收掉）。
 */
import { useState } from 'react';
import MarkdownMath from '../ui/MarkdownMath.jsx';
import { Plus, ExternalLink, X, BookOpen, PencilLine } from 'lucide-react';
import { Assets, Memory } from '../../lib/api.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, CANVAS } from '../../lib/theme.js';
import { POP_IN } from '../../lib/board-geometry.js';
import { readerOf } from '../../lib/board-kinds.js';
import MemoryCard from '../project/MemoryCard.jsx';
import InstructionsCard from '../project/InstructionsCard.jsx';
import BrandCard from '../project/BrandCard.jsx';
import FilesCard from '../project/FilesCard.jsx';

/**
 * 进阅读器。走哪条路由由形态表的 `reader` 决定（board-kinds.js），
 * 这里只实现三种阅读器本身。返回 openViewer 给调用方挂双击 / 按钮。
 */
export function makeBoardReaders({ projectId, setViewer }) {
  const READERS = {
    // 记忆 / 品牌 / 指引三张卡的画布分身：正文在服务端，不在磁盘产物里
    async memory(o) {
      const r = await Memory.read(projectId, o.readKey).catch(() => null);
      setViewer({ title: o.title, content: r?.content || o.preview || '(空)' });
    },

    // 普通 .md 产物（世界.md / 正文章节 / agent 写的任何 markdown）。
    // 2026-08-03 之前这类文件只有「打开」= window.open 原始 URL，浏览器给一坨
    // 纯文本 —— 41KB 的正文点开满屏 `**` 和 `##`。阅读器本来就是现成的，
    // 缺的只是这条路由。frontmatter 不剥：便签的 `---` 头是会话元数据该藏，
    // 普通 md 的 frontmatter 是内容的一部分，替用户删掉是自作主张。
    async file(o) {
      const title = o.name || o.title || 'markdown';
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        setViewer({ title, content: await res.text() });
      } catch {
        setViewer({ title, content: o.preview || '(读不出来)' });
      }
    },

    async note(o) {
      const title = o.noteTask ? o.name.replace(/\.md$/i, '') : '便签';
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        const raw = await res.text();
        // 任务便利贴带 note 引用 → 浮层出"编辑"按钮（共享头脑风暴：用户改完
        // agent 下轮从注入清单看到文件、自己 Read 到新内容）
        setViewer({ title, content: raw.replace(/^---\n[\s\S]{0,500}?\n---\n?/, ''), note: o.noteTask ? o : null });
      } catch { setViewer({ title, content: o.text || '', note: o.noteTask ? o : null }); }
    },
  };

  return async (o) => {
    const reader = readerOf(o);
    if (reader) await READERS[reader](o);
  };
}

/** 项目区浮层：直接用原 Hub 的四张卡（编辑 / 上传 / 删除全套照旧） */
export function ProjectPanelOverlay({ projectId, panel, onClose, reload }) {
  return (
    <Overlay onClose={onClose}>
      <div style={{
        width: 'min(560px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'auto',
        background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
      }}>
        {panel === 'memory' && <MemoryCard projectId={projectId} />}
        {panel === 'guide' && <InstructionsCard projectId={projectId} />}
        {panel === 'brand' && <BrandCard projectId={projectId} />}
        {panel === 'files' && <FilesCard projectId={projectId} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: GAP.md }}>
          <button onClick={() => { onClose(); reload(); }} style={toolBtn}>关闭</button>
        </div>
      </div>
    </Overlay>
  );
}

/** markdown 阅读浮层（便签全文 / 记忆 / 品牌）；任务便利贴可直接编辑（共享头脑风暴） */
export function MarkdownViewerOverlay({ projectId, viewer, onClose, onSaved }) {
  const [draft, setDraft] = useState(null);   // null = 阅读态；string = 编辑中的草稿
  return (
    <Overlay onClose={onClose}>
      <div style={{
        background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
        width: 'min(720px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'auto',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: GAP.sm, flexShrink: 0 }}>
          <BookOpen size={14} color={COLOR.sub} />
          <span style={{ marginLeft: GAP.sm, fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.md, color: COLOR.text }}>{viewer.title}</span>
          {viewer.note && draft === null && (
            <button title="编辑" onClick={() => setDraft(viewer.content)} style={{ ...toolBtn, marginLeft: 'auto' }}>
              <PencilLine size={12} />
            </button>
          )}
          {viewer.note && draft !== null && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: GAP.xs }}>
              <button onClick={async () => {
                const o = viewer.note;
                try {
                  // ⚠️ api.js 的 putTaskNote 07-30 就改成 (pid, filename, text)
                  // 三参了，这里曾一直是四参老签名 —— noteTask 当 filename、
                  // 文件名当正文。恰好 noteTask 同期恒 null 让编辑按钮根本不
                  // 出现，两个 bug 互相掩护（2026-08-14 一起修）。
                  await Assets.putTaskNote(projectId, o.name, draft);
                  onSaved(draft);
                  setDraft(null);
                } catch (err) { console.warn('[board] save note failed:', err.message); }
              }} style={toolBtn}>保存</button>
              <button onClick={() => setDraft(null)} style={toolBtn}>取消</button>
            </div>
          )}
          <button onClick={onClose}
            style={{ ...toolBtn, ...(viewer.note ? { marginLeft: GAP.xs } : { marginLeft: 'auto' }) }}><X size={12} /></button>
        </div>
        {draft === null ? (
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.7 }}>
            <MarkdownMath>{viewer.content}</MarkdownMath>
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.7,
              minHeight: 320, resize: 'vertical', width: '100%', boxSizing: 'border-box',
              border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.lg, padding: GAP.md,
              background: CANVAS.note, outline: 'none',
            }}
          />
        )}
      </div>
    </Overlay>
  );
}

/** 图片详情浮层 */
export function ImageDetailOverlay({ projectId, detail, onClose, onAdd }) {
  return (
    <Overlay onClose={onClose}>
      <div style={{
        background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
        maxWidth: 'min(920px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: GAP.md,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text }}>{detail.name}</span>
          <button onClick={onClose} style={{ ...toolBtn, marginLeft: 'auto' }}><X size={12} /></button>
        </div>
        {/* 图占中间的伸缩位：文件名和底部动作条永远留在画面里，图自己缩着看 */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img
            src={Assets.artifactFileUrl(projectId, detail.path)} alt={detail.name}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: RADIUS.lg, border: `1px solid ${COLOR.borderLt}` }}
          />
        </div>
        {detail.meta?.prompt && (
          <div style={{
            padding: GAP.md, borderRadius: RADIUS.lg, background: COLOR.bgCard, border: `1px solid ${COLOR.borderLt}`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.6, whiteSpace: 'pre-wrap',
            flexShrink: 0, maxHeight: 150, overflow: 'auto',
          }}>
            <div style={{ letterSpacing: '0.06em', marginBottom: GAP.xs, color: COLOR.text }}>PROMPT</div>
            {detail.meta.prompt}
            <div style={{ marginTop: GAP.xs }}>
              {detail.meta.aspectRatio} · {detail.meta.model || detail.meta.provider}
              {detail.meta.referenceImageCount > 0 && ` · ${detail.meta.referenceImageCount} 张参考图`}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: GAP.sm, justifyContent: 'flex-end' }}>
          <a href={Assets.artifactFileUrl(projectId, detail.path)} target="_blank" rel="noreferrer" style={{ ...toolBtn, textDecoration: 'none' }}>
            <ExternalLink size={12} /> 原图
          </a>
          <button onClick={onAdd} style={{ ...toolBtn, background: COLOR.text, color: COLOR.bg }}>
            <Plus size={12} /> 加入上下文
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * 画布内浮层（2026-07-28：层级归位）
 *
 * 原来是 position:fixed 铺满整个视口 —— 看图 / 读便签会把左栏对话和顶栏一起
 * 压暗，跟"编辑窗只在画布内最大化"（DeckWindow）的桌面语义打架。改成 absolute
 * 贴在 BoardCanvas 根上：只压暗桌面这一格，zIndex 压在 DeckWindow(120) 之下。
 */
function Overlay({ children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 110, background: 'rgba(0,0,0,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: GAP.page,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        /* 高度给定值（不是 max-）：里层卡片的 maxHeight:100% 才有参照，能真被压缩 */
        style={{
          animation: POP_IN, height: '100%', width: '100%', minHeight: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}
      >{children}</div>
    </div>
  );
}

const toolBtn = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.md,
  background: COLOR.bgCard, color: COLOR.text, cursor: 'pointer',
  padding: `${GAP.xs}px ${GAP.sm + 2}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
};
