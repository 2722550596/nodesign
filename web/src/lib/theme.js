// ─── 基础 Token ───────────────────────────────────
//
// 2026-08-03 立法（设计语言收敛第一步）：
//   - 值一律不动（这一轮是制度改革，不是换肤）——迁移后全站像素必须和迁移前一致。
//   - 新增 RADIUS / SHADOW / TERM / CANVAS / EDITOR / BANNER 和 alpha()，
//     把过去散落在组件里的字面量收编成单一数据源。
//   - 删掉的死 token（CARD/DESK/PANEL/BROWSE、COLOR.bgSide/plan/gradDesk/
//     bgSkeleton/bgSkBar）宿主组件已随本轮清理下线。
//   - 换肤（第二步审美改革）到来时只改这个文件。

/** 颜色体系 */
export const COLOR = {
  // 文字层级（从深到浅）
  text:   "#3a2a18",   // 主标题/主文字
  text2:  "#4a4540",   // 正文
  text3:  "#5a5550",   // 表单标签
  text4:  "#7a6a55",   // 三级文字/图表标签
  text5:  "#8a7a62",   // 导航/图标默认
  sub:    "#a09888",   // 辅助说明/时间戳
  dim:    "#c4bfb5",   // 禁用/占位符

  // 背景
  bg:         "#F9F8F6",   // App 根背景
  bgModal:    "#FDFCFA",   // 弹窗/表单
  bgCard:     "#f6f1ea",   // 卡片
  bgWhite:    "#fff",

  // 渐变
  gradModal: "linear-gradient(180deg, #fdfcfa 0%, #fff 30%)",

  // 交互
  btn:      "#2d2418",
  btnHover: "#3d3428",
  btnText:  "#f5f0e8",

  // 边框
  border:   "rgba(0,0,0,0.06)",
  borderLt: "rgba(0,0,0,0.04)",
  borderMd: "rgba(0,0,0,0.08)",
  borderHv: "rgba(0,0,0,0.12)",

  // 状态
  error:   "#b83a2a",
  success: "#4a8a4a",
  warn:    "#b85c1a",

  // 强调
  blue:  "#5a7a9a",
  brown: "#8a6a3a",
  gold:  "#c4a870",
};

/**
 * alpha('#b08c4f', 0.3) → 'rgba(176,140,79,0.3)'
 * 半透明变体一律从实色 token 派生，别再手写第二份 rgba。
 */
export function alpha(hex, a) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 间距体系（px） */
export const GAP = {
  xxs: 2, xs: 4, sm: 6, md: 8, base: 10, lg: 12, xl: 16, xxl: 20, page: 40,
};

/** 圆角体系（px）。pill 是胶囊（历史上 999 和 100 两种写法，收敛为 999） */
export const RADIUS = {
  xs: 3, sm: 4, md: 6, lg: 8, xl: 10, xxl: 12,
  pill: 999,
  round: '50%',
};

/** 阴影体系 —— 只收编出现 ≥2 次的写法，孤例先留在原地 */
export const SHADOW = {
  crispSm: "0 1px 2px rgba(0,0,0,0.2)",                              // 小徽章/浮点
  crisp:   "0 1px 3px rgba(0,0,0,0.2)",                              // 小浮层
  pop:     "0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",   // 弹出卡
  menu:    "0 12px 32px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",  // 下拉菜单
};

/** 字号体系（px）。xxs=9 是实际存在的第 10 号字级（此前 29 处硬写） */
export const FONT_SIZE = {
  xxs: 9, xs: 10, sm: 11, md: 12, base: 13, lg: 14, xl: 15, xxl: 16, h2: 17, h1: 20,
};

// ─── Font Families ────────────────────────────────

// Font families — Dashboard 基准
export const FONT_MONO = "'SF Mono', 'Cascadia Code', 'Menlo', monospace";
export const FONT_SANS = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";

// ─── 领域 Token ───────────────────────────────────

/** 终端/工具执行深色区（StageLayer 工具卡与 admin 日志同源） */
export const TERM = {
  bg:  "#211e17",
  ink: "#e8e2d2",
  ok:  "#8fc79a",
  err: "#e09a94",
};

/** 画布工作面专属（暖纸方言；换肤时整组处置） */
export const CANVAS = {
  paper: "#f6f4ef",   // 画布底
  note:  "#fffbeb",   // 便签黄
  brass: "#b08c4f",   // 暖棕描边/运行态（半透明用 alpha(CANVAS.brass, x)）
};

/** 画布交互层（拖拽/评论/对齐等 Figma 式高饱和工具色）。
 *  名字按色相取——语义映射（哪个功能用哪色）留给换肤阶段重整。 */
export const EDITOR = {
  blue:    "#3a7afe",   // 光标/手柄
  magenta: "#e91e63",   // 对齐参考线
  orange:  "#e67e22",   // 评论锚点
  purple:  "#9c4dcc",   // 待定移动
  teal:    "#14b8a6",   // 测量/工具条高亮
  green:   "#16a34a",   // 成功闪现
  violet:  "#8b5cf6",   // 聚焦环
};

/** 顶部横幅三态（QuotaBanner 与 AdminConsole 公告预览共用） */
export const BANNER = {
  info:  "rgba(42, 88, 133, 0.96)",
  warn:  "rgba(184, 92, 26, 0.96)",
  alert: "rgba(184, 58, 42, 0.96)",
};

// ─── 组件级 Token ─────────────────────────────────

// Detail modal — 锚定 SkillDetail
export const MODAL = {
  zIndex: 600,
  overlay: "rgba(0,0,0,0.35)",
  blur: "blur(3px)",
  radius: 16,
  width: 340,
  shadow: "0 12px 40px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.06)",
  scaleHidden: "scale(0.92) translateY(20px)",
  scaleVisible: "scale(1) translateY(0)",
  transition: "transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)",
};

// Stage — Canvas 焕新升级 S2（2026-05-02）：把 iframe 从"贴边平铺"变成
// "浮在暖底上的卡片"。CanvasFrame 用 STAGE.shadow + STAGE.radius，
// ThreeColumnLayout 中间 main 用 STAGE.bg + padding 形成呼吸空间。
export const STAGE = {
  bg: "#FAF8F5",                                  // 比 COLOR.bg 暖 1-2 度
  shadow: "0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.05)",
  borderWarm: "rgba(190, 160, 130, 0.15)",        // 暖棕极淡边
  radius: 12,
  pad: 12,                                        // stage 周围呼吸（main padding）
};
