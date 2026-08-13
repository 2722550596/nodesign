import { useState, useMemo } from 'react';
import {
  Image as ImageIcon, FileText, Plus, ExternalLink, BookOpen, Trash2,
} from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, CANVAS, alpha } from '../../../lib/theme.js';
import { PAPER, PAPER_SHADOW } from '../../../lib/paper.js';
import { EASE, POP_IN } from '../../../lib/board-geometry.js';
import { SIZES, sizeOf, actionsOf, chromeOf, cardOf } from '../../../lib/board-kinds.js';
import { TEXT_FONT_CSS, TEXT_SIZE_PX } from '../../../lib/text-fonts.js';
import { splitNoteFaces, faceParts } from '../../../lib/note-faces.js';
import { formatSize } from '../../../lib/helpers.js';
import { Assets } from '../../../lib/api.js';
import ArtifactCard from './ArtifactCard.jsx';

/**
 * 画布物件的卡体 —— 从 BoardCanvas 拆出来（2026-08-13）。
 *
 * 接缝选在这儿是因为它**天然干净**：这几个组件全靠 props 通信，一个都不闭包
 * BoardCanvas 的状态。相比之下数据层（加载 / 派生 / 落盘）跟组件状态缠在一起，
 * 拆它要先把依赖关系理直，是另一件事。
 *
 * 涂鸦的墨色表留在这儿：它跟服务端 `sanitizeCanvasData` 的白名单是一对，
 * board-kinds.test.js 有一条断言逐字对着两边（"我选了红色，存下来变黑"那种
 * 不一致不报错，只能靠断言钉）。
 */
const SCRIBBLE_INK = {
  ink: PAPER.ink,
  red: PAPER.red,
  pencil: PAPER.pencil,
  brass: CANVAS.brass,
};

