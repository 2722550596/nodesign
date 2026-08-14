import { PAPER } from './paper.js';
import { CANVAS } from './theme.js';

/**
 * 关系线的视觉映射 —— 每种语义长什么样。
 *
 * 语义**真相在服务端** `server/lib/binding-types.js`（它是校验方）。这里只管
 * "画成什么"。两份表的 id 必须一一对应，`board-bindings.test.js` 有 parity
 * 断言看着 —— 加了语义忘了给视觉、或者反过来，测试直接红。
 *
 * ## 五种线怎么区分
 *
 * 靠**线型 + 端头**区分，不靠颜色。颜色留给状态（选中 / agent 刚画的 / 悬停），
 * 一旦拿颜色区分语义，状态就没有表达手段了，而且色弱用户读不出差别。
 *
 *   改自 derives-from  实线 + 实心箭头      版本谱系，最该被一眼看见 → 最重的线
 *   批注 annotates     细虚线 + 圆点        引线，不该抢戏 → 最轻的线
 *   接着 flow          实线 + 开口箭头      读序
 *   取材 ref           点线 + 开口箭头      跨任务引用，最弱的耦合 → 点线
 *   对照 contrast      实线 + 两端短横      无向，端头对称才读得出"并列"
 */

export const BINDING_STYLES = {
  'derives-from': {
    label: '改自',
    stroke: PAPER.ink2,
    width: 1.6,
    dash: null,
    head: 'arrow',      // 终点实心箭头
    tail: null,
    /** 布局提示：这条线希望两端离多近（世界单位）。null = 不表态 */
    affinity: 260,
  },
  annotates: {
    label: '批注',
    stroke: PAPER.pencil,
    width: 1,
    dash: '3 4',
    head: 'dot',
    tail: null,
    affinity: 140,      // 批注要贴着被批注的东西
  },
  flow: {
    label: '接着',
    stroke: PAPER.ink2,
    width: 1.4,
    dash: null,
    head: 'arrow-open',
    tail: null,
    affinity: 300,
  },
  ref: {
    label: '取材',
    stroke: PAPER.pencil,
    width: 1.2,
    dash: '1 5',
    head: 'arrow-open',
    tail: null,
    affinity: null,     // 跨任务引用，不要求靠近
  },
  contrast: {
    label: '对照',
    stroke: CANVAS.brass,
    width: 1.4,
    dash: null,
    head: 'bar',
    tail: 'bar',        // 两端对称 = 无向
    affinity: 40,       // 唯一一条明确要求并排的关系，贴得最紧
  },
  link: {
    label: '关联',
    stroke: PAPER.pencil,
    width: 1.1,
    dash: null,
    head: 'dot',        // 两端对称小圆点 = 无向；纯素线会跟涂鸦笔画混淆
    tail: 'dot',
    affinity: 220,
  },
};

/** 悬停 / 选中时的强调色（状态用颜色，语义用线型） */
export const BINDING_ACCENT = CANVAS.brass;

export const BINDING_STYLE_IDS = Object.keys(BINDING_STYLES);

export function bindingStyle(type) {
  return BINDING_STYLES[type] || null;
}

/**
 * 一条线的两个端点：从各自矩形的**边界**出发，不是从中心。
 *
 * 从中心到中心画会让线穿过卡片本身，箭头也埋在卡片底下看不见。做法是取
 * 两个矩形中心的连线，各自求出它与自己矩形边框的交点。
 *
 * 返回 null 表示这条线画不出来（端点缺失 / 两个矩形重叠到中心重合）。
 */
export function edgePoints(a, b, gap = 6) {
  if (!a || !b) return null;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return null;
  return {
    from: rectEdgePoint(a, ac, dx, dy, gap),
    to: rectEdgePoint(b, bc, -dx, -dy, gap),
  };
}

/**
 * 从矩形中心沿 (dx,dy) 方向走到矩形边框上的那个点，再往外让开 gap。
 *
 * 用的是「射线与轴对齐矩形求交」的标准解：分别算出射线撞到竖边和横边所需的
 * 参数 t，取小的那个（先撞到哪条边就是哪条）。比逐边求交短得多也没有分支坑。
 */
function rectEdgePoint(rect, center, dx, dy, gap) {
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: center.x + dx * t + (dx / len) * gap,
    y: center.y + dy * t + (dy / len) * gap,
  };
}

/**
 * 两点之间的路径。用**二次贝塞尔**微微起拱，不用直线。
 *
 * 直线在多条线共端点时会叠成一坨分不开，而且横平竖直的直线跟卡片边框混在
 * 一起读不出是线还是描边。起拱量取两点距离的一个小比例（有上限），距离近的
 * 时候几乎是直线，远的时候拱起来，多条线自然分开。
 */
export function bindingPath(from, to, bow = 0.14, maxBow = 46) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const lift = Math.min(dist * bow, maxBow);
  // 法线方向偏移中点（法线 = 方向向量转 90°）
  const mx = (from.x + to.x) / 2 + (-dy / dist) * lift;
  const my = (from.y + to.y) / 2 + (dx / dist) * lift;
  return `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;
}

/** 曲线中点（挂标签用）。二次贝塞尔 t=0.5 的解析解。 */
export function bindingMidpoint(from, to, bow = 0.14, maxBow = 46) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const lift = Math.min(dist * bow, maxBow);
  const cx = (from.x + to.x) / 2 + (-dy / dist) * lift;
  const cy = (from.y + to.y) / 2 + (dx / dist) * lift;
  // B(0.5) = 0.25*P0 + 0.5*C + 0.25*P1
  return {
    x: 0.25 * from.x + 0.5 * cx + 0.25 * to.x,
    y: 0.25 * from.y + 0.5 * cy + 0.25 * to.y,
  };
}
