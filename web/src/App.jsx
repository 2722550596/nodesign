import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Home from './routes/Home.jsx';
import ProjectHub from './routes/ProjectHub.jsx';
import ProjectWorkspace from './routes/ProjectWorkspace.jsx';
import SkillList from './routes/SkillList.jsx';
import TemplateMarket from './routes/TemplateMarket.jsx';
import ToastContainer from './components/ui/ToastContainer.jsx';
import GlobalDialogs from './components/ui/GlobalDialogs.jsx';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  // H1：项目两级页面
  //   /projects/:id              → ProjectHub（控制台：管理 sessions / instructions / memory / files / brand）
  //   /projects/:id/work         → ProjectWorkspace（无 sid，新会话；首跑后 navigate replace 到 /sessions/:sid）
  //   /projects/:id/sessions/:sid → ProjectWorkspace（带 sid，恢复某次会话）
  { path: '/projects/:id', element: <ProjectHub /> },
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