/** 单个画布物件（按 type 分派卡片渲染 + 通用 hover 动作条）*/
function BoardObject({
  o, projectId, currentSessionId, fileVersions, added, animateLayout = false, agentActive = false,
  groupTarget = false,
  renaming = false, onRenameCommit, onRenameCancel,
  onPointerDown, wasDrag, onPrimary, onAdd, onOpenViewer, onOpenFile, onDetail, onDeleteNote, onFocus,
  scale = 1,
}) {
  const [hover, setHover] = useState(false);
  const sz = sizeOf(o);
  // 一笔墨不是一张纸 —— 不给卡片外观（底色/描边/影子全免），只在悬停时浮出
  // 一点底色示意"这一笔是可以拖的"。
  //
  // ⚠️ 判据 2026-08-13 从硬编码的 `o.type === 'scribble'` 换成形态表的
  // `chrome` 轴。`text` 加进来的时候漏了这一行，于是画布上手写的字外面套着
  // 一张白卡 —— 而它自己的注释写着"没有卡片外观，就是一段字浮在纸上"。
  // 每加一种画布原生物件就漏一次，这种判据就该住在表里。
  const isInk = chromeOf(o) === 'bare';
  const base = {
    position: 'absolute', left: o.pos.x, top: o.pos.y, width: sz.w,
    zIndex: o.pos.z || 1,
    borderRadius: isInk ? 4 : RADIUS.xl,
    background: isInk ? (hover ? alpha(CANVAS.brass, 0.10) : 'transparent') : COLOR.bgCard,
    border: isInk ? 'none' : `1px solid ${added ? COLOR.text : COLOR.borderLt}`,
    boxShadow: isInk ? 'none' : (hover ? '0 4px 14px rgba(0,0,0,0.12)' : '0 1px 4px rgba(0,0,0,0.05)'),
    cursor: 'grab', userSelect: 'none',
    touchAction: 'none',
    animation: POP_IN,
    // 变换（2026-08-13，选中态控制器写入 data.rotation / data.scale）：
    // 围绕中心转/缩。命中不用另算 —— DOM 事件本来就跟着 transform 走，
    // 选中框作为子层也一起转。只有墨类（text/scribble）有这两个字段。
    ...(isInk && (o.data?.rotation || (o.data?.scale && o.data.scale !== 1)) ? {
      transform: `rotate(${o.data?.rotation || 0}deg) scale(${o.data?.scale ?? 1})`,
      transformOrigin: '50% 50%',
    } : null),
    // agent 此刻正在动这个物件 → 外圈光圈（放在 animation 之后才盖得住）。
    // 转动的那段亮弧画在下面的伪层里，这里只管稳的那一圈。
    // ⚠️ 这几处都写**完整的 border 简写**，不写 borderColor：上面 base 里已经
    // 有 `border`，简写和分写混在同一个 style 对象里，React 会在重渲染时警告
    // 并且哪个生效取决于键序 —— 属于"改了颜色没变"那类玄学。
    ...(agentActive ? {
      animation: 'ndAgentRing 1600ms ease-in-out infinite',
      border: `1px solid ${alpha(CANVAS.brass, 0.85)}`,
    } : null),
    // 有东西正摞过来 → 亮一圈，示意"松手就把你俩归到一个文件夹里"
    ...(groupTarget ? {
      border: `1px solid ${CANVAS.brass}`,
      boxShadow: `0 0 0 3px ${alpha(CANVAS.brass, 0.22)}, 0 8px 20px rgba(0,0,0,0.14)`,
    } : null),
    // agent 改布局（pin / board.updated 重拉 / 自动入座）时位置变化以滑动呈现；
    // 用户拖拽期间关掉（要逐帧跟手）—— dragActive 经 animateLayout 传进来
    transition: `${animateLayout ? `left 380ms ${EASE}, top 380ms ${EASE}, ` : ''}width 260ms ${EASE}, box-shadow 0.15s`,
  };

  // 按钮清单由形态表给（board-kinds.js 的 actions，顺序即渲染顺序），
  // 这里只把动作 id 兑换成图标和回调。
  // deck 那条是空的：它自带常驻标题栏（编辑 / 内嵌渲染都在上面），外挂 hover
  // 工具小标是重复的第二套按钮 —— 2026-07-28 撤掉。
  const ACTION_DEFS = {
    add: { icon: Plus, title: added ? '已在托盘' : '加入上下文', fn: onAdd },
    read: { icon: BookOpen, title: '阅读', fn: onOpenViewer },
    detail: { icon: ExternalLink, title: '详情', fn: onDetail },
    // .md 两条路都给：「阅读」是渲染过的（双击也走这条），「打开」是原始文件
    open: { icon: ExternalLink, title: '打开', fn: onOpenFile },
    delete: { icon: Trash2, title: '删除', fn: onDeleteNote },
  };
  const actions = actionsOf(o).map(id => ACTION_DEFS[id]).filter(Boolean);

  const Actions = hover && actions.length > 0 && (
    <div data-board-action style={{
      position: 'absolute', top: -26, right: 0, display: 'flex', gap: GAP.xxs,
      // 一小片浮起来的纸，不是描边白盒。这条工具标是 2026-08-03 之前全站换肤
      // 唯一漏掉的地方 —— 因为它写死了 rgba(255,255,255,.95)，绕过了整套 token，
      // 于是纸面上飘着一个上一代设计语言的白色圆角描边框。
      background: PAPER.paper, border: 'none',
      borderRadius: RADIUS.md, padding: GAP.xxs, zIndex: 5,
      boxShadow: PAPER_SHADOW.far,
    }}>
      {actions.map((a, i) => {
        const Icon = a.icon;
        return (
          <button key={i} title={a.title} data-board-action
            onClick={(e) => { e.stopPropagation(); if (!wasDrag()) a.fn(); }}
            style={{ border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.text, display: 'flex', padding: 3 }}>
            <Icon size={12} />
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      data-board-object={o.id}
      data-board-type={o.type}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        if (e.target.closest('[data-board-action]')) return;
        if (!wasDrag()) onPrimary?.();
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={base}
    >
      {Actions}

      {o.type === 'doc' && (
        <div style={{ padding: GAP.md }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginBottom: GAP.xs }}>
            <BookOpen size={13} color="#7c6f5a" />
            <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text }}>{o.title}</span>
          </div>
          <div style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.5,
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {o.preview || o.sub}
          </div>
        </div>
      )}

      {/* deck / 站点 / 世界共用一张方卡（cards/ArtifactCard.jsx）。
          在这之前这里是六个分支约 180 行 —— 三种形态 × 收起/展开两态，骨架
          逐字节相同，只有图标、一行小字、缩略图内容三处不一样。 */}
      {cardOf(o) === 'artifact' && (
        <ArtifactCard
          o={o} projectId={projectId} fileVersions={fileVersions} scale={scale}
          renaming={renaming} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel}
        />
      )}

      {o.type === 'image' && (
        <div>
          <div style={{ aspectRatio: '4 / 3', overflow: 'hidden', borderRadius: '10px 10px 0 0', background: '#f4f2ee' }}>
            <img
              src={thumbSrcOf(projectId, o)} alt={o.name} loading="lazy" draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs, padding: `${GAP.xs}px ${GAP.sm}px` }}>
            <ImageIcon size={10} color={COLOR.sub} />
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {o.meta?.assetRole ? `[${o.meta.assetRole}] ` : ''}{o.name}
            </span>
          </div>
        </div>
      )}

      {/* 运动环绕光圈（2026-08-08）：一段亮弧沿着卡的外沿转。
          conic-gradient 转一圈 + mask 只留边框那一环 —— 比逐帧画 SVG 便宜，
          而且跟着卡片圆角走。pointerEvents:none，不吃任何手势。 */}
      {agentActive && (
        <div aria-hidden style={{
          position: 'absolute', inset: -2, borderRadius: 'inherit',
          padding: 2, pointerEvents: 'none', zIndex: 3,
          background: `conic-gradient(from 0deg, transparent 0deg, transparent 250deg, ${alpha(CANVAS.brass, 0.95)} 320deg, transparent 360deg)`,
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor', maskComposite: 'exclude',
          animation: 'ndAgentSweep 1400ms linear infinite',
        }} />
      )}

      {o.type === 'text' && (
        /* 画布手写文字：没有卡片外观（同涂鸦），就是一段字浮在纸上。
           白名单字体表在 lib/text-fonts.js，跟服务端那份校验对齐。 */
        <div style={{
          fontFamily: TEXT_FONT_CSS[o.data?.font] || TEXT_FONT_CSS.kai,
          fontSize: TEXT_SIZE_PX[o.data?.size] || TEXT_SIZE_PX.md,
          lineHeight: 1.6,
          color: SCRIBBLE_INK[o.data?.color] || PAPER.ink,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          padding: '4px 6px', pointerEvents: 'none', userSelect: 'none',
        }}>{o.data?.t || ''}</div>
      )}

      {o.type === 'scribble' && (
        /* 涂鸦：路径存的是**相对物件左上角**的偏移，所以这里不用管 o.pos，
           直接铺满卡片即可 —— 拖动涂鸦只改 x/y，路径一个字节不重写。
           overflow:visible 是必需的：笔画的抗锯齿会稍稍溢出包围盒。 */
        <svg
          width={sz.w} height={sz.h}
          style={{ display: 'block', overflow: 'visible', pointerEvents: 'none' }}
        >
          <path
            d={o.data?.d || ''}
            fill="none"
            stroke={SCRIBBLE_INK[o.data?.color] || PAPER.ink}
            strokeWidth={o.data?.width || 2}
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      )}

      {o.type === 'note' && <NoteFaces o={o} />}

      {o.type === 'file' && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, padding: `${GAP.sm}px ${GAP.md}px` }}
        >
          <FileText size={12} color={COLOR.sub} />
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {o.name}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>{formatSize(o.size)}</span>
        </div>
      )}

      {added && (
        <div style={{
          position: 'absolute', bottom: -8, right: -6,
          background: COLOR.text, color: COLOR.bg, borderRadius: RADIUS.md,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, padding: '1px 5px',
        }}>
          托盘✓
        </div>
      )}
    </div>
  );
}

