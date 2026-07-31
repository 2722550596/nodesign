import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  Image as ImageIcon, FileText, Plus, ExternalLink,
  X, Trash2, BookOpen, Folder, FolderOpen, FolderInput, LogOut,
  Presentation, PencilLine, ChevronsUpDown, Focus, Globe,
} from 'lucide-react';
import { Assets, Sessions, Memory, Canvas, Instruction } from '../../lib/api.js';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import WorldMap from './WorldMap.jsx';
import {
  DESKTOP_W, MARGIN_X, ZONE_GAP_Y, FOLDER_CARD_H, DECK_EMBED_W, ZONE, ZONE_MIN_H, SIZES,
  SITE_VIEWPORTS, EASE, POP_IN, sizeOf, newStackedZoneRect, resolveZoneAvoidance,
} from '../../lib/board-geometry.js';
import { useStageState, splitStageCards, StageBoardLayer, StageDock } from './StageLayer.jsx';
import { zoneOfObjectId } from '../../lib/stage.js';
import { versionOfFile, versionOfTask, versionOfSitePage } from '../../lib/file-versions.js';
import { splitNoteFaces, faceParts } from '../../lib/note-faces.js';
import LiveFrame from './LiveFrame.jsx';
import ProjectBand from './ProjectBand.jsx';
import { useGlobalStore } from '../../stores/globalStore.js';
import MemoryCard from '../project/MemoryCard.jsx';
import InstructionsCard from '../project/InstructionsCard.jsx';
import BrandCard from '../project/BrandCard.jsx';
import FilesCard from '../project/FilesCard.jsx';

/**
 * BoardCanvas —— 工作台空间画布（2026-07-27 分区版）
 *
 * Lovart 式画布：一切都是画布上可拖拽的物件。在 v1 之上加了「工作区」分区：
 *   - 每个 session 一块工作区（zone）：带标题的实体区域，画在物件下层，
 *     拖标题栏整区移动（成员跟着走）。zone 存 board.json，前端首次派生
 *     即持久化，agent 侧 pin_to_board 与这里共享同一份。
 *   - 归属 = 几何：物件中心落在区内就是这个任务的。生成图（meta.sessionId）
 *     和便签（frontmatter session）自动摆进所属工作区 —— 自动移入零操作；
 *     拖出 = 移出任务视野，拖入 = 加入，规则只有一条。
 *   - 双视图：整理模式 = 全画布自由混摆（所有 zone 可见）；工作模式 =
 *     镜头锁定当前 session 的工作区，区外物件隐藏。带 session 进入默认
 *     工作模式，纯项目入口默认整理模式。
 *   - deck 两态照旧：卡片态 ↔ 内嵌渲染态；元素级工具只在聚焦（✏️）后开放。
 *   - 「＋」统一语义 = 加入上下文托盘。
 *
 * 持久化：diff 式 PATCH（只发脏物件/脏 zone，debounce 800ms），与 agent 的
 * pin_to_board 写入互不覆盖；boardVersion 变化（board.updated 事件）时整份
 * 布局从服务端重拉，服务端为准。
 */

const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.md': 'text/markdown',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.zip': 'application/zip',
};

