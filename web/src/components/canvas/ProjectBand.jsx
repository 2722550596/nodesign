import { BookOpen, ScrollText, Palette, Files } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { MARGIN_X, PROJECT_BAND_Y, PROJECT_CARD_W, PROJECT_CARD_H, POP_IN } from '../../lib/board-geometry.js';

/**
 * ProjectBand — 桌面顶部的项目区四件套（2026-07-28，ProjectHub 二级页退役）
 *
 * 项目级的东西（agent 记忆 / 项目指引 / 品牌档案 / 项目文件）原来住在
 * /projects/:id 那个控制台页，跟工作台是两张皮。现在它们回到同一张桌面：
 * 顶带四张入口卡，点开在画布内的浮层里用原来的卡片组件（编辑 / 上传 / 删除
 * 全套照旧，一行逻辑没重写）。
 *
 * 顶带只在项目区（全景）出现；进到某个工作区时镜头裁到那块区，顶带自然离场。
 */
const CARDS = [
  { key: 'memory', title: '记忆', icon: BookOpen, hint: 'agent 按需记的长期记忆' },
  { key: 'guide', title: '项目指引', icon: ScrollText, hint: '每次 session 进 system prompt' },
  { key: 'brand', title: '风格档案', icon: Palette, hint: '视觉风格基线' },
  { key: 'files', title: '项目文件', icon: Files, hint: 'agent 能直接 Read 的素材' },
];

export default function ProjectBand({ summaries = {}, onOpen }) {
  return (
    <>
      {CARDS.map((c, i) => {
        const Icon = c.icon;
        const sub = summaries[c.key];
        return (
          <div
            key={c.key}
            onClick={() => onOpen?.(c.key)}
            title={c.hint}
            style={{
              position: 'absolute',
              left: MARGIN_X + i * (PROJECT_CARD_W + 16),
              top: PROJECT_BAND_Y,
              width: PROJECT_CARD_W, height: PROJECT_CARD_H,
              borderRadius: 10,
              background: COLOR.bgCard,
              border: `1px solid ${COLOR.borderLt}`,
              boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
              padding: GAP.md,
              cursor: 'pointer',
              userSelect: 'none',
              animation: POP_IN,
              transition: 'box-shadow 0.15s, border-color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,0.10)';
              e.currentTarget.style.borderColor = COLOR.borderHv;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.05)';
              e.currentTarget.style.borderColor = COLOR.borderLt;
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
              <Icon size={13} color="#7c6f5a" />
              <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text }}>
                {c.title}
              </span>
            </div>
            <div style={{
              fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub, lineHeight: 1.5,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>
              {sub || c.hint}
            </div>
          </div>
        );
      })}
    </>
  );
}
