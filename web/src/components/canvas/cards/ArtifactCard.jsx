import { useEffect, useRef, useState } from 'react';
import { Presentation, Globe, Map as MapIcon } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../../lib/theme.js';
import { PAPER } from '../../../lib/paper.js';
import { SITE_VIEWPORTS } from '../../../lib/board-geometry.js';
import { ARTIFACT_CARD, ARTIFACT_CARD_LABEL_H } from '../../../lib/board-kinds.js';
import { versionOfFile, versionOfSitePage } from '../../../lib/file-versions.js';
import { formatClock } from '../../../lib/helpers.js';
import { Assets } from '../../../lib/api.js';
import LiveFrame from '../LiveFrame.jsx';
import WorldMap from '../WorldMap.jsx';

/**
 * ArtifactCard —— deck / 站点 / 世界共用的那张方卡（2026-08-13）
 *
 * ## 在这之前
 *
 * 三种产物各有"收起条"和"展开成内嵌渲染"两态，**六个分支在 BoardCanvas 里抄了
 * 六遍**（约 180 行）。逐行比过，骨架完全一样，真正不同的只有四格：图标、
 * 副标题文案、内容区、按钮文案。抄六遍的代价已经在账上：站点的 ✏️ 提示文案
 * 两态不一致、展开态高度在形态表和 JSX 里各写一遍、站点和世界都用 `Globe`
 * 图标（画布上一眼分不出这张卡是站点还是世界）。
 *
 * ## 现在
 *
 * 卡片只有一种样子：**上面一块实时缩略图，下面一条名字**。双击开那扇窗
 * （ArtifactWindow），不再在画布上就地展开。
 *
 * 取消展开态换来的不只是少一半代码 —— **卡片尺寸变成恒定的**。一个会自己
 * 变大两倍半的卡片是所有防遮盖/落点逻辑的噪声源，而"并排看两份 deck"这件事
 * 本来就该由窗来做。
 *
 * ## 缩略图为什么是 LiveFrame 而不是服务端截图
 *
 * 服务端截图（`server/lib/cover.js`）更省浏览器，但它**串行**、冷启 ~8s，
 * 而且要等 agent 写完才有新图。画布是"agent 干活时用户在看"的地方，缩略图
 * 跟着文件版本走才对。代价是每张卡一个 iframe，所以有下面两道闸。
 *
 * ⚠️ **两道限流缺一不可**（否则二十份产物的桌面会把风扇吹起来）：
 *   1. 进视口才挂（IntersectionObserver，预加载 240px）
 *   2. 镜头拉太远就不挂（`scale < 0.45` 时缩略图什么都看不清，纯浪费）
 */

