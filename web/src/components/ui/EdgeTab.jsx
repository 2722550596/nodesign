import { PAPER, PAPER_SHADOW, GRAIN } from '../../lib/paper.js';
import { FONT_KAI } from '../../lib/theme.js';

/**
 * 边缘贴纸 —— 贴在屏缘上的一小片便签，点一下把那一层拉出来（2026-08-21）。
 *
 * ## 为什么要有它
 *
 * 聊天卡和顶栏原来都只认鼠标：卡是「贴屏缘 10px 停 150ms」，顶栏是「hover 屏顶 10px」。
 * 触屏上没有 hover —— 点击那一瞬间浏览器会补发一个兼容 mousemove，所以**点得极准的时候
 * 偶尔能开**，那是碰巧不是设计（真机档实测：顶栏怎么点都不出来）。移动端用户进了项目
 * 既唤不出 agent，也够不着面包屑/导出/登出。
 *
 * ## 两条硬规矩
 *
 * 1. ⭐**命中区 ≫ 可见区**：看得见的只有 15px 宽那一条，按钮本身 28×76。手指没有像素级
 *    准头，15px 宽的目标在手机上等于没有。
 * 2. ⛔**clip-path 会把命中区一起裁掉**。撕口那圈锯齿要是画在按钮本体上，中心点正好落进
 *    缺口里，`elementFromPoint` 拿到的是底下的东西 —— 写样张时当场栽过。所以按钮是一个
 *    完整的透明矩形，锯齿只画在里面那片 `<span>` 上。
 *
 * ## 形
 *
 * 便签黄的一小片纸，靠内那条是虚线撕口 + 毛边（像是能撕下来的那种）。它属于全站「纸的
 * 物理」：合着的时候贴在屏缘上（mid 影子，浮着），拉开之后**长在那张卡的内沿上**、
 * 影子压平成 far —— 位置由调用方给，用跟卡完全一样的曲线做位移，看起来才是"被卡带出来的"。
 */

/** 命中区：短边 28、长边 76。可见区比它小一圈（见文件头规矩 1）。 */
export const TAB_HIT = 28;
export const TAB_LEN = 76;
const PAPER_W = 15;
const PAPER_L = 66;
/** 撕口锯齿的段数与齿深（px）。齿太深会像一串三角旗，2px 刚好读成"毛边"。 */
const TEETH = 12;
const TOOTH = 2;

/**
 * 内缘那条毛边。外缘走完之后**从远端往回走**内缘 —— 方向反了多边形会自交，
 * 渲染出来是一堆碎三角。
 */
function tearClip(edge) {
  const d = (i) => (i % 2 ? TOOTH : 0);
  const pts = [];
  for (let i = 0; i <= TEETH; i++) {
    const t = (i * 100) / TEETH;
    if (edge === 'right') pts.push(`${d(i)}px ${100 - t}%`);
    else if (edge === 'left') pts.push(`calc(100% - ${d(i)}px) ${100 - t}%`);
    else pts.push(`${100 - t}% calc(100% - ${d(i)}px)`);
  }
  const outer = edge === 'right' ? ['100% 0', '100% 100%']
    : edge === 'left' ? ['0 0', '0 100%']
      : ['0 0', '100% 0'];
  return `polygon(${[...outer, ...pts].join(',')})`;
}

/** 虚线撕口：贴着内缘 4px 的一条 1px 虚线 */
function perforation(edge) {
  const vertical = edge !== 'top';
  return {
    backgroundImage: `repeating-linear-gradient(${vertical ? 180 : 90}deg,`
      + ' rgba(43,33,23,0.30) 0 3px, transparent 3px 7px),'
      + ` ${GRAIN}`,
    backgroundSize: `${vertical ? '1px 100%' : '100% 1px'}, 140px 140px`,
    backgroundPosition: `${edge === 'right' ? 'left 4px top' : edge === 'left' ? 'right 4px top' : 'left bottom 4px'}, 0 0`,
    backgroundRepeat: 'no-repeat, repeat',
  };
}

/**
 * @param {'left'|'right'|'top'} edge 贴在哪条边（决定朝向与撕口那一侧）
 * @param {boolean} open 那一层开着没有（只影响影子档：开着=躺在卡上，压平）
 * @param {string} label 贴纸上那两个字
 * @param {object} style 位置与位移动画由调用方给 —— 贴纸只管自己长什么样
 */
export default function EdgeTab({ edge = 'right', open = false, label, title, onClick, style }) {
  const vertical = edge !== 'top';
  return (
    <button
      type="button"
      data-edge-tab
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-expanded={open}
      style={{
        position: 'absolute',
        width: vertical ? TAB_HIT : TAB_LEN,
        height: vertical ? TAB_LEN : TAB_HIT,
        border: 'none', padding: 0, background: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center',
        // 纸贴着屏缘那一侧，命中区往里长
        justifyContent: 'center',
        ...(edge === 'right' ? { justifyContent: 'flex-end' } : null),
        ...(edge === 'left' ? { justifyContent: 'flex-start' } : null),
        ...(edge === 'top' ? { alignItems: 'flex-start' } : null),
        ...style,
      }}
    >
      <span
        style={{
          width: vertical ? PAPER_W : PAPER_L,
          height: vertical ? PAPER_L : PAPER_W,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: PAPER.sticky,
          ...perforation(edge),
          clipPath: tearClip(edge),
          boxShadow: open ? PAPER_SHADOW.far : PAPER_SHADOW.mid,
          transition: 'box-shadow 200ms',
        }}
      >
        <span style={{
          writingMode: vertical ? 'vertical-rl' : undefined,
          font: `10.5px ${FONT_KAI}`,
          letterSpacing: '0.22em', textIndent: '0.22em', lineHeight: 1,
          color: PAPER.ink2, userSelect: 'none',
        }}>{label}</span>
      </span>
    </button>
  );
}