export default function BoardCanvas({
  projectId, currentSessionId, listVersion, fileVersions, boardVersion, onAddToContext, onFocusDeck,
  // 工具栏合并（2026-07-27）：画布自己不再渲工具条 —— 通过 apiRef 暴露操作、
  // onUiState 上报状态，控件统一画在外层 CanvasToolbar
  apiRef, onUiState,
  // ✏️ 跨会话编辑前打招呼：切会话后 CanvasFrame 直接进 Edit（唯一的自动切换意图；
  // 工作台已是常驻默认视图，切会话本身不再离开画布）
  onEditNav,
  // 舞台层（2026-07-28）：ProjectWorkspace 把 run.* 事件经这个 ref 转发进来，
  // 画布把 agent 的实时动作演出来（代码直播 / 终端 / shimmer / chip / 角标）
  stageRef,
  // 编辑窗开着时 ESC 归它（关窗），画布不抢
  deckOpen = false,
}) {
  const navigate = useNavigate();
  const scrollRef = useRef(null);          // 纵向滚动容器（桌面的"视口"）
  const [paneSize, setPaneSize] = useState({ w: 0, h: 0 });

  // 数据源
  const [artifacts, setArtifacts] = useState([]);
  const [tasks, setTasks] = useState([]);         // 任务=shared/tasks/ 目录（任务模型）
  const [sessions, setSessions] = useState([]);
  const [memoryDocs, setMemoryDocs] = useState([]);
  // 布局（saved + 本地改动合一）：{ [id]: {x,y,z,expanded} }；zones：{ [sid]: {x,y,w,h,title} }
  const [layout, setLayout] = useState({});
  const [zones, setZones] = useState({});
  // 影子工作区（2026-07-28）：agent 正在往一个还不存在的任务目录里写，产物列表
  // 要等这次写完才知道它存在。先在桌面上把这块区长出来（只在内存里，不落盘），
  // 舞台卡当场就有地方贴；真任务出现后 zone 派生 effect 接管、影子退场。
  const [ghostZones, setGhostZones] = useState({});
  const layoutLoadedRef = useRef(false);
  const zMaxRef = useRef(10);
  // 视图模式：arrange=整理（全桌面），work=工作（只看聚焦的工作区）
  const [viewMode, setViewMode] = useState(() => (currentSessionId ? 'work' : 'arrange'));
  // 工作视图聚焦的工作区（默认当前 session 的；也可聚焦任意 zone / 文件夹）
  const [focusZoneId, setFocusZoneId] = useState(currentSessionId || null);
  const fittedKeyRef = useRef('');        // 工作视图滚到聚焦区：每个目标只滚一次
  // 交互态
  const dragRef = useRef(null);           // { kind:'object', ... }（桌面化后只剩物件拖拽）
  const saveTimerRef = useRef(null);
  const dirtyRef = useRef({ objects: new Set(), zones: new Set() });
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const zonesRef = useRef(zones); zonesRef.current = zones;
  // 舞台/滚动要在事件回调里读最新布局 —— 状态镜像
  const scaleRef = useRef(1);
  const positionedRef = useRef([]);
  const focusZoneRef = useRef(null);
  const viewOffsetRef = useRef(0);      // 镜头裁切偏移（工作视图把聚焦区提到顶端）
  const primaryOpenRef = useRef(null);  // "双击打开"的引用（preview_deck 工具复用）
  const exitToProjectRef = useRef(null);   // 退出任务（ESC / 面包屑 / 标题栏共用）
  const pendingPreviewRef = useRef(null);  // preview 目标还没上墙 → 等它出现
  const [addedPaths, setAddedPaths] = useState(() => new Set());
  const [detail, setDetail] = useState(null);       // 图片详情
  const [viewer, setViewer] = useState(null);       // { title, content, note? } markdown 阅读；note = 可编辑的任务便利贴
  const [viewerEdit, setViewerEdit] = useState(null); // null = 阅读态；string = 编辑中的草稿
  const [projectPanel, setProjectPanel] = useState(null);   // 'memory'|'guide'|'brand'|'files'
  const [guideText, setGuideText] = useState('');           // 顶带「项目指引」摘要
  const [fileCount, setFileCount] = useState(null);         // 顶带「项目文件」计数
  // 拖拽实时落点提示：{ kind:'zone'|'folder', id, ghost?:{x,y,w,h} }（ghost=吸附预览格）
  const [dropHint, setDropHint] = useState(null);
  const dropHintRef = useRef(null);

  // 跟随：agent 动作发生时平滑滚动过去；用户任何操作立即接管、静置后恢复。
  // 2026-07-28 开关退役 —— 行为本来就只在"没被用户接管 + 目标可见"时才动镜头，
  // 为一个自己会让位的行为留开关收益太低。
  const followRef = useRef(true);
  const userHoldUntilRef = useRef(0);       // 用户接管截止时刻（pointerdown/wheel 后 +8s）
  // 拖拽期间关掉物件/工作区的 left/top 过渡（拖拽要逐帧跟手；agent 改布局要动画）
  const [dragActive, setDragActive] = useState(false);

  // ── 数据加载 ──
  /**
   * 重拉产物清单。
   *
   * 两条铁律（2026-07-28 加，都是真出过事的）：
   *   **失败保留旧值。** 原来是 `.catch(() => ({ artifacts: [] }))` —— 任何一次
   *   瞬时失败都会把画布清空，用户看到的是"所有内容突然消失，必须刷新整页"。
   *   拉不到就维持现状，宁可显示旧的也不能显示空的。
   *
   *   **过期响应丢弃。** 连续重载时先发的请求可能后到，回来就把新数据覆盖成旧的。
   */
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
    // 项目区顶带的摘要（指引全文 / 文件数）—— 卡片本体点开时才加载完整数据
    Instruction.read(projectId).then(r => setGuideText(r?.content || '')).catch(() => {});
    Assets.list(projectId).then(r => setFileCount((r?.files || r?.assets || []).length)).catch(() => {});
    if (Array.isArray(a?.artifacts)) setArtifacts(a.artifacts);
    if (Array.isArray(a?.tasks)) setTasks(a.tasks);
    if (Array.isArray(s?.sessions)) setSessions(s.sessions);
    if (Array.isArray(m?.memory)) setMemoryDocs(m.memory);
    if (b?.board && !layoutLoadedRef.current) {
      layoutLoadedRef.current = true;
      setLayout(b.board.objects || {});
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
        for (const id of d.objects) if (layoutRef.current[id]) patch.objects[id] = layoutRef.current[id];
      }
      if (d.zones.size) {
        patch.zones = {};
        for (const id of d.zones) if (zonesRef.current[id]) patch.zones[id] = zonesRef.current[id];
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

  // 任务=会话一对一（2026-07-28）：两张对照表
  //   zoneSession  工作区 → 它属于哪个会话（进这块区 = 进那个会话）
  //   sessionZone  会话 → 它的任务区（会话的产出全归到任务区，不再单开会话区）
  const { zoneSession, sessionZone } = useMemo(() => {
    const z2s = new Map(); const s2z = new Map();
    for (const t of tasks) {
      if (!t.sessionId) continue;
      z2s.set(`task/${t.id}`, t.sessionId);
      if (!s2z.has(t.sessionId)) s2z.set(t.sessionId, `task/${t.id}`);
    }
    return { zoneSession: z2s, sessionZone: s2z };
  }, [tasks]);

  // ── 物件派生（数据源 → 物件列表；布局只管摆放）──
  const objects = useMemo(() => {
    const out = [];
    // 项目级文档（记忆 / 品牌）不再当画布物件 —— 2026-07-28 起由桌面顶带
    // ProjectBand 承载，跟指引、文件一起构成"项目区"。
    for (const s of sessions) {
      const sid = s.sessionId || s.id;
      // 一对一：会话已经有任务了，它的 deck 就是任务 deck，不再单开一张会话 deck 卡
      if (sessionZone.has(sid)) continue;
      out.push({
        id: `deck:${sid}`, type: 'deck', sid,
        title: s.customTitle || s.title || s.summary || s.firstPrompt || '未命名 deck',
        mtime: s.lastModified || s.mtime,
      });
    }
    // 任务 deck（任务模型 2026-07-28）：tasks/<任务>/canvas.html 存在才有 deck 物件；
    // 任务工作区分区本身由 zone 派生 effect 建（无产物的任务也有分区）
    // 多产物平权（2026-07-29）：tasks[].artifacts 一条一卡，没有主/试作等级。
    // 站点子页和样式表仍不各自上墙（用户要的是"我那个网站"，不是
    // index/about/style 三张互不相干的卡）。id 沿用旧格式，存过的布局不丢：
    //   deck: canvas.html → `deck:task/<t>`，其余 → `deck:task/<t>/<文件>`
    //   根站 → `site:task/<t>`；子目录站 → `site:task/<t>/<目录>`；
    //   单页（原 _drafts 试作）→ `site:task/<t>/_drafts/<文件>.html`
    for (const t of tasks) {
      for (const a of (t.artifacts || [])) {
        if (a.kind === 'world') {
          // 一个任务一个世界（world 命中即独占，见 kinds/index.js），所以 id
          // 不带产物后缀。nodes 是地图本身，不是布局属性 —— 它描述的是磁盘上
          // 的文件夹树，画布只负责把它画出来。
          out.push({
            id: `world:task/${t.id}`,
            type: 'world',
            task: t.id,
            base: a.base || `tasks/${t.id}`,
            entry: a.entryRel || '世界.md',
            nodes: a.nodes || [],
            exports: a.exports,
            title: a.title || t.title,
            mtime: t.mtime,
          });
        } else if (a.kind === 'site') {
          out.push({
            id: a.single
              ? `site:task/${t.id}/${a.entryRel}`
              : (a.title ? `site:task/${t.id}/${a.root}` : `site:task/${t.id}`),
            type: 'site',
            single: !!a.single,
            task: t.id,
            base: a.base || `tasks/${t.id}`,
            entry: a.entry || 'index.html',
            pages: a.pages || [],
            root: a.root || '',
            srcRoot: a.srcRoot || '',
            exports: a.exports,
            title: a.title || t.title,
            mtime: t.mtime,
          });
        } else {
          const isCanvas = a.file === 'canvas.html';
          out.push({
            id: isCanvas ? `deck:task/${t.id}` : `deck:task/${t.id}/${a.file}`,
            type: 'deck',
            task: t.id,
            deckFile: a.file,
            exports: a.exports,
            title: a.title || t.title,
            mtime: t.mtime,
          });
        }
      }
    }
    for (const a of artifacts) {
      const sid = a.sessionId || a.meta?.sessionId || null;
      // noteTask：任务便利贴（tasks/<任务>/notes/*.md，agent 和用户共享的头脑
      // 风暴层）；null = 项目级灵感便签（assets/notes/）。删除/编辑走不同路由
      if (a.kind === 'note') {
        out.push({
          id: a.path, type: 'note', sid,
          noteTask: a.path.startsWith('tasks/') ? a.path.split('/')[1] : null,
          ...a,
        });
      }
      else if (a.isImage) out.push({ id: a.path, type: 'image', sid, ...a });
      else out.push({ id: a.path, type: 'file', sid, ...a });
    }
    return out;
  }, [sessions, tasks, artifacts, sessionZone]);

  // 顶带四张卡的一行摘要
  const bandSummaries = useMemo(() => {
    // SDK 自动记忆优先（它才是真的在长的那份），没有再退回手写偏好
    const mem = memoryDocs.find(d => d.agentType === 'auto') || memoryDocs.find(d => d.agentType === null);
    const brand = memoryDocs.find(d => d.agentType === 'brand');
    return {
      memory: mem?.preview || '还没有内容，agent 会自己往里记',
      guide: guideText.trim() ? guideText.trim().slice(0, 60) : '还没写，点开写项目约束',
      brand: brand?.preview || '还没有档案，点开让 agent 整理',
      files: fileCount == null ? '' : (fileCount ? `${fileCount} 个文件` : '还没有文件，点开上传'),
    };
  }, [memoryDocs, guideText, fileCount]);

  const sessionTitles = useMemo(() => {
    const map = new Map();
    for (const s of sessions) {
      map.set(s.sessionId || s.id, s.customTitle || s.title || s.summary || s.firstPrompt || '未命名 deck');
    }
    return map;
  }, [sessions]);

  // 任务工作区标题：zone id 'task/<目录名>' → 目录名即标题
  const taskTitles = useMemo(
    () => new Map(tasks.map(t => [`task/${t.id}`, t.title])), [tasks]);


  // 真工作区 + 影子工作区（影子只活在内存里，真的一出现就退场）
  const zonesEff = useMemo(() => {
    const ghosts = Object.entries(ghostZones).filter(([zid]) => !zones[zid]);
    if (!ghosts.length) return zones;
    const out = { ...zones };
    for (const [zid, g] of ghosts) out[zid] = g;
    return out;
  }, [zones, ghostZones]);
  const zonesEffRef = useRef(zonesEff); zonesEffRef.current = zonesEff;

  // 刚被用户删掉的 zone 墓碑：删任务后 tasks 列表要等 reload 才更新，这个
  // effect 会在窗口期把 zone 重建并回写 board.json（e2e 抓到的真 race，
  // 2026-07-30）。墓碑挡住重建；对应 id 从 needed 里消失后墓碑自动出清
  // （同名新任务照常建区）
  const removedZonesRef = useRef(new Set());

  // ── 工作区派生：当前 session + 有产物的 session 各一块，缺的建出来并持久化 ──
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const needed = new Set();
    if (currentSessionId && !sessionZone.has(currentSessionId)) needed.add(currentSessionId);
    for (const o of objects) {
      if (o.sid && o.type !== 'deck' && !sessionZone.has(o.sid)) needed.add(o.sid);
    }
    for (const t of tasks) needed.add(`task/${t.id}`);   // 每个任务一块工作区
    for (const zid of [...removedZonesRef.current]) {
      if (!needed.has(zid)) removedZonesRef.current.delete(zid);
    }
    const missing = [...needed].filter(zid => !zones[zid] && !removedZonesRef.current.has(zid));
    if (!missing.length) return;
    setZones(prev => {
      const next = { ...prev };
      for (const zid of missing) {
        if (next[zid]) continue;
        // 影子区已经占过位就沿用它的矩形（真区接管时画面不跳）
        next[zid] = {
          ...(ghostZones[zid] || newStackedZoneRect(next)),
          ...((sessionTitles.get(zid) || taskTitles.get(zid)) ? { title: sessionTitles.get(zid) || taskTitles.get(zid) } : {}),
        };
        dirtyRef.current.zones.add(zid);
      }
      scheduleSave();
      return next;
    });
  }, [objects, tasks, currentSessionId, zones, ghostZones, sessionTitles, taskTitles, sessionZone, scheduleSave]);

  // 影子退场：对应的真工作区已经建出来了就删掉影子
  useEffect(() => {
    const stale = Object.keys(ghostZones).filter(zid => zones[zid]);
    if (!stale.length) return;
    setGhostZones(prev => {
      const next = { ...prev };
      for (const zid of stale) delete next[zid];
      return next;
    });
  }, [zones, ghostZones]);

  /**
   * 舞台卡报来的目标（agent 正在写的文件）→ 保证它落脚的工作区存在。
   * 任务目录是 agent 现建的，产物列表这轮还看不到 —— 先用影子区占位。
   */
  const ensureZoneForTarget = useCallback((objectId) => {
    const zid = zoneOfObjectId(objectId, currentSessionId);
    if (!zid) return;
    if (zonesRef.current[zid] || ghostZones[zid]) return;
    const title = zid.startsWith('task/') ? zid.slice(5) : '工作区';
    setGhostZones(prev => (prev[zid] ? prev : {
      ...prev,
      [zid]: { ...newStackedZoneRect({ ...zonesRef.current, ...prev }), title },
    }));
  }, [currentSessionId, ghostZones]);

  /**
   * 自动摆位 + 归属判定：
   *   1. 有 sid 且工作区存在的未摆放物件 → 区内网格自动入座（deck 先占第一格）
   *   2. 其余未摆放物件 → 画布下方的收纳带（文档架 / deck 架 / 素材 / 文件）
   *   3. 归属 = 物件中心落在工作区有效矩形内（区随内容向下自然生长）
   */
  const { positioned, zoneView, contentBottom, overlapFixes } = useMemo(() => {
    // 聚焦区（正在里面干活的那个任务）最小画幅 = 一屏；其余贴内容。
    //
    // 两轮反馈来回过一次，记下结论免得再翻烧饼：
    //   07-29 定"聚焦区吃满一屏"
    //   07-30 反馈"文件夹下面老吊着一块空白，难看" → 一度改成一律贴内容
    //   07-30 再确认"工作进行时初始就该吃满一屏" → 回到一屏，改的是**空白的来源**
    //
    // 关键在于一屏之后别再多出边角料：桌面高度同时收敛到恰好一屏（见 boardH），
    // 区就把整个视口占满，底下不再留一条既不属于区、也不属于内容的空画幅。
    // 内容多于一屏时区照常往下长。
    const fitScale = Math.min(1, (paneSize.w || DESKTOP_W) / DESKTOP_W);
    const oneScreenH = Math.floor((paneSize.h || 600) / (fitScale || 1));
    const focusedZid = viewMode === 'work'
      ? (focusZoneId || sessionZone.get(currentSessionId) || currentSessionId)
      : null;
    const zoneMinHOf = (zid) => (zid === focusedZid
      // 一屏减 16 = 上下各留 8（跟 viewOffsetY 的 8 对齐）。这三个数字是一组，
      // 必须一起改：viewOffsetY 吃掉上边距、这里定区高、boardH 的判定给出下边距。
      // 任何一个多留几像素，"区高 + 上边距"就越过一屏，桌面被判成装不下再补
      // 120 的余量 —— 内容只有一屏却常驻一条竖滚动条。
      ? Math.max(ZONE_MIN_H, oneScreenH - 16)
      : ZONE_MIN_H);

    // 占格：placed 成员先标格子，未摆放的按空格入座
    const grids = {};
    for (const [zid, z] of Object.entries(zonesEff)) {
      grids[zid] = {
        rect: z,
        cols: Math.max(1, Math.floor((z.w - ZONE.pad * 2) / ZONE.cellW)),
        occ: new Set(),
        bottom: z.y + ZONE.header + ZONE.pad,
      };
    }
    const markCells = (g, x, y, w, h) => {
      const c0 = Math.floor((x - (g.rect.x + ZONE.pad)) / ZONE.cellW);
      const r0 = Math.floor((y - (g.rect.y + ZONE.header + ZONE.pad)) / ZONE.cellH);
      const cw = Math.max(1, Math.ceil(w / ZONE.cellW));
      const ch = Math.max(1, Math.ceil(h / ZONE.cellH));
      for (let dc = 0; dc < cw; dc++) for (let dr = 0; dr < ch; dr++) {
        if (c0 + dc >= 0 && r0 + dr >= 0) g.occ.add(`${c0 + dc},${r0 + dr}`);
      }
      g.bottom = Math.max(g.bottom, y + h + ZONE.pad);
    };

    // 自然归属派生：任务物件按路径（tasks/<任务>/…）、deck 按 task/sid 字段、
    // 其余按 meta.sessionId。显式 layout.zone 字段永远优先（'' = 明确无归属）。
    const naturalZoneOf = (o) => {
      if (o.task) return `task/${o.task}`;
      if (typeof o.id === 'string' && o.id.startsWith('tasks/')) {
        const parts = o.id.split('/');
        if (parts.length >= 3) return `task/${parts[1]}`;
      }
      // 会话已经有任务区了就归到任务区（一个会话一块地方，不再会话区/任务区两开）
      if (o.sid && sessionZone.has(o.sid)) return sessionZone.get(o.sid);
      return o.sid || null;
    };
    const effZoneOf = (o) => {
      const stored = layout[o.id];
      if (stored && stored.zone !== undefined) return stored.zone || null;
      const nz = naturalZoneOf(o);
      return nz && grids[nz] ? nz : null;
    };

    // pass 1：已摆放的成员 → 在所属工作区标占格
    for (const o of objects) {
      const pos = layout[o.id];
      if (!pos) continue;
      const zid = effZoneOf(o);
      if (!zid || !grids[zid]) continue;
      const sz = sizeOf({ ...o, pos });
      markCells(grids[zid], pos.x, pos.y, sz.w, sz.h);
    }

    // pass 2：未摆放物件 → 区内入座或收纳带
    const items = [];
    const legacy = { doc: [], deck: [], art: [], file: [] };
    for (const o of objects) {
      const stored = layout[o.id];
      if (stored) { items.push({ ...o, pos: stored }); continue; }
      const nz0 = naturalZoneOf(o);
      const zid = nz0 && grids[nz0] ? nz0 : null;
      if (zid) {
        const g = grids[zid];
        const sz = sizeOf({ ...o, pos: {} });
        const cw = Math.min(g.cols, Math.max(1, Math.ceil(sz.w / ZONE.cellW)));
        const ch = Math.max(1, Math.ceil(sz.h / ZONE.cellH));
        let cell = null;
        for (let idx = 0; idx < 400 && !cell; idx++) {
          const c = idx % g.cols; const r = Math.floor(idx / g.cols);
          if (c + cw > g.cols) continue;
          let free = true;
          for (let dc = 0; dc < cw && free; dc++) for (let dr = 0; dr < ch && free; dr++) {
            if (g.occ.has(`${c + dc},${r + dr}`)) free = false;
          }
          if (free) cell = { c, r };
        }
        if (!cell) cell = { c: 0, r: 0 };
        const x = Math.min(DESKTOP_W - sz.w, g.rect.x + ZONE.pad + cell.c * ZONE.cellW);
        const y = g.rect.y + ZONE.header + ZONE.pad + cell.r * ZONE.cellH;
        markCells(g, x, y, sz.w, sz.h);
        items.push({ ...o, pos: { x, y, z: 1 } });
        continue;
      }
      if (o.type === 'doc') legacy.doc.push(o);
      else if (o.type === 'deck') legacy.deck.push(o);
      else if (o.type === 'file') legacy.file.push(o);
      else legacy.art.push(o);
    }

    // 收纳带（桌面底部）：文档架 / 无工作区 deck / 无主素材 / 文件，列数按桌面宽度算
    const zoneBottom = Object.entries(grids).reduce(
      (acc, [zid, g]) => Math.max(acc, g.rect.y + (g.rect.collapsed ? FOLDER_CARD_H : Math.max(zoneMinHOf(zid), g.bottom - g.rect.y))), ZONE.bandY);
    const deckCols = Math.max(1, Math.floor((DESKTOP_W - MARGIN_X * 2) / 268));
    const artCols = Math.max(1, Math.floor((DESKTOP_W - MARGIN_X * 2) / 228));
    const docY = zoneBottom + 60;
    legacy.doc.forEach((o, i) => items.push({ ...o, pos: { x: MARGIN_X, y: docY + i * 120, z: 1 } }));
    const deckY = docY + legacy.doc.length * 120 + (legacy.doc.length ? 40 : 0);
    legacy.deck.forEach((o, i) => items.push({ ...o, pos: { x: MARGIN_X + 220 + (i % deckCols) * 268, y: deckY + Math.floor(i / deckCols) * 112, z: 1 } }));
    const artY = deckY + Math.ceil(legacy.deck.length / deckCols) * 112 + (legacy.deck.length ? 60 : 0);
    legacy.art.forEach((o, i) => items.push({ ...o, pos: { x: MARGIN_X + (i % artCols) * 228, y: artY + Math.floor(i / artCols) * 210, z: 1 } }));
    const fileY = artY + Math.ceil(legacy.art.length / artCols) * 210 + 40;
    legacy.file.forEach((o, i) => items.push({ ...o, pos: { x: MARGIN_X, y: fileY + i * 52, z: 1 } }));

    for (const it of items) it.zoneId = effZoneOf(it);

    // pass 2.5：框内收容（2026-07-29）。刷新等时序下 stored 位置可能跟重堆后
    // 的区矩形对不上（区挪了成员没跟上），卡看起来悬在文件夹外、区高度还按
    // 错位内容算得很矮。这里把出框成员硬拉回框内，随后的避让 pass 排掉重叠
    // —— 无论哪条路径产生的错位都在下一帧自愈。拖拽中的那张卡不收容
    // （拖出边缘是合法路径：可能正拖去别的区/文件夹）。
    const activeDragId = dragActive ? (dragRef.current?.id ?? null) : null;
    const containFixes = {};
    for (const it of items) {
      if (!it.zoneId || it.id === activeDragId) continue;
      const g = grids[it.zoneId];
      if (!g || g.rect.collapsed) continue;
      const sz = sizeOf(it);
      const xMin = g.rect.x + ZONE.pad;
      const xMax = Math.max(xMin, g.rect.x + g.rect.w - ZONE.pad - sz.w);
      const yMin = g.rect.y + ZONE.header + ZONE.pad;
      const nx = Math.max(xMin, Math.min(xMax, it.pos.x));
      const ny = Math.max(yMin, it.pos.y);
      if (Math.abs(nx - it.pos.x) > 0.5 || Math.abs(ny - it.pos.y) > 0.5) {
        it.pos = { ...it.pos, x: nx, y: ny };
        if (!dragActive && layout[it.id]) containFixes[it.id] = { x: nx, y: ny };
      }
    }

    // pass 3：同区避让系统（2026-07-29 重写）
    //
    // 旧机制（"先来后到"，后来者被传送到网格空位）的两个毛病：
    //   1. 你拖着的卡压到别人身上，被挪走的是你手里这张——排斥手感；
    //   2. 被挪的卡跳到网格序第一个空位，可能离原位很远——传送不是让位。
    // 新语义：**交互中的卡有路权，别人让**。
    //   - 路权按 z（每次 pointerdown / 展开都 zMax+1，天然是"最近摸过"序）
    //   - 让位是最小位移：向下 / 向右 / 向左三个方向里挑挪得最少的那个，
    //     连锁避让（被挤的再挤别人）；侧移超过 8 次防振荡，只往下走（必收敛）
    //   - 拖拽期间只改渲染位置不落盘 —— 拖走了别人自动弹回，松手才定格
    const overlapFixes = { ...containFixes };
    for (const [zid, g] of Object.entries(grids)) {
      if (g.rect.collapsed) continue;   // 收起的文件夹成员不渲染，摆它没意义
      const members = items.filter(it => it.zoneId === zid);
      if (members.length < 2) continue;
      const { moved, bottom: zoneContentBottom } = resolveZoneAvoidance(
        members.map(it => { const sz = sizeOf(it); return { id: it.id, pos: it.pos, w: sz.w, h: sz.h }; }),
        {
          xMin: g.rect.x + ZONE.pad,
          xMax: DESKTOP_W - ZONE.pad,     // 右边缘上限（rect 右缘不出桌面）
          yMin: g.rect.y + ZONE.header + ZONE.pad,
        },
      );
      for (const it of members) {
        const fix = moved.get(it.id);
        if (!fix) continue;
        it.pos = { ...it.pos, x: fix.x, y: fix.y };
        // 拖拽中只做渲染层避让（松手重算时再落盘）；未存过位置的自动入座件也不写
        if (!dragActive && layout[it.id]) overlapFixes[it.id] = fix;
      }
      g.bottom = Math.max(g.bottom, zoneContentBottom + ZONE.pad);
    }

    // zone 视图（有效高度随内容生长，含避让后被挤出来的新底边）
    const zv = Object.entries(grids).filter(([zid]) => !sessionZone.has(zid)).map(([zid, g]) => ({
      id: zid,
      x: g.rect.x, y: g.rect.y, w: g.rect.w,
      // 高度：聚焦区一屏起步、其余贴内容（zoneMinHOf），超出再向下生长；
      // 存档矩形的 h 只当创建时的估算，不当地板
      h: Math.max(zoneMinHOf(zid), g.bottom - g.rect.y),
      title: sessionTitles.get(zid) || taskTitles.get(zid) || g.rect.title || '工作区',
      collapsed: !!g.rect.collapsed,
    }));

    for (const z of zv) z.memberCount = items.filter(it => it.zoneId === z.id).length;
    // 桌面高度 = 可见内容最低点 + 余量（收纳进文件夹的成员藏着，不该撑出死滚动区）
    const collapsedSet = new Set(zv.filter(z => z.collapsed).map(z => z.id));
    let bottom = zoneBottom;
    for (const it of items) {
      if (it.zoneId && collapsedSet.has(it.zoneId)) continue;
      bottom = Math.max(bottom, it.pos.y + sizeOf(it).h);
    }
    return { positioned: items, zoneView: zv, contentBottom: bottom, overlapFixes };
  }, [objects, layout, zonesEff, sessionTitles, taskTitles, sessionZone, dragActive, paneSize,
    viewMode, focusZoneId, currentSessionId]);
  positionedRef.current = positioned;

  // 桌面几何：宽度固定，视口窄则整体等比缩小（非交互）。高度与镜头在
  // 可见性算完之后定（见下方"桌面高度 / 镜头裁切"）。
  const scale = Math.min(1, (paneSize.w || DESKTOP_W) / DESKTOP_W);
  scaleRef.current = scale;
  // floor 不是 ceil：占位壳高度 = boardH * scale，用 ceil 时 ceil(h/s)*s 会比视口
  // 高出不到 1px，于是内容明明装得下也常驻一条竖滚动条。floor 保证 ≤ 视口。
  const oneScreen = Math.floor((paneSize.h || 600) / (scale || 1));

  // 量滚动容器尺寸（决定 fitScale 与桌面最小高度）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setPaneSize(prev => (prev.w === el.clientWidth && prev.h === el.clientHeight)
        ? prev : { w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    let ro = null;
    try { ro = new ResizeObserver(measure); ro.observe(el); } catch { /* ignore */ }
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // 遮盖修正落盘：只在真被推开时写一次，之后布局稳定不再触发
  useEffect(() => {
    const ids = Object.keys(overlapFixes || {});
    if (!ids.length) return;
    setLayout(prev => {
      let touched = false;
      const next = { ...prev };
      for (const id of ids) {
        const fix = overlapFixes[id];
        const cur = prev[id];
        if (!cur || (Math.abs((cur.x ?? 0) - fix.x) < 1 && Math.abs((cur.y ?? 0) - fix.y) < 1)) continue;
        next[id] = { ...cur, ...fix };
        dirtyRef.current.objects.add(id);
        touched = true;
      }
      if (touched) scheduleSave();
      return touched ? next : prev;
    });
  }, [overlapFixes, scheduleSave]);

  // ── 工作区堆叠（桌面化）：zones 永远按序纵向排布，宽度=桌面宽 ──
  // 旧数据（无限画布时代的自由坐标 / 3 列平铺）在这里被一次性迁移；工作区内容
  // 生长时，下方工作区自动让位（配合 left/top 过渡 = 平滑下移动画）。
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const ordered = [...zoneView].sort((a, b) => a.y - b.y || a.x - b.x);
    const targetW = DESKTOP_W - MARGIN_X * 2;
    let cursor = ZONE.bandY;
    const zonePatches = {};
    const shifts = {};
    for (const z of ordered) {
      const dx = MARGIN_X - z.x;
      const dy = cursor - z.y;
      const stored = zonesEffRef.current[z.id];
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs((stored?.w ?? 0) - targetW) > 1) {
        zonePatches[z.id] = { x: MARGIN_X, y: cursor, w: targetW };
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) shifts[z.id] = { dx, dy };
      }
      cursor += (z.collapsed ? FOLDER_CARD_H : z.h) + ZONE_GAP_Y;
    }
    if (!Object.keys(zonePatches).length) return;
    setZones(prev => {
      const next = { ...prev };
      for (const [zid, patch] of Object.entries(zonePatches)) {
        if (!next[zid]) continue;
        next[zid] = { ...next[zid], ...patch };
        dirtyRef.current.zones.add(zid);
      }
      return next;
    });
    // 影子区也跟着归位：漏掉它的话它自己不动、成员却按 shift 挪走，
    // 每次 zoneView 变化再挪一次 —— deck 会被推到工作区下面几百像素（实测 +504）
    setGhostZones(prev => {
      let touched = false;
      const next = { ...prev };
      for (const [zid, patch] of Object.entries(zonePatches)) {
        if (!next[zid]) continue;
        next[zid] = { ...next[zid], ...patch };
        touched = true;
      }
      return touched ? next : prev;
    });
    // 成员跟着自己的工作区平移（只动 layout 里有记录的；自动入座的天然跟随）
    if (Object.keys(shifts).length) {
      setLayout(prev => {
        const next = { ...prev };
        for (const it of positionedRef.current) {
          const sh = it.zoneId ? shifts[it.zoneId] : null;
          if (!sh || !prev[it.id]) continue;
          next[it.id] = {
            ...next[it.id],
            x: Math.max(0, Math.min(DESKTOP_W - 40, (next[it.id].x ?? it.pos.x) + sh.dx)),
            y: Math.max(0, (next[it.id].y ?? it.pos.y) + sh.dy),
          };
          dirtyRef.current.objects.add(it.id);
        }
        return next;
      });
    }
    scheduleSave();
  }, [zoneView, scheduleSave]);

  // 可见性：工作模式只看聚焦工作区（区内成员 + 该 deck 本体）；整理模式下
  // 收纳成文件夹的工作区内容不铺开（这就是"收纳"）。拖拽中的物件永不隐藏。
  const draggingId = dragRef.current?.kind === 'object' ? dragRef.current.id : null;
  const focusZone = viewMode === 'work' ? (focusZoneId || currentSessionId) : null;
  focusZoneRef.current = focusZone;
  const collapsedIds = useMemo(
    () => new Set(zoneView.filter(z => z.collapsed).map(z => z.id)), [zoneView]);
  const visibleObjects = positioned.filter(o => {
    if (o.id === draggingId) return true;
    if (focusZone) return o.zoneId === focusZone || o.id === `deck:${focusZone}`;
    return !(o.zoneId && collapsedIds.has(o.zoneId));
  });
  const visibleZones = focusZone ? zoneView.filter(z => z.id === focusZone) : zoneView;

  // ── 桌面高度 / 镜头裁切（2026-07-28：空白画幅自适应）──
  //
  // 桌面坐标系是全局的（工作区一路往下堆），但工作视图只看一块区。之前直接把
  // 全局坐标铺给滚动容器 —— 聚焦第 3 块任务区时，上面两块的高度变成一片死空白，
  // 下面还挂着全部内容的余量，"进任务文件夹上下大片空画幅"就是这么来的。
  //
  // 现在工作视图给桌面一个偏移量：聚焦区被平移到桌面顶端（bandY），高度只按
  // 这块区自己的内容算。整理视图 offset=0，行为不变。
  const viewOffsetY = focusZone && visibleZones[0]
    ? Math.max(0, visibleZones[0].y - 8)
    : 0;
  viewOffsetRef.current = viewOffsetY;
  const rawBottom = focusZone
    ? visibleObjects.reduce(
        (acc, o) => Math.max(acc, o.pos.y + sizeOf(o).h),
        visibleZones[0] ? visibleZones[0].y + visibleZones[0].h : 0)
    : (contentBottom || 0);
  // 视图内的内容高度（已扣掉偏移）：一屏装得下就恰好一屏（无滚动），
  // 装不下才向下生长并带出滚动（底部留呼吸区）。
  const viewBottom = Math.max(0, rawBottom - viewOffsetY);
  // 装得下就恰好一屏（不留 24 的判定余量 —— 那点余量最后都变成区底下的空隙）
  const boardH = viewBottom <= oneScreen ? oneScreen : viewBottom + (focusZone ? 120 : 240);
  const boardSize = { w: DESKTOP_W, h: boardH };
  // 舞台层还在全局坐标系里贴卡（物件坐标没平移），夹取上界要用未裁切的高度
  const stageBounds = { w: DESKTOP_W, h: viewOffsetY + boardH };

  // ── 桌面滚动（无限画布退役：纵向滚动是唯一的"镜头"）──

  /** 用户接管：任何主动操作后 8s 内跟随不抢滚动 */
  const noteUserTakeover = useCallback(() => {
    userHoldUntilRef.current = Date.now() + 8000;
  }, []);

  /** 跟随 agent：平滑滚到物件（跟随关 / 用户接管期 / 物件不可见时不动）*/
  const followToObject = useCallback((objectId) => {
    if (!followRef.current) return;
    if (Date.now() < userHoldUntilRef.current) return;
    const o = positionedRef.current.find(it => it.id === objectId);
    const el = scrollRef.current;
    if (!o || !el) return;
    // 工作视图里目标不在聚焦工作区 → 不跟（它根本不可见，卡会落 dock）
    const fz = focusZoneRef.current;
    if (fz && o.zoneId !== fz && o.id !== `deck:${fz}`) return;
    const sz = sizeOf(o);
    // 物件是全局坐标，滚动容器是裁切后的镜头 —— 减掉偏移才对得上
    const top = Math.max(0, (o.pos.y - viewOffsetRef.current + sz.h / 2) * scaleRef.current - el.clientHeight / 2);
    el.scrollTo({ top, behavior: 'smooth' });
  }, []);

  // 工作模式：聚焦区已被镜头平移到桌面顶端，切目标时把滚动归零（只归一次）
  useEffect(() => {
    if (viewMode !== 'work') return;
    const target = focusZoneId || currentSessionId;
    if (!target) return;
    const zv = zoneView.find(z => z.id === target);
    const el = scrollRef.current;
    if (!zv || !el) return;
    const key = `work:${target}`;
    if (fittedKeyRef.current === key) return;
    fittedKeyRef.current = key;
    el.scrollTo({ top: 0, behavior: 'smooth' });
  }, [viewMode, focusZoneId, currentSessionId, zoneView]);

  // 切 session：有 session 默认工作模式（聚焦它的工作区），回 /work 回项目区
  useEffect(() => {
    fittedKeyRef.current = '';
    setFocusZoneId(currentSessionId || null);
    setViewMode(currentSessionId ? 'work' : 'arrange');
  }, [currentSessionId]);

  // 一对一：这个会话的任务区一旦知道了，焦点从"会话自己"挪到任务区
  // （任务区才是它的地方；产物列表比路由慢一拍，所以单独一条 effect 补位）
  useEffect(() => {
    if (!currentSessionId) return;
    const zid = sessionZone.get(currentSessionId);
    if (!zid || focusZoneId === zid) return;
    if (focusZoneId && focusZoneId !== currentSessionId) return;   // 用户已经点去别处，不抢
    fittedKeyRef.current = '';
    setFocusZoneId(zid);
  }, [sessionZone, currentSessionId, focusZoneId]);

  // ── 拖拽（物件 / 工作区 / 背景平移共用 pointer 流）──
  const onObjectPointerDown = (e, o) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-board-action]')) return;   // 按钮不触发拖拽
    recentDragMovedRef.current = false;
    noteUserTakeover();
    setDragActive(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const z = ++zMaxRef.current;
    patchLayout(o.id, { x: o.pos.x, y: o.pos.y, z });
    dragRef.current = { kind: 'object', id: o.id, startX: e.clientX, startY: e.clientY, origX: o.pos.x, origY: o.pos.y, moved: false };
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX; const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    {
      const nx = Math.max(0, Math.min(DESKTOP_W - 40, d.origX + dx / scale));
      const ny = Math.max(0, d.origY + dy / scale);
      setLayout(prev => ({ ...prev, [d.id]: { ...prev[d.id], x: nx, y: ny } }));
      // 实时落点提示：这个物件松手会归到哪（工作区高亮 / 文件夹卡高亮），
      // 归入工作区时再给一格吸附预览（ghost 虚线框 = 松手后的落位）
      const obj = positioned.find(o => o.id === d.id);
      if (obj) {
        const sz = sizeOf({ ...obj, pos: layoutRef.current[d.id] || obj.pos });
        const cx = nx + sz.w / 2; const cy = ny + sz.h / 2;
        const candidates = focusZone ? zoneView.filter(z => z.id === focusZone) : zoneView;
        const folder = candidates.find(z => z.collapsed &&
          cx >= z.x && cx < z.x + 210 && cy >= z.y && cy < z.y + 76);
        const zoneHit = folder ? null : candidates.find(z => !z.collapsed &&
          cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h);
        let hint = null;
        if (folder) {
          hint = { kind: 'folder', id: folder.id };
        } else if (zoneHit) {
          const cols = Math.max(1, Math.floor((zoneHit.w - ZONE.pad * 2) / ZONE.cellW));
          const c = Math.max(0, Math.min(cols - 1, Math.round((nx - zoneHit.x - ZONE.pad) / ZONE.cellW)));
          const r = Math.max(0, Math.round((ny - zoneHit.y - ZONE.header - ZONE.pad) / ZONE.cellH));
          hint = {
            kind: 'zone', id: zoneHit.id,
            ghost: {
              x: zoneHit.x + ZONE.pad + c * ZONE.cellW,
              y: zoneHit.y + ZONE.header + ZONE.pad + r * ZONE.cellH,
              w: sz.w, h: sz.h,
            },
          };
        }
        if (JSON.stringify(dropHintRef.current) !== JSON.stringify(hint)) {
          dropHintRef.current = hint;
          setDropHint(hint);
        }
      }
    }
  };

  /**
   * 拖到空白处 = 把物件从工作区里摘出来（写 `zone: ''`）。
   *
   * **2026-07-28 按用户要求停用。** 这条路径只改 board.json 的视觉归属，磁盘上
   * 文件还在 `tasks/<任务>/` 里 —— 桌面说它不属于这个任务、文件系统说属于，两边
   * 对不上。而且很容易误触：拖着挪个位置手一滑落到区外，物件就从任务里"跑"出来了。
   *
   * 拖进文件夹 / 拖进别的工作区仍然可用（那是明确意图）。要恢复改回 true。
   */
  const DRAG_OUT_DETACHES = false;

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragActive(false);
    // click/dblclick 在 pointerup 之后才派发，此时 dragRef 已清 —— 拖完的
    // "余韵"记在这个 ref 上，让点击类 handler 能区分"拖完松手"和"真点击"
    recentDragMovedRef.current = !!d?.moved;
    if (d?.kind === 'object') {
      // 拖放落点判定 → 写显式归属（几何只在松手这一刻起作用）：
      //   落在文件夹卡上 = 收进该文件夹（位置也挪进它的区内）
      //   落在展开工作区内 = 归入该区；落在空白 = 明确移出原归属
      if (d.moved) {
        const obj = positioned.find(o => o.id === d.id);
        const pos = layoutRef.current[d.id];
        const hint = dropHintRef.current;
        if (obj && pos) {
          const sz = sizeOf({ ...obj, pos });
          const prevZone = obj.zoneId || null;
          if (hint?.kind === 'folder') {
            const fz = zonesRef.current[hint.id];
            const n = positioned.filter(o => o.zoneId === hint.id && o.id !== d.id).length;
            patchLayout(d.id, {
              zone: hint.id,
              x: Math.max(0, Math.min(DESKTOP_W - sz.w, fz.x + ZONE.pad + (n % 4) * ZONE.cellW)),
              y: Math.max(0, fz.y + ZONE.header + ZONE.pad + Math.floor(n / 4) * ZONE.cellH),
            });
          } else if (hint?.kind === 'zone') {
            // 吸附：松手落到预览格上；跨区时同时写归属
            const patch = {};
            if (prevZone !== hint.id) patch.zone = hint.id;
            if (hint.ghost) {
              patch.x = Math.max(0, Math.min(DESKTOP_W - sz.w, hint.ghost.x));
              patch.y = Math.max(0, hint.ghost.y);
            }
            if (Object.keys(patch).length) patchLayout(d.id, patch);
          } else if (prevZone && DRAG_OUT_DETACHES) {
            patchLayout(d.id, { zone: '' });
          }
        }
      }
      dropHintRef.current = null;
      setDropHint(null);
      dirtyRef.current.objects.add(d.id);
      scheduleSave();
    }
  };

  const recentDragMovedRef = useRef(false);
  const wasDrag = () => !!(dragRef.current?.moved || recentDragMovedRef.current);

  // ── 动作 ──
  const handleAdd = (o) => {
    if (!onAddToContext) return;
    const path = o.ctxPath || o.path;
    onAddToContext({
      type: 'asset', path,
      name: o.name || o.title,
      size: o.size || 0,
      mime: EXT_MIME[o.ext] || 'text/markdown',
    });
    setAddedPaths(prev => new Set(prev).add(o.id));
  };

  const openViewer = async (o) => {
    if (o.type === 'doc') {
      const r = await Memory.read(projectId, o.readKey).catch(() => null);
      setViewer({ title: o.title, content: r?.content || o.preview || '(空)' });
    } else if (o.type === 'note') {
      const title = o.noteTask ? o.name.replace(/\.md$/i, '') : '便签';
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        const raw = await res.text();
        // 任务便利贴带 note 引用 → 浮层出"编辑"按钮（共享头脑风暴：用户改完
        // agent 下轮从注入清单看到文件、自己 Read 到新内容）
        setViewer({ title, content: raw.replace(/^---\n[\s\S]{0,500}?\n---\n?/, ''), note: o.noteTask ? o : null });
      } catch { setViewer({ title, content: o.text || '', note: o.noteTask ? o : null }); }
    }
  };

  const openFile = (o) => {
    window.open(Assets.artifactFileUrl(projectId, o.path), '_blank', 'noopener');
  };

  const handleDeleteNote = async (o) => {
    try {
      if (o.noteTask) await Assets.removeTaskNote(projectId, o.noteTask, o.name);
      else await Assets.removeNote(projectId, o.name);
      reload();
    } catch (err) { console.warn('[board] delete note failed:', err.message); }
  };

  const focusDeck = (o) => {
    if (o.type === 'world') {
      // 阶段 1 还没有 WorldWindow：先开世界书本身。世界的「打开」到底该是
      // 什么（星形展开？地图全屏？）是阶段 5 的产品决定，在那之前落到最不
      // 会错的地方 —— 那份文件。
      onFocusDeck?.({ kind: 'task', task: o.task, file: o.entry || '世界.md', title: o.title });
    } else if (o.type === 'site') {
      // 站点：开的是"整站"，不是某一个文件 —— 当前看哪一页是窗口内部状态。
      // 试作卡开同一扇窗，但 entry 指向 _drafts/ 里那一份。
      onFocusDeck?.({
        kind: 'site', task: o.task, base: o.base || `tasks/${o.task}`,
        entry: o.entry || 'index.html', title: o.title, pages: o.pages,
        // 构建型（产物根≠源目录）：编辑窗要提示"改的是产物，agent 会同步回源"
        built: !!(o.root && o.root !== o.srcRoot),
      });
    } else if (o.task) {
      // 任务 deck：与会话解绑，原地开最大化编辑窗
      onFocusDeck?.({ kind: 'task', task: o.task, file: o.deckFile || 'canvas.html', title: o.title });
    } else if (o.sid === currentSessionId) {
      onFocusDeck?.({ kind: 'session' });
    } else {
      onEditNav?.();   // 旧式会话 deck 跨会话：切会话后 CanvasFrame 直接开窗
      navigate(`/projects/${projectId}/sessions/${o.sid}`);
    }
  };

  // 双击打开（统一挂在卡片根节点：pointer capture 会把 click/dblclick 重定向到
  // 捕获元素本身，挂内层 div 事件根本到不了 —— 2026-07-27 双击失灵的根因）
  const primaryOpen = (o) => {
    if (o.type === 'doc' || o.type === 'note') openViewer(o);
    else if (o.type === 'image') setDetail(o);
    else if (o.type === 'file') openFile(o);
    else if (o.type === 'deck' || o.type === 'site' || o.type === 'world') {
      if (o.pos.expanded) focusDeck(o);
      else patchLayout(o.id, { expanded: true, z: ++zMaxRef.current });
    }
  };
  primaryOpenRef.current = primaryOpen;   // preview_deck 走同一条"双击"路径

  // ESC = 退回项目区全景（编辑窗开着时归窗口自己处理，别抢）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || deckOpen) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // 先关浮层（项目区面板 / 阅读 / 图片详情），都没开着才退回项目区全景
      if (projectPanel || viewer || detail) {
        setProjectPanel(null); setViewer(null); setDetail(null);
        return;
      }
      if (viewMode !== 'work') return;
      exitToProjectRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deckOpen, viewMode, projectPanel, viewer, detail]);

  /**
   * 进入 / 退出任务（2026-07-28：任务=会话一对一后唯一的一条切换路径）
   *
   *   进入  焦点落到这块区；它绑着会话就连会话一起切过去
   *   退出  回项目区全景，同时退出会话（URL 回 /work，agent 不终止，历史留着）
   *
   * 顶栏面包屑、ESC、任务区标题栏点击，三个入口共用这两个函数，不各写各的。
   */
  const exitToProject = useCallback(() => {
    setViewMode('arrange');
    setFocusZoneId(null);
    fittedKeyRef.current = '';
    if (currentSessionId) navigate(`/projects/${projectId}/work`);
    else requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
  }, [currentSessionId, navigate, projectId]);

  exitToProjectRef.current = exitToProject;

  const enterZone = useCallback((zid) => {
    const sid = zoneSession.get(zid) || (sessionTitles.has(zid) ? zid : null);
    setFocusZoneId(zid);
    fittedKeyRef.current = '';
    setViewMode('work');
    if (sid && sid !== currentSessionId) navigate(`/projects/${projectId}/sessions/${sid}`);
  }, [zoneSession, sessionTitles, currentSessionId, navigate, projectId]);

  // ── 工作区操作：收纳 ↔ 展开（文件夹两态）/ 聚焦 / 自建文件夹 ──
  const patchZone = useCallback((zid, patch) => {
    setZones(prev => (prev[zid] ? { ...prev, [zid]: { ...prev[zid], ...patch } } : prev));
    dirtyRef.current.zones.add(zid);
    scheduleSave();
  }, [scheduleSave]);

  /**
   * 删任务（2026-07-28）：任务和会话一对一，删任务连它的会话一起删。
   * 会话区（还没建任务的）不给删钮 —— 那种走左栏会话列表删。
   */
  const handleDeleteTask = useCallback(async (zid, title) => {
    if (!zid.startsWith('task/')) return;
    const name = zid.slice(5);
    const ok = await useGlobalStore.getState().confirm({
      title: '删除任务',
      message: `删除任务「${title}」？文件夹里的全部产出，以及它绑定的那次对话，会一起删掉。此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await Assets.removeTask(projectId, name);
      // 服务端已把 board.json 里的 zone 行清掉，本地 state 也要同步剪，
      // 否则要刷新页面僵尸文件夹才消失（2026-07-30「删不了」修复的一半）
      removedZonesRef.current.add(zid);
      setZones(prev => {
        const next = { ...prev };
        delete next[zid];
        return next;
      });
      if (focusZoneRef.current === zid) exitToProjectRef.current?.();
      else reload();
      useGlobalStore.getState().showToast(
        r?.removedSession ? '任务和它的会话已删除' : '任务已删除', 'info');
      if (r?.removedSession && r.removedSession === currentSessionId) {
        navigate(`/projects/${projectId}/work`);
      }
    } catch (err) {
      useGlobalStore.getState().showToast(`删除失败：${err.message}`, 'error');
    }
  }, [projectId, currentSessionId, navigate, reload]);

  /**
   * 旧式会话 zone（任务模型之前的遗产，id 是 sessionId 或历史残行）从桌面移除。
   * 只清 board.json 里的这行，不动会话记录 —— 会话在左栏列表照旧能进。
   * 2026-07-30 前这类 zone 没有任何删除入口，永远赖在桌面上。
   */
  const handleRemoveLegacyZone = useCallback(async (zid, title) => {
    const ok = await useGlobalStore.getState().confirm({
      title: '从桌面移除',
      message: `把「${title || '这个工作区'}」从桌面拿掉？只移除这张卡片，不删除对话记录（左栏会话列表里还能找到）。`,
      confirmLabel: '移除',
      danger: false,
    });
    if (!ok) return;
    try {
      await Assets.patchBoard(projectId, { zones: { [zid]: null } });
      removedZonesRef.current.add(zid);
      setZones(prev => {
        const next = { ...prev };
        delete next[zid];
        return next;
      });
      useGlobalStore.getState().showToast('已从桌面移除', 'info');
    } catch (err) {
      useGlobalStore.getState().showToast(`移除失败：${err.message}`, 'error');
    }
  }, [projectId]);

  const focusZoneAction = (zid) => {
    if (zones[zid]?.collapsed) patchZone(zid, { collapsed: false });
    enterZone(zid);
  };

  // ── deck 自动内嵌渲染（2026-07-28：工作台=常驻默认视图后的配套）──
  // 工作内容直接在画布里看：当前会话的 deck 有 canvas 就自动展开成内嵌 iframe。
  // 两个触发源：进会话时 HEAD 探测已有 canvas；agent 正在写 deck（file_changed）。
  // 用户手动收起过（layout.expanded 有显式值）就不抢——每 sid 只自动展开一次。
  const autoExpandedRef = useRef(new Set());
  const pendingExpandRef = useRef(new Set());

  const tryAutoExpand = useCallback((sid) => {
    if (!sid || autoExpandedRef.current.has(sid)) return true;
    // 站点任务的产物物件是 site:task/<名>，不是 deck:task/<名> —— 只认 deck 前缀
    // 的话站点永远等不到物件，pending 集合会一直攒着白试。
    const candidates = [`deck:${sid}`, `site:${sid}`];
    const targetId = candidates.find(id => layoutRef.current[id]?.expanded !== undefined)
      || candidates.find(id => positionedRef.current.some(it => it.id === id));
    if (!targetId) return false;          // 产物物件还没派生出来，等布局更新再试
    if (layoutRef.current[targetId]?.expanded !== undefined) {
      autoExpandedRef.current.add(sid);   // 用户碰过展开态，尊重
      return true;
    }
    const o = positionedRef.current.find(it => it.id === targetId);
    if (!o) return false;
    autoExpandedRef.current.add(sid);
    patchLayout(targetId, { x: o.pos.x, y: o.pos.y, expanded: true, z: ++zMaxRef.current });
    return true;
  }, [patchLayout]);

  useEffect(() => {
    if (!currentSessionId || autoExpandedRef.current.has(currentSessionId)) return;
    if (sessionZone.has(currentSessionId)) return;   // 有任务的会话：deck 是任务 deck
    let cancelled = false;
    fetch(Canvas.artifactUrl(projectId, currentSessionId, 0), { method: 'HEAD' })
      .then((r) => {
        if (cancelled || !r.ok) return;
        if (!tryAutoExpand(currentSessionId)) pendingExpandRef.current.add(currentSessionId);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, currentSessionId, tryAutoExpand, sessionZone]);

  // 布局每次变化把挂起的自动展开消化掉（deck 物件迟到的场景）
  useEffect(() => {
    if (!pendingExpandRef.current.size) return;
    for (const sid of [...pendingExpandRef.current]) {
      if (tryAutoExpand(sid)) pendingExpandRef.current.delete(sid);
    }
  }, [positioned, tryAutoExpand]);

  // 舞台层的 file_changed 触发口：立刻试展开，deck 物件还没派生出来就挂起等布局。
  // 任务 deck 直播（任务模型）：agent 正在写 tasks/<任务>/canvas.html 时，工作
  // 视图把聚焦切到该任务工作区 —— 否则镜头还锁在会话工作区，产出全程不可见
  const requestAutoExpand = useCallback((key) => {
    if (!tryAutoExpand(key)) pendingExpandRef.current.add(key);
    if (key.startsWith('task/')) {
      setFocusZoneId(prev => {
        if (prev === key) return prev;
        fittedKeyRef.current = '';
        return key;
      });
    }
  }, [tryAutoExpand]);

  /**
   * 舞台卡认领目标（agent 刚开始写某个文件）：
   *   ① 目标落脚的工作区不存在就先长一块影子区（任务目录是 agent 现建的）
   *   ② 工作视图把镜头切过去，写的过程当场可见
   */
  const handleStageTarget = useCallback((objectId) => {
    ensureZoneForTarget(objectId);
    const zid = zoneOfObjectId(objectId, currentSessionId);
    if (zid && zid.startsWith('task/')) requestAutoExpand(zid);
  }, [ensureZoneForTarget, currentSessionId, requestAutoExpand]);

  // preview_deck 工具：等价于用户双击那张 deck 卡
  const handlePreviewRequest = useCallback((objectId) => {
    const zid = zoneOfObjectId(objectId, currentSessionId);
    if (zid) requestAutoExpand(zid);
    const o = positionedRef.current.find(it => it.id === objectId);
    if (!o) { pendingPreviewRef.current = objectId; return; }  // 刚写出来的 deck 等产物重拉
    primaryOpenRef.current?.(o);
    followToObject?.(objectId);
  }, [currentSessionId, requestAutoExpand, followToObject]);

  // 挂起的 preview：目标物件一上墙就补开
  useEffect(() => {
    const want = pendingPreviewRef.current;
    if (!want) return;
    const o = positioned.find(it => it.id === want);
    if (!o) return;
    pendingPreviewRef.current = null;
    primaryOpenRef.current?.(o);
    followToObject?.(want);
  }, [positioned, followToObject]);

  // ── 舞台层（StageLayer.jsx 自治）：事件状态机 + 跟随触发 + deck 自动展开触发 ──
  // 哪些任务是站点 —— 舞台寻址要用它把 index/about/style.css 收敛到同一张站点卡
  // Map<任务名, 站点root[]>（'' = 根站，'v2' = 子目录站）——舞台寻址按实例贴卡。
  // 只有站点实例的任务才进表；纯 deck 任务走 resolveObjectId 的 deck 分支
  const siteTasks = useMemo(() => {
    const m = new Map();
    for (const t of tasks) {
      const dirSites = (t.artifacts || []).filter(a => a.kind === 'site' && !a.single);
      if (dirSites.length) m.set(t.id, dirSites.map(a => (a.title ? a.root : '')));
    }
    return m;
  }, [tasks]);
  const { stageCards, stageBadges, dismissStageCard } = useStageState({
    stageRef, currentSessionId, siteTasks, followToObject, tryAutoExpand: requestAutoExpand,
    onStageTarget: handleStageTarget, onPreviewRequest: handlePreviewRequest,
  });

  // 舞台卡分流（StageLayer.jsx）：锚得到可见物件贴物件，锚不到落 dock
  const visibleIdSet = new Set(visibleObjects.map(o => o.id));
  // 区内已占的矩形：生图占位卡据此避开已经摆好的图（跟物件之间的防遮盖同一套判定）
  const stageOccupancy = new Map();
  for (const o of visibleObjects) {
    if (!o.zoneId) continue;
    const sz = sizeOf(o);
    const arr = stageOccupancy.get(o.zoneId) || [];
    arr.push({ x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h });
    stageOccupancy.set(o.zoneId, arr);
  }
  const { anchoredCards, dockPanels, dockChips } = splitStageCards({
    stageCards, positioned, visibleIdSet, visibleZones, focusZone, occupancy: stageOccupancy,
    // 会话绑了任务就用任务区当落点 —— 会话区那会儿已经被任务区取代，
    // 拿 sessionId 去找区找不到，卡片会全掉进 dock 叠成一摞。
    currentSessionId: sessionZone.get(currentSessionId) || currentSessionId,
  });

  // agent 此刻在动谁：橙色光圈套在目标外圈（物件还没上墙就套它落脚的工作区）。
  // 与"已更新"角标分工：光圈=正在动（过程），角标=刚动完（结果）。
  const { ringObjects, ringZones } = useMemo(() => {
    const objs = new Set(); const zs = new Set();
    for (const c of Object.values(stageCards)) {
      if (c.kind === 'chip' || c.kind === 'question' || c.status !== 'running') continue;
      if (c.objectId && positioned.some(o => o.id === c.objectId)) { objs.add(c.objectId); continue; }
      const z = zoneOfObjectId(c.objectId, currentSessionId) || focusZone || currentSessionId;
      if (z) zs.add(z);
    }
    return { ringObjects: objs, ringZones: zs };
  }, [stageCards, positioned, currentSessionId, focusZone]);

  // ── 外层工具栏桥（工具栏合并：控件画在 CanvasToolbar，操作从这里走）──
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      exitToProject: () => exitToProjectRef.current?.(),
      reload,
    };
    return () => { apiRef.current = null; };
  });
  const lastUiRef = useRef('');
  useEffect(() => {
    const fz = viewMode === 'work' ? (focusZoneId || currentSessionId) : null;
    const zv = fz ? zoneView.find(z => z.id === fz) : null;
    // artifactKind / artifactExports：当前聚焦的任务做的是什么形态、可用哪些导出
    // 格式（服务端 kinds/ 注册表吐的）—— 导出菜单据此渲染，不再在前端硬编码
    // 格式表。不上报的话顶栏只能默认按 deck 给 PDF/PPTX，用户点了拿到 400。
    const focusTask = fz && fz.startsWith('task/') ? fz.slice(5) : null;
    const focusTaskObj = focusTask ? tasks.find(t => t.id === focusTask) : null;
    const ui = {
      viewMode,
      focus: zv ? { id: zv.id, title: zv.title, count: zv.memberCount, isSession: sessionTitles.has(zv.id) } : null,
      artifactKind: focusTaskObj?.kind || null,
      artifactExports: focusTaskObj?.exports || null,
    };
    // zoneView 每次布局变更都换新引用（拖拽期间逐帧）—— 序列化对比，内容没变不上报
    const key = JSON.stringify(ui);
    if (key === lastUiRef.current) return;
    lastUiRef.current = key;
    onUiState?.(ui);
  }, [onUiState, viewMode, focusZoneId, currentSessionId, zoneView, sessionTitles, tasks]);

  // ── 渲染 ──
  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#f6f4ef' }}>
      <style>{[
        '@keyframes ndPopIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}',
        '@keyframes ndStageOut{to{opacity:0;transform:scale(.97)}}',
        // 流光：一个动画周期必须**正好走完一个图案周期**，否则每次 loop 重启时
        // 花纹相位对不上，看着就是"扫到一半跳一下"。
        // background-size:200% 时 offset(p) = (W - 2W)·p = -W·p，
        // 100% → -100% 的位移正好是 2W = 一个图案宽。
        // （原来是 size 240% + 200%→-60%：位移 3.64W / 周期 2.4W = 1.517 个周期，
        //   每 1.5s 跳一次。）
        '@keyframes ndShimmer{from{background-position:100% 0}to{background-position:-100% 0}}',
        '@keyframes ndCaret{0%,100%{opacity:1}50%{opacity:0}}',
        '@keyframes ndSpin{to{transform:rotate(360deg)}}',
        '@keyframes ndPulse{from{box-shadow:0 0 0 0 rgba(79,143,91,0.4)}to{box-shadow:0 0 0 12px rgba(79,143,91,0)}}',
        // agent 正在动的目标：外圈橙色呼吸光圈
        '@keyframes ndAgentRing{0%,100%{box-shadow:0 0 0 2px rgba(176,140,79,0.85),0 0 0 7px rgba(176,140,79,0.16),0 6px 20px rgba(40,32,16,0.12)}50%{box-shadow:0 0 0 2px rgba(176,140,79,0.95),0 0 0 13px rgba(176,140,79,0.05),0 6px 20px rgba(40,32,16,0.12)}}',
      ].join('')}</style>
      {/* 桌面滚动容器（唯一的"镜头"就是纵向滚动）*/}
      <div
        ref={scrollRef}
        onWheel={noteUserTakeover}
        onPointerDown={noteUserTakeover}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ position: 'absolute', inset: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
        {/* 占位壳：把缩放后的桌面尺寸交给滚动布局（transform 不改布局尺寸）*/}
        <div style={{
          position: 'relative',
          width: DESKTOP_W * scale, height: boardSize.h * scale,
          margin: '0 auto',
        }}>
        {/* 桌面（定宽 + 点阵背景；视口窄时整体等比缩小，非交互）*/}
        <div
          style={{
            position: 'absolute', left: 0, top: 0,
            // 高度取未裁切的上界，平移后底部才不露白；transform 顺序 = 先平移镜头再缩放
            width: DESKTOP_W, height: stageBounds.h,
            transform: `scale(${scale}) translateY(${-viewOffsetY}px)`,
            transformOrigin: '0 0',
            background: '#f6f4ef',
            backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.07) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        >
          {/* 项目区顶带：项目级四件套（记忆 / 指引 / 品牌 / 文件），只在全景出现 */}
          {viewMode === 'arrange' && (
            <ProjectBand summaries={bandSummaries} onOpen={setProjectPanel} />
          )}

          {/* 工作区（物件下层）：展开态 = 实体区域（标题栏拖整区），收纳态 = 文件夹卡 */}
          {visibleZones.map((z) => z.collapsed ? (
            /* 收起态 = 一条整宽的窄条（2026-07-28 改）：跟展开态同宽同左缘，
               像文件夹列表里的一行，不再是浮在左边的小方卡 */
            <div
              key={z.id}
              onClick={(e) => {
                if (e.target.closest('[data-zone-action]')) return;
                if (!wasDrag()) patchZone(z.id, { collapsed: false });
              }}
              title="点击展开"
              style={{
                position: 'absolute', left: z.x, top: z.y, width: z.w, height: FOLDER_CARD_H - 16,
                zIndex: 1, borderRadius: 14,
                display: 'flex', alignItems: 'center', gap: 12,
                padding: `0 ${GAP.lg}px`,
                background: dropHint?.kind === 'folder' && dropHint.id === z.id ? '#fff8e8' : 'rgba(255,255,255,0.55)',
                border: `1px ${dropHint?.kind === 'folder' && dropHint.id === z.id ? 'solid #b08c4f' : `dashed ${COLOR.borderLt}`}`,
                boxShadow: dropHint?.kind === 'folder' && dropHint.id === z.id
                  ? '0 0 0 3px rgba(176,140,79,0.18), 0 8px 20px rgba(0,0,0,0.14)'
                  : 'none',
                cursor: 'pointer', userSelect: 'none',
                transition: `background 150ms, border-color 150ms, box-shadow 150ms${dragActive ? '' : `, left 380ms ${EASE}, top 380ms ${EASE}, width 380ms ${EASE}`}`,
                animation: POP_IN,
                ...(ringZones.has(z.id) ? { animation: 'ndAgentRing 1600ms ease-in-out infinite' } : null),
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.9)'; }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = dropHint?.kind === 'folder' && dropHint.id === z.id
                  ? '#fff8e8' : 'rgba(255,255,255,0.55)';
              }}
            >
              <Folder size={17} color="#8a7a5c" style={{ flexShrink: 0 }} />
              <span style={{
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.lg, fontWeight: 600, color: COLOR.text,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '52%',
              }}>{z.title}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLOR.sub, flexShrink: 0 }}>
                {z.memberCount} 项
              </span>
              {(zoneSession.get(z.id) || z.id) === currentSessionId && (
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 10,
                  color: COLOR.bg, background: COLOR.text, borderRadius: 5, padding: '2px 7px', flexShrink: 0,
                }}>当前会话</span>
              )}
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <button
                  data-zone-action title="展开"
                  onClick={() => !wasDrag() && patchZone(z.id, { collapsed: false })}
                  style={zoneHeaderBtn}
                ><ChevronsUpDown size={13} /></button>
                <button
                  data-zone-action title="进入任务（切到它的会话）"
                  onClick={() => !wasDrag() && focusZoneAction(z.id)}
                  style={zoneHeaderBtn}
                ><FolderOpen size={13} /></button>
                {z.id.startsWith('task/') ? (
                  <button
                    data-zone-action title="删除任务（连同它的对话）"
                    onClick={() => !wasDrag() && handleDeleteTask(z.id, z.title)}
                    style={{ ...zoneHeaderBtn, color: COLOR.error }}
                  ><Trash2 size={13} /></button>
                ) : (zoneSession.get(z.id) || z.id) !== currentSessionId && z.memberCount === 0 && (
                  /* 只给空区：非空的删了会被"有产物的 session 自动建区"效应立刻重建 */
                  <button
                    data-zone-action title="从桌面移除（不删对话记录）"
                    onClick={() => !wasDrag() && handleRemoveLegacyZone(z.id, z.title)}
                    style={{ ...zoneHeaderBtn, color: COLOR.error }}
                  ><Trash2 size={13} /></button>
                )}
              </span>
            </div>
          ) : (
            <div
              key={z.id}
              data-zone-id={z.id}
              style={{
                position: 'absolute', left: z.x, top: z.y, width: z.w, height: z.h,
                borderRadius: 14, zIndex: 0, pointerEvents: 'none',
                animation: POP_IN,
                border: dropHint?.kind === 'zone' && dropHint.id === z.id
                  ? '1.5px solid #b08c4f'
                  : `1.5px dashed ${z.id === currentSessionId ? 'rgba(60,50,30,0.35)' : 'rgba(0,0,0,0.13)'}`,
                background: dropHint?.kind === 'zone' && dropHint.id === z.id
                  ? 'rgba(255,246,220,0.75)'
                  : (z.id === currentSessionId ? 'rgba(255,252,242,0.6)' : 'rgba(255,255,255,0.35)'),
                boxShadow: dropHint?.kind === 'zone' && dropHint.id === z.id ? '0 0 0 4px rgba(176,140,79,0.12)' : 'none',
                // agent 正在这块区里动手 → 外圈橙色呼吸光圈（目标物件还没上墙时套区）
                ...(ringZones.has(z.id) ? { animation: 'ndAgentRing 1600ms ease-in-out infinite', borderColor: 'rgba(176,140,79,0.75)' } : null),
                transition: `border-color 150ms, background 150ms, box-shadow 150ms${dragActive ? '' : `, left 380ms ${EASE}, top 380ms ${EASE}, width 380ms ${EASE}, height 380ms ${EASE}`}`,
              }}
            >
              <div
                onClick={(e) => {
                  if (e.target.closest('[data-zone-action]')) return;
                  if (wasDrag()) return;
                  // 标题栏 = 进出这个任务的门：在里面就退出（连会话一起），
                  // 在外面就进去（连会话一起切）
                  if (focusZone === z.id) exitToProject();
                  else enterZone(z.id);
                }}
                title={focusZone === z.id ? '退出任务（同时退出这个会话，ESC 同效）' : '进入任务（切到它的会话）'}
                style={{
                  pointerEvents: 'auto', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  margin: 8, height: ZONE.header - 16, padding: '0 14px',
                  borderRadius: 10, background: 'rgba(0,0,0,0.045)',
                  userSelect: 'none', touchAction: 'none',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.075)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.045)'; }}
              >
                {focusZone === z.id
                  ? <LogOut size={15} color={COLOR.sub} />
                  : <FolderOpen size={15} color={COLOR.sub} />}
                <span style={{
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.md, fontWeight: 600, color: COLOR.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{z.title}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLOR.sub }}>{z.memberCount} 项</span>
                {(zoneSession.get(z.id) || z.id) === currentSessionId && (
                  <span style={{
                    fontFamily: FONT_MONO, fontSize: 10,
                    color: COLOR.bg, background: COLOR.text, borderRadius: 5, padding: '2px 7px',
                  }}>当前会话</span>
                )}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                  {focusZone === z.id && z.memberCount > 0 && (
                    <button
                      data-zone-action title="把工作区内容全部加入上下文"
                      onClick={() => {
                        if (wasDrag()) return;
                        positioned.filter(o => o.zoneId === z.id && o.type !== 'deck').forEach(handleAdd);
                      }}
                      style={zoneHeaderBtn}
                    ><Plus size={12} /></button>
                  )}
                  {/* 收起（只在项目区给）：把这个任务折成一张文件夹卡，
                      点卡片再展开。在任务里面时不给 —— 你正站在里面 */}
                  {viewMode === 'arrange' && (
                    <button
                      data-zone-action title="收起成文件夹卡"
                      onClick={() => { if (!wasDrag()) patchZone(z.id, { collapsed: true }); }}
                      style={zoneHeaderBtn}
                    ><FolderInput size={13} /></button>
                  )}
                  {z.id.startsWith('task/') ? (
                    <button
                      data-zone-action title="删除任务（连同它的对话）"
                      onClick={() => { if (!wasDrag()) handleDeleteTask(z.id, z.title); }}
                      style={{ ...zoneHeaderBtn, color: COLOR.error }}
                    ><Trash2 size={13} /></button>
                  ) : (zoneSession.get(z.id) || z.id) !== currentSessionId && z.memberCount === 0 && (
                    /* 只给空区：非空的删了会被"有产物的 session 自动建区"效应立刻重建 */
                    <button
                      data-zone-action title="从桌面移除（不删对话记录）"
                      onClick={() => { if (!wasDrag()) handleRemoveLegacyZone(z.id, z.title); }}
                      style={{ ...zoneHeaderBtn, color: COLOR.error }}
                    ><Trash2 size={13} /></button>
                  )}
                </span>
              </div>
              {z.memberCount === 0 && (
                <div style={{
                  position: 'absolute', top: '50%', left: 0, right: 0, textAlign: 'center',
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, opacity: 0.7,
                }}>
                  本任务的产物会自动出现在这里 · 也可以把画布上的内容拖进来
                </div>
              )}
            </div>
          ))}

          {/* 吸附预览：松手后物件将落到的格位（虚线 ghost）*/}
          {dropHint?.ghost && (
            <div style={{
              position: 'absolute',
              left: dropHint.ghost.x, top: dropHint.ghost.y,
              width: dropHint.ghost.w, height: dropHint.ghost.h,
              border: '1.5px dashed rgba(150,115,60,0.55)', borderRadius: 10,
              background: 'rgba(255,255,255,0.45)',
              zIndex: 0, pointerEvents: 'none',
            }} />
          )}

          {visibleObjects.map((o) => (
            <BoardObject
              key={o.id}
              o={o}
              projectId={projectId}
              currentSessionId={currentSessionId}
              fileVersions={fileVersions}
              added={addedPaths.has(o.id)}
              // 避让系统：拖拽中只有被拖的卡要逐帧跟手（关过渡），被避让的
              // 邻居保持 380ms 滑动 —— 挤开和弹回都是顺滑的
              animateLayout={!dragActive || dragRef.current?.id !== o.id}
              agentActive={ringObjects.has(o.id)}
              onPointerDown={(e) => onObjectPointerDown(e, o)}
              wasDrag={wasDrag}
              onPrimary={() => primaryOpen(o)}
              onAdd={() => handleAdd(o)}
              onOpenViewer={() => openViewer(o)}
              onOpenFile={() => openFile(o)}
              onDetail={() => setDetail(o)}
              onDeleteNote={() => handleDeleteNote(o)}
              // 展开也拿路权（z 置顶）：deck/site 展开变大时是它把邻居挤开，
              // 而不是它自己被避让系统摆走
              onToggleExpand={() => patchLayout(o.id, { expanded: !o.pos.expanded, z: ++zMaxRef.current })}
              onFocus={() => focusDeck(o)}
            />
          ))}

          {/* 舞台层（板内坐标系）：角标 + 贴物件卡（StageLayer.jsx）
              单独一层浮在所有物件之上 —— 物件的 z 是会长的（pin_to_board 每次
              置顶都 zMax+1），跟舞台卡比大小早晚会盖住 agent 正在写的那个框。
              这层自己不吃事件，卡片各自开 pointerEvents。 */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 300, pointerEvents: 'none' }}>
            <StageBoardLayer
              stageBadges={stageBadges}
              anchoredCards={anchoredCards}
              positioned={positioned}
              visibleIdSet={visibleIdSet}
              boardSize={stageBounds}
              scale={scale}
              onDismiss={dismissStageCard}
            />
          </div>
        </div>
        </div>
      </div>

      {/* 舞台 dock（屏幕坐标系，StageLayer.jsx）*/}
      <StageDock dockPanels={dockPanels} dockChips={dockChips} onDismiss={dismissStageCard} />

      {/* 项目区浮层：直接用原 Hub 的四张卡（编辑 / 上传 / 删除全套照旧）*/}
      {projectPanel && (
        <Overlay onClose={() => setProjectPanel(null)}>
          <div style={{
            width: 'min(560px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'auto',
            background: COLOR.bg, borderRadius: 12, padding: GAP.lg,
          }}>
            {projectPanel === 'memory' && <MemoryCard projectId={projectId} />}
            {projectPanel === 'guide' && <InstructionsCard projectId={projectId} />}
            {projectPanel === 'brand' && <BrandCard projectId={projectId} />}
            {projectPanel === 'files' && <FilesCard projectId={projectId} />}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: GAP.md }}>
              <button onClick={() => { setProjectPanel(null); reload(); }} style={toolBtn}>关闭</button>
            </div>
          </div>
        </Overlay>
      )}

      {/* markdown 阅读浮层（便签全文 / 记忆 / 品牌）；任务便利贴可直接编辑（共享头脑风暴）*/}
      {viewer && (
        <Overlay onClose={() => { setViewer(null); setViewerEdit(null); }}>
          <div style={{
            background: COLOR.bg, borderRadius: 12, padding: GAP.lg,
            width: 'min(720px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: GAP.sm, flexShrink: 0 }}>
              <BookOpen size={14} color={COLOR.sub} />
              <span style={{ marginLeft: 6, fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.md, color: COLOR.text }}>{viewer.title}</span>
              {viewer.note && viewerEdit === null && (
                <button title="编辑" onClick={() => setViewerEdit(viewer.content)} style={{ ...toolBtn, marginLeft: 'auto' }}>
                  <PencilLine size={12} />
                </button>
              )}
              {viewer.note && viewerEdit !== null && (
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button onClick={async () => {
                    const o = viewer.note;
                    try {
                      await Assets.putTaskNote(projectId, o.noteTask, o.name, viewerEdit);
                      setViewer(v => ({ ...v, content: viewerEdit }));
                      setViewerEdit(null);
                      reload();
                    } catch (err) { console.warn('[board] save note failed:', err.message); }
                  }} style={toolBtn}>保存</button>
                  <button onClick={() => setViewerEdit(null)} style={toolBtn}>取消</button>
                </div>
              )}
              <button onClick={() => { setViewer(null); setViewerEdit(null); }}
                style={{ ...toolBtn, ...(viewer.note ? { marginLeft: 4 } : { marginLeft: 'auto' }) }}><X size={12} /></button>
            </div>
            {viewerEdit === null ? (
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.7 }}>
                <ReactMarkdown>{viewer.content}</ReactMarkdown>
              </div>
            ) : (
              <textarea
                value={viewerEdit}
                onChange={(e) => setViewerEdit(e.target.value)}
                autoFocus
                style={{
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.7,
                  minHeight: 320, resize: 'vertical', width: '100%', boxSizing: 'border-box',
                  border: `1px solid ${COLOR.borderLt}`, borderRadius: 8, padding: GAP.md,
                  background: '#fffbeb', outline: 'none',
                }}
              />
            )}
          </div>
        </Overlay>
      )}

      {/* 图片详情浮层 */}
      {detail && (
        <Overlay onClose={() => setDetail(null)}>
          <div style={{
            background: COLOR.bg, borderRadius: 12, padding: GAP.lg,
            maxWidth: 'min(920px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'hidden',
            display: 'flex', flexDirection: 'column', gap: GAP.md,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text }}>{detail.name}</span>
              <button onClick={() => setDetail(null)} style={{ ...toolBtn, marginLeft: 'auto' }}><X size={12} /></button>
            </div>
            {/* 图占中间的伸缩位：文件名和底部动作条永远留在画面里，图自己缩着看 */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img
                src={Assets.artifactFileUrl(projectId, detail.path)} alt={detail.name}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8, border: `1px solid ${COLOR.borderLt}` }}
              />
            </div>
            {detail.meta?.prompt && (
              <div style={{
                padding: GAP.md, borderRadius: 8, background: COLOR.bgCard, border: `1px solid ${COLOR.borderLt}`,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                flexShrink: 0, maxHeight: 150, overflow: 'auto',
              }}>
                <div style={{ letterSpacing: '0.06em', marginBottom: 4, color: COLOR.text }}>PROMPT</div>
                {detail.meta.prompt}
                <div style={{ marginTop: GAP.xs }}>
                  {detail.meta.aspectRatio} · {detail.meta.model || detail.meta.provider}
                  {detail.meta.referenceImageCount > 0 && ` · ${detail.meta.referenceImageCount} 张参考图`}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: GAP.sm, justifyContent: 'flex-end' }}>
              <a href={Assets.artifactFileUrl(projectId, detail.path)} target="_blank" rel="noreferrer" style={{ ...toolBtn, textDecoration: 'none' }}>
                <ExternalLink size={12} /> 原图
              </a>
              <button onClick={() => { handleAdd(detail); setDetail(null); }} style={{ ...toolBtn, background: COLOR.text, color: COLOR.bg }}>
                <Plus size={12} /> 加入上下文
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}

/** 单个画布物件（按 type 分派卡片渲染 + 通用 hover 动作条）*/
function BoardObject({
  o, projectId, currentSessionId, fileVersions, added, animateLayout = false, agentActive = false,
  onPointerDown, wasDrag, onPrimary, onAdd, onOpenViewer, onOpenFile, onDetail, onDeleteNote, onToggleExpand, onFocus,
}) {
  const [hover, setHover] = useState(false);
  const sz = sizeOf(o);
  const base = {
    position: 'absolute', left: o.pos.x, top: o.pos.y, width: sz.w,
    zIndex: o.pos.z || 1,
    borderRadius: 10, background: COLOR.bgCard,
    border: `1px solid ${added ? COLOR.text : COLOR.borderLt}`,
    boxShadow: hover ? '0 4px 14px rgba(0,0,0,0.12)' : '0 1px 4px rgba(0,0,0,0.05)',
    cursor: 'grab', userSelect: 'none',
    touchAction: 'none',
    animation: POP_IN,
    // agent 此刻正在动这个物件 → 外圈橙色呼吸光圈（放在 animation 之后才盖得住）
    ...(agentActive ? {
      animation: 'ndAgentRing 1600ms ease-in-out infinite',
      borderColor: 'rgba(176,140,79,0.85)',
    } : null),
    // agent 改布局（pin / board.updated 重拉 / 自动入座）时位置变化以滑动呈现；
    // 用户拖拽期间关掉（要逐帧跟手）—— dragActive 经 animateLayout 传进来
    transition: `${animateLayout ? `left 380ms ${EASE}, top 380ms ${EASE}, ` : ''}width 260ms ${EASE}, box-shadow 0.15s`,
  };

  // deck 卡自带常驻标题栏（编辑 / 内嵌渲染都在上面），外挂那条 hover 工具小标
  // 是重复的第二套按钮 —— 2026-07-28 撤掉，deck 只留卡内那一套。
  const actions = [];
  if (o.type !== 'deck') actions.push({ icon: Plus, title: added ? '已在托盘' : '加入上下文', fn: onAdd });
  if (o.type === 'doc' || o.type === 'note') actions.push({ icon: BookOpen, title: '阅读', fn: onOpenViewer });
  if (o.type === 'image') actions.push({ icon: ExternalLink, title: '详情', fn: onDetail });
  if (o.type === 'file') actions.push({ icon: ExternalLink, title: '打开', fn: onOpenFile });
  if (o.type === 'note') actions.push({ icon: Trash2, title: '删除', fn: onDeleteNote });

  const Actions = hover && actions.length > 0 && (
    <div data-board-action style={{
      position: 'absolute', top: -26, right: 0, display: 'flex', gap: 2,
      background: 'rgba(255,255,255,0.95)', border: `1px solid ${COLOR.borderLt}`,
      borderRadius: 6, padding: 2, zIndex: 5,
    }}>
      {actions.map((a, i) => {
        const Icon = a.icon;
        return (
          <button key={i} title={a.title} data-board-action
            onClick={(e) => { e.stopPropagation(); if (!wasDrag()) a.fn(); }}
            style={{ border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.text, display: 'flex', padding: 3 }}>
            <Icon size={12} />
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      data-board-object={o.id}
      data-board-type={o.type}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        if (e.target.closest('[data-board-action]')) return;
        if (!wasDrag()) onPrimary?.();
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={base}
    >
      {Actions}

      {o.type === 'doc' && (
        <div style={{ padding: GAP.md }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <BookOpen size={13} color="#7c6f5a" />
            <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text }}>{o.title}</span>
          </div>
          <div style={{
            fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub, lineHeight: 1.5,
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {o.preview || o.sub}
          </div>
        </div>
      )}

      {o.type === 'deck' && !o.pos.expanded && (
        <div style={{ padding: GAP.md }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Presentation size={13} color={o.sid === currentSessionId ? COLOR.text : COLOR.sub} />
            <span style={{
              fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
            }}>{o.title}</span>
            {/* 常驻窗口控制（浏览器边栏按钮式，不藏 hover 里）*/}
            <button data-board-action title="编辑（开放 deck 工具）" onClick={onFocus} style={winBtn}>
              <PencilLine size={11} />
            </button>
            <button data-board-action title="内嵌渲染" onClick={onToggleExpand} style={winBtn}>
              <ChevronsUpDown size={11} />
            </button>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
            {o.task ? `任务 deck · 双击内嵌渲染`
              : o.sid === currentSessionId ? '当前会话 · 双击内嵌渲染'
              : `${formatTime(o.mtime)} · 双击内嵌渲染`}
          </div>
        </div>
      )}

      {o.type === 'deck' && o.pos.expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', animation: POP_IN }}>
          <div style={{
            height: 28, display: 'flex', alignItems: 'center', gap: 6, padding: `0 ${GAP.sm}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
          }}>
            <Presentation size={12} color={COLOR.sub} />
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 600, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {o.title}
            </span>
            {/* 常驻窗口控制：编辑 + 收起 */}
            <button data-board-action title="编辑（开放 deck 工具）" onClick={onFocus} style={winBtn}>
              <PencilLine size={11} />
            </button>
            <button data-board-action title="收起" onClick={onToggleExpand} style={winBtn}>
              <ChevronsUpDown size={11} />
            </button>
          </div>
          <div
            style={{ width: DECK_EMBED_W, height: 360, overflow: 'hidden', background: '#fff', borderRadius: '0 0 10px 10px', position: 'relative' }}
          >
            {/* 内嵌渲染：live iframe 缩到 1/3，pointer-events 关闭 —— deck 元素级
                工具（DirectEdit / Drag / Comment）只在聚焦（✏️）后的编辑视图开放。
                LiveFrame 双缓冲：agent 改动时旧画面保留到新文档就绪，不闪白 */}
            <LiveFrame
              title={`deck-${o.task ? `task-${o.task}${o.deckFile && o.deckFile !== 'canvas.html' ? `-${o.deckFile}` : ''}` : o.sid}`}
              src={o.task
                ? `${Assets.artifactFileUrl(projectId, `tasks/${o.task}/${o.deckFile || 'canvas.html'}`)}?v=${versionOfFile(fileVersions, `tasks/${o.task}/${o.deckFile || 'canvas.html'}`)}`
                : Canvas.artifactUrl(projectId, o.sid, versionOfFile(fileVersions, 'canvas.html'))}
              style={{
                width: 1920, height: 1080, border: 0,
                transform: `scale(${DECK_EMBED_W / 1920})`, transformOrigin: '0 0',
                pointerEvents: 'none',
              }}
            />
          </div>
        </div>
      )}

      {o.type === 'site' && !o.pos.expanded && (
        <div style={{ padding: GAP.md }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Globe size={13} color={COLOR.sub} />
            <span style={{
              fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
            }}>{o.title}</span>
            <button data-board-action title="打开站点（响应式预览 + 编辑）" onClick={onFocus} style={winBtn}>
              <PencilLine size={11} />
            </button>
            <button data-board-action title="内嵌预览" onClick={onToggleExpand} style={winBtn}>
              <ChevronsUpDown size={11} />
            </button>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
            {o.single ? '单页 · 双击预览' : `站点 · ${o.pages?.length || 1} 个页面 · 双击预览`}
          </div>
        </div>
      )}

      {o.type === 'site' && o.pos.expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', animation: POP_IN }}>
          <div style={{
            height: 28, display: 'flex', alignItems: 'center', gap: 6, padding: `0 ${GAP.sm}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
          }}>
            <Globe size={12} color={COLOR.sub} />
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 600, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {o.title}
            </span>
            <button data-board-action title="打开站点" onClick={onFocus} style={winBtn}>
              <PencilLine size={11} />
            </button>
            <button data-board-action title="收起" onClick={onToggleExpand} style={winBtn}>
              <ChevronsUpDown size={11} />
            </button>
          </div>
          <div style={{ width: DECK_EMBED_W, height: 400, overflow: 'hidden', background: '#fff', borderRadius: '0 0 10px 10px', position: 'relative' }}>
            {/* 站点缩略：按桌面宽度渲染再等比缩。**不套 1920×1080 固定画框** ——
                站点高度不定，套死比例只会把长页裁掉一半还显示成"设计稿"。
                版本按**入口页**取（entry html + 非 html 资产）：agent 改别的子页
                时缩略图不重载；LiveFrame 双缓冲让必要的重载也不闪白 */}
            <LiveFrame
              title={`site-${o.id}`}
              src={`${Assets.artifactFileUrl(projectId, `${o.base || `tasks/${o.task}`}/${o.entry || 'index.html'}`)}?v=${versionOfSitePage(fileVersions, o.base || `tasks/${o.task}`, o.entry || 'index.html')}`}
              style={{
                width: SITE_VIEWPORTS[0].w,
                height: Math.round(400 / (DECK_EMBED_W / SITE_VIEWPORTS[0].w)),
                border: 0,
                transform: `scale(${DECK_EMBED_W / SITE_VIEWPORTS[0].w})`, transformOrigin: '0 0',
                pointerEvents: 'none',
              }}
            />
          </div>
        </div>
      )}

      {o.type === 'world' && !o.pos.expanded && (
        <div style={{ padding: GAP.md }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Globe size={13} color={COLOR.sub} />
            <span style={{
              fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
            }}>{o.title}</span>
            <button data-board-action title="打开世界书" onClick={onFocus} style={winBtn}>
              <PencilLine size={11} />
            </button>
            <button data-board-action title="铺开地图" onClick={onToggleExpand} style={winBtn}>
              <ChevronsUpDown size={11} />
            </button>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
            {(() => {
              const n = o.nodes || [];
              const p = n.filter(x => x.type !== 'character').length;
              const c = n.filter(x => x.type === 'character').length;
              return n.length ? `世界 · ${p} 个地点 / ${c} 个角色 · 双击铺开` : '世界 · 地图还是空的 · 双击查看';
            })()}
          </div>
        </div>
      )}

      {o.type === 'world' && o.pos.expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', animation: POP_IN }}>
          <div style={{
            height: 28, display: 'flex', alignItems: 'center', gap: 6, padding: `0 ${GAP.sm}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
          }}>
            <Globe size={12} color={COLOR.sub} />
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 600, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {o.title}
            </span>
            <button data-board-action title="打开世界书" onClick={onFocus} style={winBtn}>
              <PencilLine size={11} />
            </button>
            <button data-board-action title="收起" onClick={onToggleExpand} style={winBtn}>
              <ChevronsUpDown size={11} />
            </button>
          </div>
          {/* 地图比框高就自己滚，不去顶别人的位置（布局按固定矩形做避让） */}
          <div
            data-board-action
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              width: DECK_EMBED_W, height: 420, overflowY: 'auto', overflowX: 'hidden',
              background: COLOR.bg, borderRadius: '0 0 10px 10px',
            }}
          >
            <WorldMap projectId={projectId} base={o.base || `tasks/${o.task}`} nodes={o.nodes} />
          </div>
        </div>
      )}

      {o.type === 'image' && (
        <div>
          <div style={{ aspectRatio: '4 / 3', overflow: 'hidden', borderRadius: '10px 10px 0 0', background: '#f4f2ee' }}>
            <img
              src={thumbSrcOf(projectId, o)} alt={o.name} loading="lazy" draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: `${GAP.xs}px ${GAP.sm}px` }}>
            <ImageIcon size={10} color={COLOR.sub} />
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {o.meta?.assetRole ? `[${o.meta.assetRole}] ` : ''}{o.name}
            </span>
          </div>
        </div>
      )}

      {o.type === 'note' && <NoteFaces o={o} />}

      {o.type === 'file' && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `${GAP.sm}px ${GAP.md}px` }}
        >
          <FileText size={12} color={COLOR.sub} />
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {o.name}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: COLOR.sub }}>{formatSize(o.size)}</span>
        </div>
      )}

      {added && (
        <div style={{
          position: 'absolute', bottom: -8, right: -6,
          background: COLOR.text, color: COLOR.bg, borderRadius: 6,
          fontFamily: FONT_MONO, fontSize: 9, padding: '1px 5px',
        }}>
          托盘✓
        </div>
      )}
    </div>
  );
}

