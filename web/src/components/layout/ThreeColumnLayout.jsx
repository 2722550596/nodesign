import { WORKBENCH, STAGE } from '../../lib/theme.js';

/**
 * ThreeColumnLayout — 项目工作台三栏容器
 *
 * 左 360px chat / 中 flex auto canvas / 右 340px context panel
 * 列间用 1px border，列内自处理 padding
 *
 * P1 不做 resize handle，简单固定宽度。P2 可以加。
 */
export default function ThreeColumnLayout({ left, center, right, leftWidth = 360, rightWidth = 340 }) {
  return (
    <div style={{
      display: 'flex',
      height: '100%',
      background: WORKBENCH.panel,
    }}>
      <aside style={{
        width: leftWidth,
        flexShrink: 0,
        borderRight: `1px solid ${WORKBENCH.edge}`,
        background: WORKBENCH.panel,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}>
        {left}
      </aside>

      <main style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: STAGE.bg,         // 台面四周那圈呼吸
        padding: STAGE.pad,           // 12px 周围呼吸 → 形成 stage
      }}>
        {center}
      </main>

      <aside style={{
        width: rightWidth,
        flexShrink: 0,
        borderLeft: `1px solid ${WORKBENCH.edge}`,
        background: WORKBENCH.panel,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}>
        {right}
      </aside>
    </div>
  );
}
