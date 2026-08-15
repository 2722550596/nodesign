/**
 * site-window-banner —— 站点窗编辑/拖拽模式的提示横幅（2026-08-15 自
 * SiteWindow 原样抽出，行数棘轮拆件：纯文案 JSX，无任何逻辑）。
 */
import { WindowBanner } from './ArtifactWindow.jsx';

export function SiteModeBanner({ tab, collageWarn, built }) {
  if (tab !== 'edit' && tab !== 'drag') return null;
  return (
    <WindowBanner>
      {tab === 'edit' ? (
        <span>双击文字直接改（Enter 保存 / Esc 还原），单击元素弹评论卡 —— 改动和评论都会带给 agent</span>
      ) : (
        <span>
          拖动元素调整布局，摆好后<b>点「保存」写进文件</b>（保存前可撤销）· 按 P 切自由摆放 · Alt 拖 = 复制 · 自由模式方向键微调
          {collageWarn && (
            <span style={{ color: '#a4600f' }}>
              {' '}· 这页是拼贴式版面（大量绝对定位）：绝对定位碎片拖动自动改坐标；其余元素拖动改的是结构，画面可能不变 —— 精修位置更推荐直接吩咐 agent 改 CSS
            </span>
          )}
        </span>
      )}
      {built && (
        <span style={{ color: '#a4600f' }}>
          · 构建型站点：这里改的是构建产物，agent 会把改动同步回源再重新构建
        </span>
      )}
    </WindowBanner>
  );
}