/**
 * 便利贴卡体 —— `\n---\n` 分面翻页（note-faces.js 统一约定）。
 * 任务贴（noteTask 非空）右上角带文件名小签，和项目级灵感便签区分。
 * 翻页按钮挂 data-board-action：不触发拖拽 / 双击打开。
 */
function NoteFaces({ o }) {
  const [face, setFace] = useState(0);
  const faces = useMemo(() => splitNoteFaces(o.text || ''), [o.text]);
  const idx = Math.min(face, faces.length - 1);
  const { title, body } = faceParts(faces[idx]);
  const faceBtn = {
    border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.sub,
    fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1, padding: '2px 6px',
  };
  return (
    <div style={{
      padding: GAP.md, background: '#fffbeb', borderRadius: 10, minHeight: SIZES.note.h - 2,
      display: 'flex', flexDirection: 'column',
    }}>
      {(o.noteTask || title) && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4, minWidth: 0 }}>
          {title && (
            <span style={{
              fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{title}</span>
          )}
          {o.noteTask && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: COLOR.sub, marginLeft: 'auto', flexShrink: 0 }}>
              {o.name.replace(/\.md$/i, '')}
            </span>
          )}
        </div>
      )}
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1,
        display: '-webkit-box', WebkitLineClamp: title ? 4 : 6, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {body || o.name}
      </div>
      {faces.length > 1 && (
        <div data-board-action style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 4 }}>
          <button data-board-action style={faceBtn} title="上一面"
            onClick={(e) => { e.stopPropagation(); setFace((idx - 1 + faces.length) % faces.length); }}>‹</button>
          <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: COLOR.sub }}>{idx + 1}/{faces.length}</span>
          <button data-board-action style={faceBtn} title="下一面"
            onClick={(e) => { e.stopPropagation(); setFace((idx + 1) % faces.length); }}>›</button>
        </div>
      )}
    </div>
  );
}

