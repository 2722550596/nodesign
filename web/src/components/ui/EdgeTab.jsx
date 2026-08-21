import { PAPER, PAPER_SHADOW, GRAIN } from '../../lib/paper.js';
import { FONT_KAI } from '../../lib/theme.js';

/**
 * 边缘书签舌头 —— 贴在屏缘上的一小片纸，点一下把那一层拉出来（2026-08-21）。
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
 * 本子侧面那种索引舌头：干净的一小片纸，朝内那两个角切掉一点。
 * （08-21 第一版做的是"便签黄 + 虚线撕口 + 毛边"，用户看了真机之后否掉了 —— 那么小一片纸上
 * 堆三种花样，读出来是脏不是精致。这一版只靠位置和两个字说话。）
 *
 * 它属于全站「纸的物理」：合着的时候贴在屏缘上（mid 影子，浮着），拉开之后**长在那张卡的
 * 内沿上**、影子压平成 far —— 位置由调用方给，用跟卡完全一样的曲线做位移，
 * 看起来才是"被卡带出来的"。
 *
 * ## 只在手指设备上出现
 *
 * 桌面维持 2026-08-13 定下的那条：「边缘不该有任何常驻遮挡」，鼠标贴边就能唤出来，
 * 不需要一个常驻的小块。渲不渲染由调用方按 (pointer: coarse) 决定。
 */

/** 命中区：短边 28、长边 76。可见区比它小一圈（见文件头规矩 1）。 */
export const TAB_HIT = 28;
export const TAB_LEN = 76;
const PAPER_W = 15;
const PAPER_L = 66;
/** 朝内那两个角切掉多少（px）。切得比这深就不像纸了，像一块牌子。 */
const CUT = 4;

/** 索引舌头的外形：外缘是直的（贴着屏缘），朝内那两个角各切一刀 */
function tabClip(edge) {
  if (edge === 'right') {
    return `polygon(100% 0, 100% 100%, ${CUT}px 100%, 0 calc(100% - ${CUT + 1}px), 0 ${CUT + 1}px, ${CUT}px 0)`;
  }
  if (edge === 'left') {
    return `polygon(0 0, 0 100%, calc(100% - ${CUT}px) 100%, 100% calc(100% - ${CUT + 1}px), 100% ${CUT + 1}px, calc(100% - ${CUT}px) 0)`;
  }
  return `polygon(0 0, 100% 0, 100% calc(100% - ${CUT}px), calc(100% - ${CUT + 1}px) 100%, ${CUT + 1}px 100%, 0 calc(100% - ${CUT}px))`;
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
          backgroundColor: PAPER.paper,
          backgroundImage: GRAIN,
          clipPath: tabClip(edge),
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
