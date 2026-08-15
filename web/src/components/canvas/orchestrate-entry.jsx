/**
 * orchestrate-entry —— 站点窗的「编排设置」入口（2026-08-15）。
 *
 * 为什么住独立模块：站点文件夹的散文件不上墙（08-03 定的规矩），而演出文件夹
 * 必然是站点（有 index.html），所以 编排.yaml 的文件卡对标准演出永远不出现 ——
 * 站点窗工具条是编排配置**唯一的图形入口**。板上路（双击 编排.yaml 卡）仍在
 * board-kinds 的 file 变体里，服务于"还没铺 index.html 的搭场期"。
 *
 * 探测用 HEAD 打 artifact-file 路由：无字节传输，404 = 这个站不是演出。
 */
import { useState, useEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { joinRel } from '../../lib/paths.js';
import OrchestrateSettings from './OrchestrateSettings.jsx';

/**
 * @returns {{ item: object|false, overlay: JSX|null }}
 *   item 直接铺进工具条 actions 组（没编排时是 false，被 .filter(Boolean) 吃掉）；
 *   overlay 渲染在窗口内容区里（scrim 是 absolute inset 0，容器要 relative）。
 */
export function useOrchestrateEntry(projectId, base) {
  const [hasOrch, setHasOrch] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(Assets.artifactFileUrl(projectId, joinRel(base || '', '编排.yaml')), { method: 'HEAD' })
      .then(r => { if (live) setHasOrch(r.ok); })
      .catch(() => { if (live) setHasOrch(false); });
    return () => { live = false; };
  }, [projectId, base]);

  return {
    item: hasOrch && {
      id: 'orchestrate', icon: SlidersHorizontal,
      title: '编排设置 —— 这场演出的上下文怎么拼',
      onClick: () => setOpen(true),
    },
    overlay: open
      ? <OrchestrateSettings projectId={projectId} dir={base || ''} onClose={() => setOpen(false)} />
      : null,
  };
}