function NoteFaces({ o }) {
  const [face, setFace] = useState(0);
  const faces = useMemo(() => splitNoteFaces(o.text || ''), [o.text]);
  const idx = Math.min(face, faces.length - 1);
  const { title, body } = faceParts(faces[idx]);
  const faceBtn = {
    border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.sub,
    fontFamily: FONT_MONO, fontSize: FONT_SIZE.md, lineHeight: 1, padding: `${GAP.xxs}px ${GAP.sm}px`,
  };
  return (
    <div style={{
      padding: GAP.md, background: CANVAS.note, borderRadius: RADIUS.xl, minHeight: SIZES.note.h - 2,
      display: 'flex', flexDirection: 'column',
    }}>
      {(o.noteTask || title) && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.sm, marginBottom: GAP.xs, minWidth: 0 }}>
          {title && (
            <span style={{
              fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{title}</span>
          )}
          {o.noteTask && (
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub, marginLeft: 'auto', flexShrink: 0 }}>
              {o.name.replace(/\.md$/i, '')}
            </span>
          )}
        </div>
      )}
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1,
        display: '-webkit-box', WebkitLineClamp: title ? 4 : 6, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {body || o.name}
      </div>
      {faces.length > 1 && (
        <div data-board-action style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: GAP.sm, marginTop: GAP.xs }}>
          <button data-board-action style={faceBtn} title="上一面"
            onClick={(e) => { e.stopPropagation(); setFace((idx - 1 + faces.length) % faces.length); }}>‹</button>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>{idx + 1}/{faces.length}</span>
          <button data-board-action style={faceBtn} title="下一面"
            onClick={(e) => { e.stopPropagation(); setFace((idx + 1) % faces.length); }}>›</button>
        </div>
      )}
    </div>
  );
}

/**
 * 图片卡的图源。
 *
 * `.thumbnails/` 那条快路只对 `assets/generated` 下的生成图存在（服务端只给
 * 那批预生成）。图片 2026-08-13 起可以被搬进文件夹，搬走之后 `hasThumb` 就是
 * false —— 这时**不能直接发原图**：一张 149KB 的 webp 塞进 200px 宽的卡里，
 * 二十张就是几 MB 的白烧。走 `?w=` 响应式档（服务端 imageVariant，webp 也能缩，
 * 2026-08-01 修过），实测同一张 149KB → 12KB。
 */
export function thumbSrcOf(projectId, item) {
  if (item.hasThumb) {
    const base = item.name.replace(/\.[^.]+$/, '');
    return Assets.artifactFileUrl(projectId, `assets/generated/.thumbnails/${base}.thumb.webp`);
  }
  return `${Assets.artifactFileUrl(projectId, item.path)}?w=480`;
}

export default BoardObject;