/** 三张脸：图标 / 一行小字 / 缩略图内容。骨架之外的差异**只有这三样**。 */
export const ARTIFACT_FACES = {
  deck: {
    icon: Presentation,
    tip: '双击打开这份幻灯',
    summary: (o) => `幻灯 · ${formatClock(o.mtime)}`,
    /** deck 是 16:9 的设计稿，按 1920 宽等比缩，上下留边（不裁） */
    Preview: ({ o, projectId, fileVersions, box }) => {
      const scale = box.w / 1920;
      return (
        <LiveFrame
          title={`deck-${o.id}`}
          src={`${Assets.artifactFileUrl(projectId, o.deckFile)}?v=${versionOfFile(fileVersions, o.deckFile)}`}
          style={{
            width: 1920, height: 1080, border: 0,
            transform: `scale(${scale}) translateY(${(box.h / scale - 1080) / 2}px)`,
            transformOrigin: '0 0',
            pointerEvents: 'none',
          }}
        />
      );
    },
  },

  site: {
    icon: Globe,
    tip: '双击打开这个站点',
    summary: (o) => (o.single ? '单页' : `站点 · ${o.pages?.length || 1} 个页面`),
    /** 站点按真实设备宽渲染再等比缩，取顶部一屏 —— 版式和配色一眼可辨 */
    Preview: ({ o, projectId, fileVersions, box }) => {
      const deviceW = SITE_VIEWPORTS[0].w;
      const scale = box.w / deviceW;
      const base = o.base || o.task;
      const entry = o.entry || 'index.html';
      return (
        <LiveFrame
          title={`site-${o.id}`}
          src={`${Assets.artifactFileUrl(projectId, `${base}/${entry}`)}?v=${versionOfSitePage(fileVersions, base, entry)}`}
          style={{
            width: deviceW, height: Math.round(box.h / scale), border: 0,
            transform: `scale(${scale})`, transformOrigin: '0 0',
            pointerEvents: 'none',
          }}
        />
      );
    },
  },

  world: {
    // ⚠️ 图标不跟站点共用 `Globe`：桌面上要一眼分得出这张卡是站点还是世界，
    // 而在 2026-08-13 之前它俩长得一模一样。
    icon: MapIcon,
    tip: '双击打开这个世界',
    summary: (o) => {
      const n = o.nodes || [];
      if (!n.length) return '世界 · 地图还是空的';
      // 容器不算地点（收纳态，设计上明确不是地点）。**口径必须跟服务端
      // describe() 一致** —— 两处对不上会像 bug。
      const p = n.filter(x => x.type === 'place').length;
      const c = n.filter(x => x.type === 'character').length;
      return `世界 · ${p} 地点 / ${c} 角色`;
    },
    /** 地图本身当缩略图：铺在一个宽画幅里等比缩，看的是形状不是字 */
    Preview: ({ o, projectId, box }) => {
      const MAP_W = 900;
      const scale = box.w / MAP_W;
      return (
        <div style={{
          width: MAP_W, height: Math.round(box.h / scale),
          transform: `scale(${scale})`, transformOrigin: '0 0',
          pointerEvents: 'none', overflow: 'hidden',
        }}>
          <WorldMap projectId={projectId} base={o.base || o.task} nodes={o.nodes} />
        </div>
      );
    },
  },
};

/**
 * 进视口才为真。**离开视口会变回 false** —— 这是故意的：留着就没有限流了。
 * rootMargin 给足预加载，正常滚动/平移察觉不到卡片是"刚挂上"的。
 */
function useInViewport(ref) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return undefined; }
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) setInView(e.isIntersecting); },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/** 镜头比这个还远时缩略图什么都看不清，挂 iframe 是纯浪费 */
const PREVIEW_MIN_SCALE = 0.45;

export default function ArtifactCard({ o, projectId, fileVersions, scale = 1 }) {
  const face = ARTIFACT_FACES[o.type];
  const boxRef = useRef(null);
  const inView = useInViewport(boxRef);
  if (!face) return null;

  const box = { w: ARTIFACT_CARD.w, h: ARTIFACT_CARD.h - ARTIFACT_CARD_LABEL_H };
  const Icon = face.icon;
  const live = inView && scale >= PREVIEW_MIN_SCALE;

  return (
    <div title={face.tip} style={{ display: 'flex', flexDirection: 'column', height: ARTIFACT_CARD.h }}>
      <div
        ref={boxRef}
        style={{
          width: box.w, height: box.h, overflow: 'hidden', position: 'relative',
          background: COLOR.bgWhite, borderRadius: `${RADIUS.xl}px ${RADIUS.xl}px 0 0`,
          borderBottom: `1px solid ${COLOR.borderLt}`,
        }}
      >
        {live
          ? <face.Preview o={o} projectId={projectId} fileVersions={fileVersions} box={box} />
          : (
            /* 没挂缩略图时不留一块空白 —— 空白看着像"这件东西坏了"。
               给一个安静的底纹加形态图标，明确它只是还没显影。 */
            <div style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: PAPER.paper,
            }}>
              <Icon size={22} color={PAPER.pencil} />
            </div>
          )}
      </div>

      <div style={{
        height: ARTIFACT_CARD_LABEL_H, flexShrink: 0,
        padding: `${GAP.xs}px ${GAP.sm}px`,
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
        minWidth: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs, minWidth: 0 }}>
          <Icon size={12} color={COLOR.sub} style={{ flexShrink: 0 }} />
          <span style={{
            fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{o.title}</span>
        </div>
        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {face.summary(o)}
        </div>
      </div>
    </div>
  );
}
