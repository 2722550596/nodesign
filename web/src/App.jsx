import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import Home from './routes/Home.jsx';
import ProjectWorkspace from './routes/ProjectWorkspace.jsx';
import SkillList from './routes/SkillList.jsx';
import TemplateMarket from './routes/TemplateMarket.jsx';
import ToastContainer from './components/ui/ToastContainer.jsx';
import GlobalDialogs from './components/ui/GlobalDialogs.jsx';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  // 项目只剩一张工作台（2026-07-28：ProjectHub 控制台页退役 —— 记忆 / 指引 /
  // 品牌 / 文件回到桌面顶带的"项目区"，会话列表归左栏会话头）
  //   /projects/:id              → 重定向到 /work
  //   /projects/:id/work         → ProjectWorkspace（无 sid，新会话；首跑后 navigate replace 到 /sessions/:sid）
  //   /projects/:id/sessions/:sid → ProjectWorkspace（带 sid，恢复某次会话）
  { path: '/projects/:id', element: <Navigate to="work" replace /> },
  { path: '/projects/:id/work', element: <ProjectWorkspace /> },
  { path: '/projects/:id/sessions/:sid', element: <ProjectWorkspace /> },
  { path: '/skills', element: <SkillList /> },
  { path: '/templates', element: <TemplateMarket /> },
]);

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <ToastContainer />
      <GlobalDialogs />
    </>
  );
}