/**
 * 画布内浮层（2026-07-28：层级归位）
 *
 * 原来是 position:fixed 铺满整个视口 —— 看图 / 读便签会把左栏对话和顶栏一起
 * 压暗，跟"编辑窗只在画布内最大化"（DeckWindow）的桌面语义打架。改成 absolute
 * 贴在 BoardCanvas 根上：只压暗桌面这一格，zIndex 压在 DeckWindow(120) 之下。
 */
function Overlay({ children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 110, background: 'rgba(0,0,0,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: GAP.page,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        /* 高度给定值（不是 max-）：里层卡片的 maxHeight:100% 才有参照，能真被压缩 */
        style={{
          animation: POP_IN, height: '100%', width: '100%', minHeight: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}
      >{children}</div>
    </div>
  );
}

function thumbSrcOf(projectId, item) {
  if (item.hasThumb) {
    const base = item.name.replace(/\.[^.]+$/, '');
    return Assets.artifactFileUrl(projectId, `assets/generated/.thumbnails/${base}.thumb.webp`);
  }
  return Assets.artifactFileUrl(projectId, item.path);
}

const toolBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  border: `1px solid ${COLOR.borderLt}`, borderRadius: 6,
  background: COLOR.bgCard, color: COLOR.text, cursor: 'pointer',
  padding: `${GAP.xs}px ${GAP.sm + 2}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
};

const winBtn = {
  border: 0, background: 'rgba(0,0,0,0.05)', borderRadius: 4,
  cursor: 'pointer', color: COLOR.text, display: 'inline-flex', padding: 3, flexShrink: 0,
};

const zoneHeaderBtn = {
  border: 0, background: 'transparent', cursor: 'pointer',
  color: COLOR.text, display: 'flex', padding: 2,
};

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}
