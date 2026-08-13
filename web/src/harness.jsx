/**
 * 渲染检查台 —— 不进构建、不进生产（vite build 只打包 index.html）。
 *
 * 存在的理由：这台机器上的浏览器扩展连不上，而画布这些组件的毛病**只有真跑
 * 看得见**（TDZ 白屏、层级错位、工具栏落点）。8443 有登录墙，用 playwright 去
 * 撞登录墙意味着要处理密码 —— 那条路不走。
 *
 * 所以退一步：把组件单独挂起来，喂假数据，用服务端本来就装着的 chromium 截图。
 * 看的是**外壳与布局**（窗框 / 顶栏 / 工具栏落点），不是内容 —— iframe 会因为
 * 没有后端而空着，那正常。
 *
 * 跑法见 scripts/shoot-harness.mjs。
 */
import { createRoot } from 'react-dom/client';
import { PanelManagerProvider } from './components/layout/PanelManager.jsx';
import SiteWindow from './components/canvas/SiteWindow.jsx';

const CASES = {
  site: () => (
    <SiteWindow
      projectId="p_demo"
      task="伊蕾娜手账研究站"
      base="伊蕾娜手账研究站"
      entry="index.html"
      title="伊蕾娜手账研究站"
      pages={['index.html', 'about.html', 'posts/first.html']}
      fileVersions={{}}
      artifactExports={['site', 'html', 'handoff']}
      onExport={() => {}}
      onClose={() => {}}
    />
  ),
};

const which = new URLSearchParams(location.search).get('case') || 'site';
createRoot(document.getElementById('root')).render(
  <PanelManagerProvider projectId="p_demo" defaultPanels={{}} panelMeta={{}}>
    {/* 画布 section 的层叠上下文：产物窗关在里面出不来（同 ProjectWorkspace） */}
    <div style={{ position: 'relative', height: '100%', isolation: 'isolate', background: '#F0EADB' }}>
      {(CASES[which] || CASES.site)()}
    </div>
  </PanelManagerProvider>,
);
