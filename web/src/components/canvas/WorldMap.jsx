/**
 * WorldMap — world 形态的地图渲染（阶段 1，只读）
 *
 * 数据源是 manifest 里 world 产物的 `nodes`：`世界/` 递归扫出来的**平列表**，
 * 每条带 parent。这里按 parent 重建成树再画。之所以后端给平列表而不是嵌套
 * 对象，见 kinds/world.js 的注释。
 *
 * 画法上要成立的一件事：**层级要一眼看得出来**。地点是带边框的容器，越靠外
 * 越大；角色是小的立绘卡，画在它此刻所在的那个地点框里面。角色的位置不是
 * 布局属性，是世界状态本身（文件夹树），所以这里不给拖不给摆，看到的就是
 * 磁盘上的样子。拖拽换地点（等于 mv）是阶段 3 的事。
 *
 * 图一律走 `?w=` 响应式档（480 这一档约 50KB），不拉原图。二十个角色加每层
 * 背景，直出原图首屏就是上百 MB，1 核 Spot 机和用户的浏览器都受不了。
 */

import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Assets } from '../../lib/api.js';

/** 地点框按深度收敛：外层大、内层小，层级一眼可辨 */
const PLACE_STYLE = [
  { pad: 10, radius: 10, title: FONT_SIZE.sm, portrait: 56 },
  { pad: 8, radius: 8, title: FONT_SIZE.xs, portrait: 48 },
  { pad: 6, radius: 7, title: FONT_SIZE.xs, portrait: 40 },
];
/**
 * ⚠️ 必须夹取，不能直接拿 depth 当下标。
 *
 * `Math.min(undefined, 2)` 是 NaN，`PLACE_STYLE[NaN]` 是 undefined，下一行
 * 读 `.pad` 就抛 —— 而这块地图渲染在工作台里，**崩的是整条路由**（React Router
 * 的错误边界接走，用户看到的是一整页空白，不是"世界卡坏了"）。
 * 2026-08-13 用检查通道真渲染时抓到：假数据少给一个 depth 就整页白。
 * 节点是服务端扫目录生成的，字段齐不齐取决于那边，前端这里得自己站稳。
 */
const styleAt = (depth) => {
  const i = Number.isFinite(depth) ? Math.max(0, Math.min(Math.trunc(depth), PLACE_STYLE.length - 1)) : 0;
  return PLACE_STYLE[i];
};

const imgUrl = (projectId, base, rel, w) =>
  `${Assets.artifactFileUrl(projectId, `${base}/${rel}`)}?w=${w}`;

function Portrait({ projectId, base, node, size }) {
  const src = node.portrait ? imgUrl(projectId, base, node.portrait, 480) : null;
  return (
    <div title={node.name} style={{ width: size, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <div style={{
        width: size, height: size, borderRadius: RADIUS.md, overflow: 'hidden',
        background: COLOR.bgCard, border: `1px solid ${COLOR.borderLt}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {src
          ? <img src={src} alt={node.name} loading="lazy" draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          // 还没有立绘：占位而不是留空。空白会让人以为角色没建成功
          : <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
              {[...node.name][0]}
            </span>}
      </div>
      <span style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text, maxWidth: size,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{node.name}</span>
    </div>
  );
}

function PlaceBox({ projectId, base, node, childrenOf }) {
  const kids = childrenOf(node.path);
  const chars = kids.filter(n => n.type === 'character');
  const subs = kids.filter(n => n.type !== 'character');
  const s = styleAt(node.depth);
  const isContainer = node.type === 'container';

  return (
    <div style={{
      padding: s.pad,
      borderRadius: s.radius,
      // 容器是收纳态不是地点，虚线 + 不给背景图，跟地点明确区分
      border: isContainer ? `1px dashed ${COLOR.borderLt}` : `1px solid ${COLOR.border}`,
      background: isContainer ? 'transparent' : COLOR.bgCard,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* 地点的背景插图压在底下当氛围，不抢内容 */}
      {node.background && (
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `url(${imgUrl(projectId, base, node.background, 480)})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          opacity: 0.16, pointerEvents: 'none',
        }} />
      )}
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.sm, marginBottom: chars.length || subs.length ? GAP.sm : 0 }}>
          <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: s.title, color: COLOR.text }}>
            {node.name}
          </span>
          {isContainer && (
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>收纳 · 不在场</span>
          )}
          {/* 没写 地点.md 的层。不标出来的话，用户只会觉得这一层「莫名其妙不一样」 */}
          {node.implicit && (
            <span title="这一层还没写 地点.md，补上才算正式声明"
              style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub, opacity: 0.8 }}>
              未声明
            </span>
          )}
        </div>

        {chars.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.sm, marginBottom: subs.length ? GAP.md : 0 }}>
            {chars.map(c => (
              <Portrait key={c.path} projectId={projectId} base={base} node={c} size={s.portrait} />
            ))}
          </div>
        )}

        {subs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
            {subs.map(sn => (
              <PlaceBox key={sn.path} projectId={projectId} base={base} node={sn} childrenOf={childrenOf} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorldMap({ projectId, base, nodes, style }) {
  const list = nodes || [];
  // 按 parent 一次分好组。每个 PlaceBox 各自 filter 一遍全表是 O(n²)，
  // 节点几百个之后每次画布重渲都在白算
  const byParent = new Map();
  for (const n of list) {
    const key = n.parent ?? '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  const childrenOf = (p) => byParent.get(p ?? '') || [];
  const roots = childrenOf(null);
  // 还没建任何地点就先建了人：角色直接放在 世界/ 根下。合法的起步状态，
  // 不能塞进 PlaceBox（那是地点/容器的画法，角色进去只剩一个空框）
  const rootChars = roots.filter(n => n.type === 'character');
  const rootPlaces = roots.filter(n => n.type !== 'character');

  if (!roots.length) {
    return (
      <div style={{ ...style, padding: GAP.md, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.7 }}>
        地图还是空的。在 <code style={{ fontFamily: FONT_MONO }}>世界/</code> 底下建文件夹，
        放一份 <code style={{ fontFamily: FONT_MONO }}>地点.md</code> 就是地点，
        放 <code style={{ fontFamily: FONT_MONO }}>角色.md</code> 就是角色。
        文件夹叫什么名字都行，重命名不会弄坏任何东西。
      </div>
    );
  }

  return (
    <div style={{ ...style, padding: GAP.md, display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
      {rootChars.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.sm }}>
          {rootChars.map(c => (
            <Portrait key={c.path} projectId={projectId} base={base} node={c} size={styleAt(0).portrait} />
          ))}
        </div>
      )}
      {rootPlaces.map(r => (
        <PlaceBox key={r.path} projectId={projectId} base={base} node={r} childrenOf={childrenOf} />
      ))}
    </div>
  );
}
