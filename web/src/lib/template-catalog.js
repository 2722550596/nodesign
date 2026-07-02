/**
 * template-catalog.js — Skill 市场静态数据 (M1)
 *
 * 一个条目 = 一张橱窗卡片 = 一组「skill + 预设风格 + 示例主题」。
 * 同一个 skill 可以衍生多个条目（双风格 × 多 brief = portfolio 卖差异化）。
 *
 * 演化路径：
 *   M1 此处硬编码     ← 现在
 *   M2 改成 plugin 包内 previews/manifest.json 自带，host 扫盘聚合
 *
 * thumb 字段：相对路径指向 /public/templates/<id>.png
 *   暂无图时为 null；卡片回退到 placeholder 占位
 */

export const TEMPLATE_CATALOG = [
  {
    id: 'guizang-magazine-ai-team',
    skillName: 'guizang-ppt-skill',
    styleTag: '杂志风 · 电子墨水',
    title: 'AI 团队年终故事',
    sampleTopic: '2026 年我们造了什么 · 也失败了什么',
    description: '人文叙事 / 衬线字体 / WebGL 流体背景 — 适合分享会、私享会、有故事感的内部讲话。',
    tags: ['年终汇报', '人文叙事'],
    thumb: null,
    accent: '#8a6a3a',
  },
  {
    id: 'guizang-magazine-coffee-launch',
    skillName: 'guizang-ppt-skill',
    styleTag: '杂志风 · 电子墨水',
    title: '独立咖啡品牌发布会',
    sampleTopic: '第三波咖啡浪潮里的小店之夜',
    description: '同款杂志骨架，换文创发布场景 — 看同 skill 怎么把人文叙事打到商业发布上。',
    tags: ['品牌发布', '文创'],
    thumb: null,
    accent: '#c4a870',
  },
  {
    id: 'guizang-swiss-saas-arr',
    skillName: 'guizang-ppt-skill',
    styleTag: '瑞士风 · 国际主义',
    title: 'SaaS ARR 年度数据汇报',
    sampleTopic: '2026 增长拆解 · 渠道 × 留存 × LTV',
    description: '无衬线 / 极致字号对比 / 安全橙 IKB 高反差 — 数据汇报 / 工程沙龙的标配。',
    tags: ['数据汇报', 'ARR'],
    thumb: null,
    accent: '#0033A0',
  },
  {
    id: 'guizang-swiss-design-system',
    skillName: 'guizang-ppt-skill',
    styleTag: '瑞士风 · 国际主义',
    title: '设计系统 v2 发布',
    sampleTopic: 'Tokens × Components × Motion 三层 reset',
    description: '同款瑞士骨架，换设计 / 工程发布场景 — 看 skill 怎么在网格点阵上讲技术故事。',
    tags: ['设计系统', '内部发布'],
    accent: '#9DC209',
    thumb: null,
  },
];

/**
 * 生成 prefill 消息 — 灌进 ProjectWorkspace 的 initialMessage state。
 *
 * 设计原则：
 *   - 显式喊 skill name，让 agent 第一步 invoke `Skill(<name>)` 工具
 *     加载 SKILL.md body 进 conversation history（参考 skill 加载 lifecycle）
 *   - 显式喊预设风格（styleTag），让 agent 知道走双风格哪一支
 *   - userTopic 优先用用户输入；空 → 用 sampleTopic 兜底（demo 仍可跑）
 */
export function buildPrefillMessage(template, userTopic) {
  const topic = (userTopic || '').trim() || template.sampleTopic;
  const usingSample = !((userTopic || '').trim());
  const topicLine = usingSample
    ? `主题（参考样例）：${topic}`
    : `主题：${topic}`;
  return [
    `请用 skill「${template.skillName}」给我做一个 deck。`,
    `预设风格：${template.styleTag}`,
    topicLine,
  ].join('\n');
}

export function findTemplate(id) {
  return TEMPLATE_CATALOG.find(t => t.id === id) || null;
}
