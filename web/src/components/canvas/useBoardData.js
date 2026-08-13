import { useState, useRef, useEffect, useCallback } from 'react';
import { Assets, Sessions, Memory, Instruction } from '../../lib/api.js';

/**
 * useBoardData —— 画布的数据层（2026-08-13 刀 4 续，从 BoardCanvas 拆出）。
 *
 * 管三件事，也只管这三件：
 *   加载   reload()：产物清单 / 会话 / 记忆 / board.json（布局首拉一次）
 *   持有   数据源 states + 布局（layout/zones/bindings）+ 事件回调要读的镜像 ref
 *   落盘   scheduleSave（diff 式 PATCH，800ms 防抖，只发脏条目）/ patchLayout
 *
 * 派生（objects/folderView）**不在这里** —— 那一段跟 cwd、拖拽、影子区等
 * 交互状态缠在一起，属于组件；这里是"磁盘 ↔ 内存"那一半。
 *
 * 刀 4（2026-08-13 早批）在卡体那儿下是因为那条缝天然干净；数据层这半边
 * 的缝在"谁拥有 state"：所有 setter 里只有 setLayout/setZones/setBindings
 * 被交互代码调用，其余（artifacts/tasks/…）只在 reload 里写 —— 所以出口
 * 只放这三个 setter，别的按只读给出去。
 *
 * ## reload 的两条铁律（2026-07-28 加，都是真出过事的）
 *
 * **失败保留旧值。** 原来是 `.catch(() => ({ artifacts: [] }))` —— 任何一次
 * 瞬时失败都会把画布清空，用户看到的是"所有内容突然消失，必须刷新整页"。
 * 拉不到就维持现状，宁可显示旧的也不能显示空的。
 *
 * **过期响应丢弃。** 连续重载时先发的请求可能后到，回来就把新数据覆盖成旧的。
 */
export function useBoardData({ projectId, listVersion, boardVersion }) {
  // ── 数据源 ──
  const [artifacts, setArtifacts] = useState([]);
  const [tasks, setTasks] = useState([]);         // 有产物的文件夹（含工作区根，id=''）
  // 磁盘上全部文件夹的相对路径（含空文件夹）。文件夹卡的权威来源。
  const [folders, setFolders] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [memoryDocs, setMemoryDocs] = useState([]);
  // 布局（saved + 本地改动合一）：{ [id]: {x,y,z} }；zones：{ [路径]: {x,y} }
  //（zones 存档 2026-08-13 瘦身只剩坐标；存量的 w/h/expanded 读进来不用）
  const [layout, setLayout] = useState({});
  const [zones, setZones] = useState({});
  const [bindings, setBindings] = useState({});   // board.json 的关系表
  // 项目区顶带的摘要（指引全文 / 文件数）
  const [guideText, setGuideText] = useState('');
  const [fileCount, setFileCount] = useState(null);

  const layoutLoadedRef = useRef(false);
  const zMaxRef = useRef(10);
  const saveTimerRef = useRef(null);
  const dirtyRef = useRef({ objects: new Set(), zones: new Set() });
  // 事件回调（拖拽/舞台）要读最新布局 —— 状态镜像
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const zonesRef = useRef(zones); zonesRef.current = zones;

  const reloadSeqRef = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    const [a, s, m, b] = await Promise.all([
      Assets.artifacts(projectId).catch(() => null),
      Sessions.list(projectId, { limit: 30 }).catch(() => null),
      Memory.list(projectId).catch(() => null),
      layoutLoadedRef.current ? Promise.resolve(null) : Assets.getBoard(projectId).catch(() => null),
    ]);
    if (seq !== reloadSeqRef.current) return;   // 已经有更新的一轮在跑，这份作废
    Instruction.read(projectId).then(r => setGuideText(r?.content || '')).catch(() => {});
    Assets.list(projectId).then(r => setFileCount((r?.files || r?.assets || []).length)).catch(() => {});
    if (Array.isArray(a?.artifacts)) setArtifacts(a.artifacts);
    if (Array.isArray(a?.tasks)) setTasks(a.tasks);
    if (Array.isArray(a?.folders)) setFolders(a.folders);
    if (Array.isArray(s?.sessions)) setSessions(s.sessions);
    if (Array.isArray(m?.memory)) setMemoryDocs(m.memory);
    if (b?.board && !layoutLoadedRef.current) {
      layoutLoadedRef.current = true;
      setLayout(b.board.objects || {});
      setBindings(b.board.bindings || {});
      setZones(b.board.zones || {});
      // 桌面化：board.json 的 size 不再决定画布大小 —— 桌面宽度固定、高度随内容
      const zs = Object.values(b.board.objects || {}).map(o => o.z || 0);
      zMaxRef.current = Math.max(10, ...zs);
    }
  }, [projectId]);

  // listVersion 是**去抖后**的清单版本（不是每笔工具调用都涨）。iframe 的重载
  // 跟它无关 —— 那走各卡自己的 fileVersions，两件事从此分开。
  useEffect(() => { reload(); }, [reload, listVersion]);

  // agent 改过画布（board.updated）→ 整份布局重拉，服务端为准
  useEffect(() => {
    if (!boardVersion) return;
    layoutLoadedRef.current = false;
    reload();
  }, [boardVersion, reload]);

  // ── 布局持久化（diff 式 PATCH，只发脏条目）──
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const d = dirtyRef.current;
      if (!d.objects.size && !d.zones.size) return;
      const patch = {};
      if (d.objects.size) {
        patch.objects = {};
        for (const id of d.objects) {
          // 没有坐标了 = 明确删掉这条（服务端 null 即删）。原来这里是
          // `if (layoutRef.current[id])` 直接跳过，于是「整理」清掉的坐标
          // 只清在内存里，刷新一次全回来了
          patch.objects[id] = layoutRef.current[id] || null;
        }
      }
      if (d.zones.size) {
        patch.zones = {};
        // 只发坐标：zones 存档只剩 x/y（#14，服务端 sanitizeZone 同款）。
        // 本地 state 里的 w/h 是影子区/旧数据的残留，别让 PATCH 背死字段。
        for (const id of d.zones) {
          const z = zonesRef.current[id];
          if (z) patch.zones[id] = { x: z.x, y: z.y };
        }
      }
      dirtyRef.current = { objects: new Set(), zones: new Set() };
      Assets.patchBoard(projectId, patch).catch(() => {});
    }, 800);
  }, [projectId]);

  const patchLayout = useCallback((id, patch) => {
    setLayout(prev => ({ ...prev, [id]: { x: 0, y: 0, z: 1, ...prev[id], ...patch } }));
    dirtyRef.current.objects.add(id);
    scheduleSave();
  }, [scheduleSave]);

  return {
    artifacts, tasks, folders, sessions, memoryDocs,
    layout, setLayout, zones, setZones, bindings, setBindings,
    guideText, fileCount,
    reload, scheduleSave, patchLayout,
    layoutRef, zonesRef, dirtyRef, layoutLoadedRef, zMaxRef,
  };
}
