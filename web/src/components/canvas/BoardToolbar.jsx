import { Focus, LayoutGrid, StickyNote, FolderPlus, SquarePen, Radio, RotateCcw } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, STAGE } from '../../lib/theme.js';

/**
 * BoardToolbar — 桌面（工作台）的全局工具槽（2026-07-28 桌面化）
 *
 * 桌面化后工作台是唯一顶层曲面，"模式切换"概念退役：这条槽只放画布本身的
 * 控制（视图 / 新建 / 跟随 / 刷新）。deck 编辑工具全部跟着 DeckWindow 窗口走。
 * zoom 全套（Fit/±/%）随无限画布一起删——桌面宽度锁视口，内容纵向生长普通滚动。
 *
 * props: board = { ui, api }（BoardCanvas 经 apiRef/onUiState 桥上报，同旧约定）
 */
export default function BoardToolbar({ board = null }) {
  const api = () => board?.api?.current;
  const ui = board?.ui;
  return (
    <div style={{
      height: 44,
      flexShrink: 0,
      borderBottom: `1px solid ${STAGE.borderWarm}`,
      background: 'rgba(255,255,255,0.95)',
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${GAP.lg}px`,
      gap: GAP.lg,
    }}>
      <div style={{
        display: 'inline-flex',
        background: 'rgba(0,0,0,0.04)',
        borderRadius: 6,
        padding: 2,
      }}>
        <button
          onClick={() => api()?.switchView('arrange')}
          style={segBtn(ui?.viewMode === 'arrange')}
        ><LayoutGrid size={11} /> 整理</button>
        <button
          onClick={() => api()?.switchView('work')}
          disabled={!ui?.canWork}
          title={ui?.canWork ? '只看聚焦任务的工作区' : '进入会话或聚焦某个工作区后可用'}
          style={{ ...segBtn(ui?.viewMode === 'work'), opacity: ui?.canWork ? 1 : 0.4, cursor: ui?.canWork ? 'pointer' : 'not-allowed' }}
        ><Focus size={11} /> 工作</button>
      </div>

      <button onClick={() => api()?.newNote()} style={actionBtn} title="新建灵感便签">
        <StickyNote size={11} /> 便签
      </button>
      <button onClick={() => api()?.newFolder()} style={actionBtn} title="新建文件夹工作区（收纳一类内容）">
        <FolderPlus size={11} /> 文件夹
      </button>
      <button
        onClick={() => api()?.newTask()}
        disabled={!ui?.hasSession}
        title={ui?.hasSession
          ? '开新任务：回到新对话（当前会话保留，随时从画布回来）'
          : '左栏已是新对话，直接输入 brief 开始'}
        style={{ ...actionBtn, ...(ui?.hasSession ? {} : { opacity: 0.4, cursor: 'not-allowed' }) }}
      >
        <SquarePen size={11} /> 新任务
      </button>

      <div style={{ flex: 1 }} />

      <button
        onClick={() => api()?.toggleFollow()}
        title={ui?.follow
          ? '跟随中：agent 动手时视图自动滚过去（你一操作就让位，静置后恢复）'
          : '跟随已关：滚动完全由你控制'}
        style={{
          ...actionBtn,
          ...(ui?.follow ? { background: COLOR.text, color: COLOR.bg } : {}),
        }}
      >
        <Radio size={11} /> 跟随
      </button>
      <button
        onClick={() => api()?.reload()}
        title="刷新产物墙"
        style={{ ...actionBtn, background: 'transparent' }}
      ><RotateCcw size={11} /></button>
    </div>
  );
}

function segBtn(active) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
    padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
    fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
    color: active ? COLOR.text : COLOR.sub,
    background: active ? '#fff' : 'transparent',
    borderRadius: 4,
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
    transition: 'all 0.15s',
    cursor: 'pointer',
  };
}

const actionBtn = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.md}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
  color: COLOR.text2 || COLOR.text,
  background: 'rgba(0,0,0,0.04)',
  borderRadius: 4,
  border: 'none',
  cursor: 'pointer',
};
