import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  Plus, ExternalLink,
  X, Trash2, BookOpen, FolderOpen, FolderInput, LogOut,
  PencilLine, ChevronsUpDown, Focus,
  Maximize2, Minus, MousePointer2, Move, Hand, Type, PenLine, MessageSquarePlus, LayoutGrid,
  FolderPlus, StickyNote, Link2,
} from 'lucide-react';
import { Assets, Memory, Canvas } from '../../lib/api.js';
import { joinRel } from '../../lib/paths.js';
import { orderByRelations } from '../../lib/relation-order.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, CANVAS, alpha } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, paperCard } from '../../lib/paper.js';
import {
  DESKTOP_W, MARGIN_X, FOLDER_CARD,
  EASE, POP_IN, newStackedZoneRect, packRow, ROW_GAP,
} from '../../lib/board-geometry.js';
import {
  SIZES, sizeOf, actionsOf, primaryOf, readerOf, canAddToContext, isFileBacked,
  chromeOf, cardOf, labelOf,
} from '../../lib/board-kinds.js';
import BoardObject from './cards/BoardObject.jsx';
import FolderCard from './cards/FolderCard.jsx';
import TransformControls from './TransformControls.jsx';
import Minimap from './Minimap.jsx';
import { useBoardCamera } from './useBoardCamera.js';
import { boxUnion } from '../../lib/board-camera.js';
import { emptyPresence, reducePresence, followTarget, MAIN_AGENT_ID, colorFor } from '../../lib/board-presence.js';
import { useStageState, splitStageCards, StageBoardLayer, StageDock } from './StageLayer.jsx';
import { zoneOfObjectId } from '../../lib/stage.js';
import { onChrome } from '../../lib/board-hit.js';
import { TEXT_FONT_CSS, TEXT_SIZE_PX } from '../../lib/text-fonts.js';
import { splitNoteFaces, faceParts } from '../../lib/note-faces.js';
import BindingLayer from './BindingLayer.jsx';
import PresenceLayer from './PresenceLayer.jsx';
import ContextMenu from './ContextMenu.jsx';
import LinkPopover from './LinkPopover.jsx';
import AnnotatePopover from './AnnotatePopover.jsx';
import MoveToPopover from './MoveToPopover.jsx';
import FolderWindow, { parentDir } from './FolderWindow.jsx';
import { useCanvasTools, pointsToPath, pointsBounds, pathPoints, translatePath } from './useCanvasTools.js';
import { useBoardData } from './useBoardData.js';
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

/**
 * 涂鸦墨色。**键必须跟服务端 `sanitizeCanvasData` 的白名单一字不差**
 * （['ink','red','pencil','brass']）—— 那边不认的颜色会被回落成 ink，
 * 这边不认的会渲染成默认色，两边不一致的表现是"我选了红色，存下来变黑"。
 */
/**
 * 约定目录的中文名。这些目录名是**给程序看的**（agent 按约定写、路由按约定扫），
 * 直接把 `notes` 印在画布上是把实现细节漏给用户。agent 自己建的收纳文件夹
 * 用它取的名字，不在这张表里，原样显示。
 */
const FOLDER_LABEL = {
  notes: '便利贴',
};

// SCRIBBLE_INK 随卡体搬去 cards/BoardObject.jsx（只有那边用；
// 它跟服务端 sanitizeCanvasData 的白名单是一对，断言在 board-kinds.test.js）

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
  /** 把画布的工具组交给外层那条常驻工具栏（2026-08-13 范式改造） */
  onToolbarGroups,
  /**
   * 窗的工具组走**另一条线**（CanvasFrame 里 board / win 是两个槽）。
   * 混用一条的话，文件夹窗一开就把画布自己的工具组顶掉，关窗也回不来。
   */
  onWindowToolbarGroups,
  /** 每件东西攒了几条待发标注：{ [id]: n } —— 卡片左上角那枚角标 */
  noteCounts = {},
  // 舞台层（2026-07-28）：ProjectWorkspace 把 run.* 事件经这个 ref 转发进来，
  // 画布把 agent 的实时动作演出来（代码直播 / 终端 / shimmer / chip / 角标）
  stageRef,
  // 编辑窗开着时 ESC 归它（关窗），画布不抢
  deckOpen = false,
  /**
   * 「让 agent 在这儿做点什么」——**画布里的 agent 入口**（2026-08-08）。
   *
   * 用户要的是「寓 agent 于各处……像随处可见的管家，而不是需要劳心费神地跑到
   * 侧边栏去使用」。所以入口不止侧边栏一个，右键菜单是第一处落点。
   *
   * 参数是**上下文而不是文案**：`{ objects?: [id], folder?: rel, at?: {x,y} }`。
   * 画布只说"用户指着这里"，怎么翻译成一句话交给外层 —— 画布不该知道
   * 聊天栏长什么样。
   */
  onAskAgent,
  /**
   * 就地标注（2026-08-13，E3）：右键物件/文件夹 →「标注给 agent」→ 浮层里
   * 写一句话直接发送，agent 立刻起一轮。参数 `{ target: { kind, id, title,
   * typeLabel }, text }` —— 翻译成消息还是外层的事，同 onAskAgent。
   */
  onAnnotate,
}) {
  const navigate = useNavigate();
  const scrollRef = useRef(null);          // 纵向滚动容器（桌面的"视口"）

  // 数据层（加载 / 持有 / 落盘）—— 2026-08-13 拆进 useBoardData.js（刀 4 续）。
  // 派生（objects/folderView）留在本组件：它跟拖拽、影子区缠在一起。
  const {
    artifacts, tasks, folders, sessions, memoryDocs,
    layout, setLayout, zones, setZones, bindings, setBindings,
    guideText, fileCount,
    reload, scheduleSave, patchLayout,
    layoutRef, zonesRef, dirtyRef, layoutLoadedRef, zMaxRef,
  } = useBoardData({ projectId, listVersion, boardVersion });
  // 影子工作区（2026-07-28）：agent 正在往一个还不存在的任务目录里写，产物列表
  // 要等这次写完才知道它存在。先在桌面上把这块区长出来（只在内存里，不落盘），
  // 舞台卡当场就有地方贴；真任务出现后 zone 派生 effect 接管、影子退场。
  const [ghostZones, setGhostZones] = useState({});
  /**
   * 打开着的文件夹窗（`null` = 没开）。
   *
   * ⚠️ 它替掉的是 `cwd`「当前目录」—— 那套的语义是**整块桌面换成某一层**，
   * 两代之前还是 `viewMode` + `focusZoneId`（整理/工作双视图）。用户
   * 2026-08-13 拍板改成"双击文件夹用统一那扇窗打开"：桌面永远是根，进哪一层
   * 是**窗**的事。于是"我在第几层"这个状态从画布身上挪到了窗身上，画布本身
   * 回到只有一层，简单了一大截（顺带删掉了 enterZone / exitToProject /
   * 换层就 zoomToFit / ESC 退层这一整串）。
   *
   * 顶栏面包屑照旧读它（uiState.cwd）—— 那条面包屑现在导航的是窗。
   */
  const [winDir, setWinDir] = useState(null);
  const winDirRef = useRef(null);
  winDirRef.current = winDir;
  /**
   * 正在搬家的 id。
   *
   * 搬家是乐观更新：先把坐标记到**新 id** 上、旧 id 撤掉，再等服务端。那一拍里
   * 产物清单还没重拉，旧 id 还在 `objects` 里而 `layout` 里已经没有它的坐标 ——
   * 于是首次落位那一趟把它当成"新来的"，给它排个座并**写进 board.json**，
   * 留下一条指向已经不存在的路径的死行。这类幽灵条目正是"摆好的版面偶尔自己
   * 回默认位置"的来源之一。
   */
  const movingRef = useRef(new Set());
  /** 正在就地改名的东西（文件夹路径 / 物件 id）—— 卡上的名字换成输入框 */
  const [renamingId, setRenamingId] = useState(null);
  const fittedKeyRef = useRef('');        // 换层之后把镜头带过去：每层只带一次
  // 交互态
  const dragRef = useRef(null);           // { kind:'object', ... }（桌面化后只剩物件拖拽）
  const scaleRef = useRef(1);
  const folderViewRef = useRef([]);
  const camApiRef = useRef(null);   // 相机 API（hook 在下方才调用，用 ref 让上面的回调也够得着）

  /**
   * 当前工具。`select` 是默认，其余是"手上拿着东西"的状态。
   *
   * 工具是**画布级**的一个模式，不是某个物件的属性 —— 所以它住在这里，
   * 由浮动工具栏的模式组切换（FloatingToolbar 的 type:'mode'）。
   *
   * `select` 和 `hand` 是一对（2026-08-08 拆开）：**指针管东西，抓手管镜头**。
   * 在这之前只有 select 一个，平移靠"拖到空白处"—— 画布一满就没有空白可拖，
   * 于是挪镜头这件最频繁的事反而最难做。现在两件事各有各的工具，手上拿的是
   * 哪个一眼看得见（光标也跟着变）。空格临时抓手照旧，它是 hand 的按住版。
   */
  const [tool, setTool] = useState('select');
  /**
   * 涂鸦的子模式（2026-08-13 用户定的双控件）：
   *   ink      落笔 —— 只管画，绝不触碰已有墨迹的控制
   *   arrange  摆放 —— 挪动/缩放已有墨迹（走选中态那套手柄），绝不落笔
   * 两件事在同一支笔下打架打过一整轮（画一笔把卡拖走、想挪笔迹却又画一笔），
   * 拆成显式模式后各自纯粹。每次拿起笔重置回落笔 —— 选笔就是想画。
   */
  const [drawMode, setDrawMode] = useState('ink');
  const drawModeRef = useRef('ink');
  drawModeRef.current = drawMode;
  useEffect(() => { if (tool === 'draw') setDrawMode('ink'); }, [tool]);
  /** 手写文字用什么字体（设置里选，见 globalStore.canvasFont） */
  const canvasFont = useGlobalStore(st => st.canvasFont);
  /** 镜头跟不跟 agent 跑（设置里的开关，默认开） */
  const followAgent = useGlobalStore(st => st.followAgent);
  /** 正在改内容的手写文字：{ id, at:{x,y}, initial }（复用 TextDraft） */
  const [editingText, setEditingText] = useState(null);
  /**
   * 选中的东西（物件 id / 文件夹 id 混装）。
   *
   * 2026-08-13 从单选（`selectedId`，只收墨类）扩成一个集合 —— 用户要「长按
   * 拖动大范围框选 + 右键批量操作」。**只有一份真相**：单选是"集合里正好一件"
   * 的派生，不另开一个状态。变换控制器（旋转/缩放）照旧只认单选的墨类，
   * 那是它的语义（转一堆东西是另一件事，没做）。
   */
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedIdsRef = useRef([]);
  selectedIdsRef.current = selectedIds;
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const selectedIdRef = useRef(null);
  selectedIdRef.current = selectedId;
  const setSelectedId = useCallback((id) => setSelectedIds(id ? [id] : []), []);
  /** 框选：{ a:{sx,sy,wx,wy}, b:{…} }（sx/sy 是画布视口内像素，wx/wy 是世界坐标）*/
  const [marquee, setMarquee] = useState(null);
  const marqueeRef = useRef(null);
  const pressRef = useRef(null);   // 长按候选：{ timer, startX, startY, pointerId }
  const handleDeleteNoteRef = useRef(null);   // Delete 键 effect 挂得早，函数定义在下面
  const [hoveredBinding, setHoveredBinding] = useState(null);
  const [presence, setPresence] = useState(emptyPresence);
  const toolRef = useRef('select');
  toolRef.current = tool;
  const positionedRef = useRef([]);
  const objectsRef = useRef([]);
  const primaryOpenRef = useRef(null);  // "双击打开"的引用（preview_deck 工具复用）
  const pendingPreviewRef = useRef(null);  // preview 目标还没上墙 → 等它出现
  const [addedPaths, setAddedPaths] = useState(() => new Set());
  const [detail, setDetail] = useState(null);       // 图片详情
  const [viewer, setViewer] = useState(null);       // { title, content, note? } markdown 阅读；note = 可编辑的任务便利贴
  const [viewerEdit, setViewerEdit] = useState(null); // null = 阅读态；string = 编辑中的草稿
  const [projectPanel, setProjectPanel] = useState(null);   // 'memory'|'guide'|'brand'|'files'
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

  // ──（数据加载 reload / 布局持久化 scheduleSave·patchLayout：2026-08-13
  //    随数据层一起搬进 useBoardData.js —— 两条铁律的注释也在那边）──

  // ⚠️ 这里曾经有 zoneSession / sessionZone 两张对照表（工作区 ↔ 会话）。
  //
  // 它们服务的是「任务=会话一对一」：点进一个任务就是回到那次对话，一个会话
  // 只服务一个任务。2026-08-08 那条绑定整个废掉了 —— 会话现在归项目，所有会话
  // 面对同一个工作区、同一批文件。跟着没有意义的还有：会话 deck 卡（一个会话
  // 自带一张卡）、「会话分区」（没有文件夹撑着的那种）、以及「进文件夹 = 切
  // 会话」这条导航。文件夹就是文件夹，对话就是对话。

  // ── 物件派生（数据源 → 物件列表；布局只管摆放）──
  //
  // 2026-08-07 起有**两类**物件：
  //   - 磁盘产物的影子（下面这一大段）：本体是文件，board.json 只存它摆在哪
  //   - 画布原生（涂鸦）：board.json 就是本体，从 layout 里带 kind 的条目还原
  const objects = useMemo(() => {
    const out = [];
    // 画布原生物件先进来（它们不依赖任何数据源，只依赖 layout 本身）
    for (const [id, l] of Object.entries(layout)) {
      if (!l?.kind) continue;
      out.push({ id, type: l.kind, data: l.data, native: true, zoneField: l.zone });
    }
    // 项目级文档（记忆 / 品牌）不再当画布物件 —— 2026-07-28 起由桌面顶带
    // 顶栏「⋯」里的四件套之一（2026-08-07 从画布顶带搬过去），跟指引、文件一起构成"项目区"。
    //
    // 会话不再产生画布物件（2026-08-08）：以前每个会话自带一张 deck 卡，那是
    // 「一个会话一份产出」时代的形状。现在产出是文件、会话是对话线程，桌面上
    // 该有的是文件，不是对话。对话在左栏和聊天栏里。
    //
    // 产物卡（多产物平权 2026-07-29）：tasks[].artifacts 一条一卡，没有主/试作等级。
    // 站点子页和样式表仍不各自上墙（用户要的是"我那个网站"，不是
    // index/about/style 三张互不相干的卡）。
    //
    // **id = kind 前缀 + 工作区相对路径**（2026-08-08）：
    //   deck   `deck:主稿.html`、`deck:鉴赏页/初稿/主稿.html`
    //   站点   `site:伊蕾娜手账研究站`；单页 `site:鉴赏页/_drafts/试作.html`
    //   世界   `world:雾都`
    //   文件夹 就是路径本身，`鉴赏页/初稿`
    //
    // 画布上的身份和磁盘上的位置是**同一个字符串**。代价是"移动 = 换身份"，
    // 所以改名必须是一等公民：拖拽走 renameBoardPaths（不是删+插，否则挂在
    // 卡上的批注会被端点清理连坐删掉），agent 背着画布 mv 的由 git 改名检测
    // 对账（board-store 的 reconcileBoardRenames），迟到的防抖写入由转发表
    // 接住。这三条缺一个，症状都是"摆好的版面偶尔自己回到默认位置"。
    for (const t of tasks) {
      for (const a of (t.artifacts || [])) {
        if (a.kind === 'world') {
          // 一个文件夹一个世界（world 命中即独占，见 kinds/index.js），所以 id
          // 不带产物后缀。nodes 是地图本身，不是布局属性 —— 它描述的是磁盘上
          // 的文件夹树，画布只负责把它画出来。
          out.push({
            id: `world:${a.root || t.id}`,
            type: 'world',
            task: t.id,
            base: a.base || a.root || t.id,
            entry: a.entryRel || '世界.md',
            nodes: a.nodes || [],
            exports: a.exports,
            title: a.title || t.title,
            mtime: t.mtime,
          });
        } else if (a.kind === 'site') {
          out.push({
            id: `site:${a.single ? a.entryRel : (a.root || t.id)}`,
            type: 'site',
            single: !!a.single,
            task: t.id,
            base: a.base || a.root || t.id,
            entry: a.entry || 'index.html',
            pages: a.pages || [],
            root: a.root || '',
            srcRoot: a.srcRoot || '',
            exports: a.exports,
            title: a.title || t.title,
            mtime: t.mtime,
          });
        } else {
          out.push({
            id: `deck:${a.file}`,
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
      else if (a.isVideo) out.push({ id: a.path, type: 'video', sid, ...a });
      else out.push({ id: a.path, type: 'file', sid, ...a });
    }
    return out;
  }, [tasks, artifacts, layout]);

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

  // 文件夹标题：zone id 就是工作区相对路径，末段即标题
  const taskTitles = useMemo(
    () => new Map(tasks.filter(t => t.id).map(t => [t.id, t.title])), [tasks]);

  /**
   * 真文件夹 + 影子文件夹（影子只活在内存里，真的一出现就退场）。
   *
   * **磁盘是权威**：board.json 里的文件夹条目只有在 `folders` 里还找得到才渲染。
   * 服务端也会剪一遍，但光靠那边不够 —— 前端手上有自己那份 `/board` 数据，剪枝
   * 跟它是两条并发的路，而且任何一次 patchZone 都会把手上这份写回去，剪了又活。
   * 所以判据要放在**渲染这一层**：画不出来的东西写不回去。
   *
   * 这么剪是安全的，因为文件夹有权威清单（磁盘扫描），物件没有 —— 物件那边
   * board.json 是稀疏的，"不在里面"是常态，不能反过来当"已经没了"。
   */
  const zonesEff = useMemo(() => {
    const live = new Set(folders);
    const out = {};
    for (const [zid, z] of Object.entries(zones)) if (live.has(zid)) out[zid] = z;
    // 影子：agent 刚 mkdir 出来、这一轮扫描还没看到的那个，先占个位
    for (const [zid, g] of Object.entries(ghostZones)) if (!out[zid]) out[zid] = g;
    return out;
  }, [zones, ghostZones, folders]);
  const zonesEffRef = useRef(zonesEff); zonesEffRef.current = zonesEff;

  // 刚被用户删掉的 zone 墓碑：删任务后 tasks 列表要等 reload 才更新，这个
  // effect 会在窗口期把 zone 重建并回写 board.json（e2e 抓到的真 race，
  // 2026-07-30）。墓碑挡住重建；对应 id 从 needed 里消失后墓碑自动出清
  // （同名新任务照常建区）
  const removedZonesRef = useRef(new Set());

  // ── 文件夹派生：磁盘上每个文件夹在画布上有一张卡，缺的建出来并持久化 ──
  //
  // 权威是**磁盘**（服务端扫出来的 `folders`，工作区相对路径），不是会话，也不是
  // 产物。空文件夹也算 —— 你刚建的那个还没往里放东西的，不该等有了产物才显形。
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const needed = new Set(folders);
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
          // title 不写进 board.json：名字从路径读（见 folderView 那段）
        };
        dirtyRef.current.zones.add(zid);
      }
      scheduleSave();
      return next;
    });
  }, [folders, zones, ghostZones, taskTitles, scheduleSave]);

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
    const zid = zoneOfObjectId(objectId);
    if (!zid) return;
    if (zonesRef.current[zid] || ghostZones[zid]) return;
    const title = zid.split('/').pop() || '文件夹';
    setGhostZones(prev => (prev[zid] ? prev : {
      ...prev,
      [zid]: { ...newStackedZoneRect({ ...zonesRef.current, ...prev }), title },
    }));
    // ⚠️ 影子文件夹是**不过磁盘权威剪枝**的（zonesEff 里 ghost 无条件并入），
    // 所以 zoneOfObjectId 一旦凭空造出一个不存在的 id，这里就会长出一块永不
    // 退场的虚线框（退场条件是"真的出现了"，而它永远不会）。寻址回落到
    // sessionId 那一支正是这么来的 —— 2026-08-13 已从 stage.js 拆掉。
  }, [ghostZones]);

  /**
   * 自动摆位 + 归属判定：
   *   1. 有 sid 且工作区存在的未摆放物件 → 区内网格自动入座（deck 先占第一格）
   *   2. 其余未摆放物件 → 画布下方的收纳带（文档架 / deck 架 / 素材 / 文件）
   *   3. 归属 = 物件中心落在工作区有效矩形内（区随内容向下自然生长）
   */
  /**
   * 当前这一层桌面（2026-08-13：「当前目录」模型）。
   *
   * ## 这里替掉了什么
   *
   * 原来这段是 250 行的区内几何：粗网格占位（grids/markCells）、两趟入座、
   * 区内 packRow、收纳分组带、收纳带兜底、一屏画幅、避让修正落盘。它服务的是
   * 「严格分区」那套 —— 文件夹是版面上一块摊开的地，成员摆在框里，所以框内
   * 需要一整套自己的排布。
   *
   * 现在文件夹是**方卡**，进文件夹是**换一层桌面**。于是：
   *   - 一层里只有两种东西：文件夹卡、产物卡。**同一套排布**，不分内外
   *   - 不需要区内坐标系（框里没有东西了），也就不需要分组带和一屏画幅
   *   - 不需要收纳带兜底（每件东西都有它的目录，根目录也是目录）
   *
   * ## 只有一条自动，而且**只算一次**
   *
   * 没有坐标的东西给个落脚点（agent 跑的时候用户不在场，十几张图总得有人定
   * 位置），摆过的一律不动 —— 2026-08-07 定的那条界线继续有效：
   * "给新东西一个落脚点" ≠ "持续重排"。
   *
   * ⚠️ **算出来的落点必须当场落盘**（下面那条 seatFixes effect），不能只活在
   * 这个 memo 里。理由是活生生的事故：坐标不落盘的话，"谁已摆放"这件事会随
   * 交互变化 —— 你一拖某张卡，它就有了坐标、变成"已摆放"，起排线跟着抬高，
   * **其余没坐标的卡每一帧重新排一次**。表现是你拖着 A 想摞到 B 上，B 自己在
   * 往下跑，怎么都对不准（2026-08-13 用检查通道逐帧量出来的：三帧里 deck 从
   * y=434 跑到 447）。
   *
   * 落盘之后这一趟只在"真有新东西"时跑，布局对交互免疫。
   */
  /**
   * 目录索引：哪一层装了哪些文件夹、哪些物件。
   *
   * **桌面和文件夹窗共用这一份**（2026-08-13）。两个地方各写一套"这一层装了
   * 什么"的判据，迟早对不上 —— 而这套判据一点都不平凡：归属要沿着祖先往上找
   * 第一个真文件夹（`notes/` `assets/` 是基础设施目录，不是用户的层），
   * 显式 `zone` 字段还要优先。抄一遍就是抄一个必然漂移的东西。
   */
  const dirIndex = useMemo(() => {
    const parentOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; };
    /**
     * 它住在哪一层。
     *
     * ⚠️ **不是直接取上级目录就完事**：`notes/灵感.md`、
     * `assets/generated/星空.webp` 的上级目录压根不是"用户的文件夹"
     * （`notes/` `assets/` 是基础设施目录，服务端的文件夹清单里没有它们）。
     * 直接按上级目录归属的话，这些东西会落在一个**不存在的层**上 ——
     * 看不见，也没有任何入口能进去。
     *
     * 所以往上走，找到第一个真的是文件夹的祖先；一个都没有就归根。
     * 这也顺带覆盖了"文件夹层级超过扫描深度"那种情况。
     */
    const knownFolders = new Set(Object.keys(zonesEff));
    const homeOf = (path) => {
      let d = parentOf(path);
      while (d && !knownFolders.has(d)) d = parentOf(d);
      return d || '';
    };
    // 显式归属字段仍然优先（拖出来的写 ''）—— 它的去留见任务 #13
    const dirOf = (o) => {
      const stored = layout[o.id];
      if (stored && stored.zone !== undefined) return stored.zone || '';
      if (o.native) return stored?.zone || '';        // 画布原生物件跟着字段走
      if (typeof o.id !== 'string' || o.id.startsWith('doc:')) return '';
      const c = o.id.indexOf(':');
      const path = (c > 0 && /^[a-z]+$/.test(o.id.slice(0, c))) ? o.id.slice(c + 1) : o.id;
      return homeOf(path);
    };

    const byDir = new Map();          // 目录 → 这一层的物件
    for (const o of objects) {
      const d = dirOf(o);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(o);
    }
    const subsOf = new Map();         // 目录 → 直接子文件夹
    for (const zid of Object.keys(zonesEff)) {
      const p = parentOf(zid);
      if (!subsOf.has(p)) subsOf.set(p, []);
      subsOf.get(p).push(zid);
    }
    /**
     * 里面装了什么。**只看直接子级**（跟"打开它看到的那一层"一致）。
     *
     * 条目带完整物件引用 `o` —— 文件夹卡面是真缩略（用户要"看一眼知道装了
     * 什么"）。数据当场就有，一个额外请求都不用发；iframe 的账在 FolderFace
     * 里算：视口门 + 缩放门 + 每卡上限。
     */
    const peekIn = (dir) => {
      const subs = (subsOf.get(dir) || [])
        .map(id => ({ kind: 'folder', title: id.split('/').pop(), o: null }));
      const files = (byDir.get(dir) || [])
        .map(o => ({ kind: o.type, title: o.title || o.name || String(o.id).split('/').pop(), o }));
      const all = [...subs, ...files];
      return { count: all.length, peek: all.slice(0, 4) };
    };
    return { dirOf, byDir, subsOf, peekIn };
  }, [objects, zonesEff, layout]);

  /**
   * 一张文件夹卡的完整描述（名字 + 装了什么）。位置由调用方给：桌面读
   * board.json 的坐标，文件夹窗按网格算。
   */
  const folderCardOf = useCallback((id, pos) => ({
    id,
    kind: 'folder',
    x: pos?.x ?? 0,
    y: pos?.y ?? 0,
    w: FOLDER_CARD.w,
    h: FOLDER_CARD.h,
    /**
     * 名字**从路径读**，不读存档里的 `title`。
     *
     * id 就是路径，路径的最后一段就是名字 —— 再存一份 title 就是第二个真相源，
     * 改名之后它立刻过期（实测：`鉴赏页` 改成 `作品集`，zones 行的 title 还写着
     * 「鉴赏页」）。服务端 tasks 给的标题优先，那是它对形态的命名，不是位置的
     * 复制品。
     */
    title: taskTitles.get(id) || id.split('/').pop() || '文件夹',
    ...dirIndex.peekIn(id),
  }), [dirIndex, taskTitles]);

  /** 文件夹窗要的那一层清单（文件夹 + 物件，位置由窗自己排） */
  const listDir = useCallback((dir) => ({
    folders: (dirIndex.subsOf.get(dir) || []).sort().map(id => folderCardOf(id, null)),
    items: [...(dirIndex.byDir.get(dir) || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  }), [dirIndex, folderCardOf]);

  const { positioned, folderView, contentBottom, seatFixes } = useMemo(() => {
    // ── 桌面这一层（根目录）有哪些文件夹 ──
    //
    // 桌面**永远是根**（2026-08-13）。在这之前它是"当前目录"，双击文件夹整块
    // 换层；现在双击开窗，桌面不动 —— 于是这里不再需要一个"我在第几层"的状态。
    const folders = (dirIndex.subsOf.get('') || []).map((id) => {
      const z = zonesEff[id] || {};
      return folderCardOf(id, {
        x: Number.isFinite(z.x) ? z.x : 0,
        y: Number.isFinite(z.y) ? z.y : 0,
      });
    });

    // ── 桌面上有哪些物件 ──
    const items = [];
    const fresh = [];
    for (const o of (dirIndex.byDir.get('') || [])) {
      const stored = layout[o.id];
      if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
        items.push({ ...o, pos: stored, zoneId: '' });
      } else {
        const it = { ...o, pos: { x: 0, y: 0, z: 1 }, zoneId: '' };
        items.push(it);
        fresh.push(it);
      }
    }

    // ── 唯一一条自动：给还没有坐标的排个落脚点 ──
    //
    // 起排线取"已经摆好的东西（含文件夹卡）的最低边"，新来的从那底下开始铺，
    // 不会压到你摆好的版面上。
    if (fresh.length) {
      let seatedBottom = 0;
      for (const f of folders) seatedBottom = Math.max(seatedBottom, f.y + f.h);
      for (const it of items) {
        if (fresh.includes(it)) continue;
        seatedBottom = Math.max(seatedBottom, it.pos.y + sizeOf(it).h);
      }
      // 字典序只是兜底；关系边（对照/关联凑相邻、接着正向、改自旧→新）
      // 决定真正的先后 —— 顺序是权威，坐标是算的（北极星切片④）
      const byId = new Map(fresh.map(it => [String(it.id), it]));
      const ordered = orderByRelations(
        [...byId.keys()].sort((a, b) => a.localeCompare(b)),
        bindings,
      ).map(id => byId.get(id));
      const packed = packRow(
        ordered.map(it => { const sz = sizeOf(it); return { id: it.id, w: sz.w, h: sz.h }; }),
        { width: DESKTOP_W - MARGIN_X * 2, xMin: MARGIN_X, yTop: seatedBottom ? seatedBottom + ROW_GAP : MARGIN_X },
      );
      const slotById = new Map(packed.slots.map(s => [s.id, s]));
      for (const it of fresh) {
        const s = slotById.get(it.id);
        if (s) it.pos = { ...it.pos, x: s.x, y: s.y };
      }
    }

    let bottom = 0;
    for (const f of folders) bottom = Math.max(bottom, f.y + f.h);
    for (const it of items) bottom = Math.max(bottom, it.pos.y + sizeOf(it).h);
    // 新算出来的落点交给下面那条 effect 落盘（不落的话布局会跟着交互抖，见上）
    const seatFixes = {};
    for (const it of fresh) {
      if (movingRef.current.has(it.id)) continue;   // 正在搬家，别给旧 id 排座
      seatFixes[it.id] = { x: it.pos.x, y: it.pos.y };
    }
    return { positioned: items, folderView: folders, contentBottom: bottom, seatFixes };
  }, [dirIndex, folderCardOf, layout, zonesEff, bindings]);
  positionedRef.current = positioned;
  folderViewRef.current = folderView;
  // 全目录树的物件（不止桌面这一层）—— 文件夹窗里的右键要按 id 找得到它们
  objectsRef.current = objects;


  /**
   * 首次落点落盘。
   *
   * 只写"这一趟才算出来的"那些（`layout` 里没有的），所以第二帧就没得写了，
   * 不会来回。写完之后它们在 `layout` 里，布局对拖拽这类交互免疫。
   */
  useEffect(() => {
    const ids = Object.keys(seatFixes || {});
    if (!ids.length) return;
    /**
     * ⚠️ 有东西正在改身份（搬家 / 改名）时**一律不落位**。
     *
     * 改名是前缀改名：`鉴赏页` → `作品集` 之后，里面每一件的 id 都变了。产物
     * 清单和文件夹清单不是同一拍回来的，中间那一拍里 `作品集` 还不在文件夹
     * 清单里，于是归属规则往上走一直走到根 —— 里面的东西短暂地"出现在桌面上"，
     * 这一趟就给它们排座并写盘。等清单追上，它们回到文件夹里，却带着一组
     * 在根上算出来的坐标。
     *
     * 落位是"给新东西一个落脚点"，不是"给正在改名的东西重新安家"。等这一拍过去。
     */
    if (movingRef.current.size) return;
    setLayout(prev => {
      let touched = false;
      const next = { ...prev };
      for (const id of ids) {
        if (prev[id] && Number.isFinite(prev[id].x)) continue;   // 已经有坐标了
        next[id] = { ...(prev[id] || {}), ...seatFixes[id], z: prev[id]?.z ?? 1 };
        dirtyRef.current.objects.add(id);
        touched = true;
      }
      if (touched) scheduleSave();
      return touched ? next : prev;
    });
  }, [seatFixes, scheduleSave]);

  // ⚠️ 这里曾有「遮盖修正落盘」：区内避让把卡推开之后，把新坐标写回 board.json。
  // 区内避让 2026-08-07 起其实就没在跑了（`resolveZoneAvoidance` 是死导入、
  // `overlapFixes` 声明后从未被写入，这条 effect 一直在空转），2026-08-13
  // 随区内几何一起删除。

  // ⚠️ 这里曾经有「工作区堆叠」：一条 effect 每帧把所有 zone 按序纵向排成一列、
  // 宽度拉成整个桌面宽，被手动搬过的靠 `pinned` 标记退出队列。
  //
  // 那是「严格分区」时代的几何 —— 分区是版面上的一条带，不是桌面上的一个东西。
  // 方向变了：文件夹是**能自由摆在任意位置的卡**，那就不该有一支队伍每帧把它
  // 推回去。连带没有意义的还有 `pinned`（不再有"队列"可退出）和成员跟随平移
  // （区不再被系统挪动，成员自然不用跟着补偿）。
  //
  // 新建文件夹的落点：右键处（openContextMenu 里现算），或者 newStackedZoneRect
  // 给的栈底空位（agent 建的那种，用户不在场时总得有个不重叠的地方）。


  /**
   * 可见性 2026-08-13 起**不再是一件事** —— `positioned` 和 `folderView` 本来
   * 就只装当前这一层。以前要在这儿过滤两遍（聚焦模式看哪块区、收起的文件夹
   * 内容不铺开），是因为所有层的东西都摊在同一个坐标系里。
   */
  const draggingId = dragRef.current?.kind === 'object' ? dragRef.current.id : null;
  const visibleObjects = positioned;
  const visibleZones = folderView;

  // ── 桌面高度 / 镜头裁切（2026-07-28：空白画幅自适应）──
  //
  // 桌面坐标系是全局的（工作区一路往下堆），但工作视图只看一块区。之前直接把
  // 全局坐标铺给滚动容器 —— 聚焦第 3 块任务区时，上面两块的高度变成一片死空白，
  // 下面还挂着全部内容的余量，"进任务文件夹上下大片空画幅"就是这么来的。
  //
  // 现在工作视图给桌面一个偏移量：聚焦区被平移到桌面顶端（bandY），高度只按
  // 这块区自己的内容算。整理视图 offset=0，行为不变。
  // ── 内容边界（喂给相机约束）──────────────────────────────────────────
  //
  // 2026-08-07：`viewOffsetY` 那套「镜头裁切」连同 `boardH` 的一屏判定一起
  // **退役**。它们当初存在只有一个原因 —— 没有相机，所以只能靠平移内容和
  // 撑高占位壳来伪造取景。记忆里那条「viewOffsetY / zoneMinHOf / boardH
  // 这三个是一组，必须一起改」的陷阱，本质就是这个伪造的代价。
  //
  // 现在「聚焦区吃满一屏」由**镜头去框它**（flyToBox）实现：意图一模一样，
  // 但工作区的高度回归贴内容，三常量的联动整个消失。
  const contentBox = useMemo(() => {
    const boxes = visibleZones.map(z => ({ x: z.x, y: z.y, w: z.w, h: z.h }));
    for (const o of visibleObjects) {
      const sz = sizeOf(o);
      boxes.push({ x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h });
    }
    // 一件东西都没有时给一个桌面大小的空板，不然相机没有可约束的东西
    return boxUnion(boxes) || { x: 0, y: 0, w: DESKTOP_W, h: 600 };
  }, [visibleZones, visibleObjects]);

  const camera = useBoardCamera({ paneRef: scrollRef, contentBox, handTool: tool === 'hand' });
  const { cam } = camera;
  const scale = cam.z;
  scaleRef.current = scale;
  camApiRef.current = camera;

  // ── 画布工具（选择 / 文字 / 笔 / 评论）────────────────────────────────
  //
  // 落点归属：新东西放进**当前聚焦的工作区**（有的话），否则算项目级散件。
  // 这跟拖放的归属规则是同一条 —— 谁的框套住它就是谁的。
  const zoneAtPoint = useCallback((w) => {
    const hit = folderViewRef.current.find(z =>
      w.x >= z.x && w.x < z.x + z.w && w.y >= z.y && w.y < z.y + z.h);
    return hit?.id || null;
  }, []);

  /** 写一段字 → 落成 .md（走便签那条路，agent 读得到） */
  /**
   * 写一段字 → **画布原生文字**（2026-08-08 改）。
   *
   * 以前它一律落成 `.md` 便签，理由是"canvas-native 的东西 agent 读不到，
   * 而用户写字十有八九是想说给 agent 听"。那个判断被推翻了：用户要的是
   * **白板** —— 在工程文件旁边随手写一句、画一笔，跟涂鸦是同一件事。
   * 想说给 agent 听的走右键「新建便利贴」，那条路原样还在。
   *
   * 字体走设置里选的默认值（fontPref），跟涂鸦一样只活在 board.json。
   */
  const handleCreateText = useCallback((text, at) => {
    const t = String(text || '').trim();
    if (!t) return null;
    const id = `text:${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
    // 尺寸按字数估：一行约 26 个全角字符，行高 1.6。估不准也没关系 ——
    // 卡体是 height:auto，这个值只用来定命中区和避让矩形（同涂鸦那条教训）。
    const cols = Math.min(26, Math.max(6, t.length));
    const lines = Math.ceil(t.length / cols) + (t.match(/\n/g)?.length || 0);
    const px = { sm: 13, md: 16, lg: 22, xl: 30 }[canvasFont.size] || 16;
    // 归属跟涂鸦同一条规则：落点被谁的文件夹卡框住就归谁。原来这里漏写 zone，
    // 在文件夹层里写的字会静默归到根上（2026-08-13 查实补齐）
    const zid = zoneAtPoint({ x: at.x, y: at.y });
    patchLayout(id, {
      x: Math.round(at.x), y: Math.round(at.y), z: ++zMaxRef.current,
      w: Math.round(cols * px * 1.05) + 12,
      h: Math.round(lines * px * 1.6) + 10,
      kind: 'text',
      data: { t, font: canvasFont.font, size: canvasFont.size, color: 'ink' },
      ...(zid ? { zone: zid } : {}),
    });
    return id;
  }, [patchLayout, canvasFont, zoneAtPoint]);

  /** 打开某段字的内容编辑（双击 / 文字工具点在字上，两个入口共用） */
  const openTextEditor = useCallback((o) => {
    setEditingText({ id: o.id, at: { x: o.pos.x, y: o.pos.y }, initial: o.data?.t || '' });
  }, []);

  const commitTextEdit = useCallback((text) => {
    const ed = editingText;
    setEditingText(null);
    if (!ed) return;
    const t = String(text || '').trim();
    const old = layoutRef.current[ed.id];
    if (!old) return;
    if (!t) {
      // 清空 = 删掉这段字（服务端对空文本也是整条丢弃，两边同一个语义）
      setLayout(prev => { const next = { ...prev }; delete next[ed.id]; return next; });
      dirtyRef.current.objects.add(ed.id);
      scheduleSave();
      return;
    }
    // 尺寸按新内容重估（跟创建同一套公式 —— 它只定命中区和避让矩形）
    const cols = Math.min(26, Math.max(6, t.length));
    const lines = Math.ceil(t.length / cols) + (t.match(/\n/g)?.length || 0);
    const px = { sm: 13, md: 16, lg: 22, xl: 30 }[old.data?.size] || 16;
    patchLayout(ed.id, {
      w: Math.round(cols * px * 1.05) + 12,
      h: Math.round(lines * px * 1.6) + 10,
      data: { ...old.data, t },
    });
  }, [editingText, patchLayout, scheduleSave]);

  /** 写一张便利贴 → `notes/*.md`（**这条是给 agent 看的**，走右键菜单） */
  const createNoteAt = useCallback(async (at) => {
    const text = window.prompt('便利贴写点什么？（agent 下一轮就能看到）');
    if (!text?.trim()) return;
    try {
      const name = `${Date.now().toString(36)}.md`;
      await Assets.putTaskNote(projectId, name, text.trim());
      const file = `notes/${name}`;
      // 落在右键处（而不是让它自动入座）—— 用户是**指着地方**写的
      patchLayout(file, { x: Math.round(at?.x ?? 0), y: Math.round(at?.y ?? 0), z: ++zMaxRef.current });
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`便利贴写不进去：${err.message}`, 'error');
    }
  }, [projectId, patchLayout, reload]);

  /** 新笔画跟旧墨迹"有结合点"的判距（世界像素）：笔尖挨着就算一伙 */
  const MERGE_DIST = 24;

  /** 画一笔 → 画布原生物件（只活在 board.json）；挨着旧墨迹就并进去成一组 */
  const handleCreateScribble = useCallback((points) => {
    const box = pointsBounds(points, 8);
    const d = pointsToPath(points, box.x, box.y);
    if (!d) return;

    /**
     * 归组（2026-08-13 用户定）：判据是**点到点的最小距离**，不是包围盒相交 ——
     * 一条长对角线的 bbox 大得离谱，按 bbox 合并会把半屏的墨迹吸成一坨。
     * bbox 只做快筛。已被旋转/缩放过的组不并（合并数学在变换下不成立，
     * 且用户既然特意摆过它，新笔画多半不是它的一部分）。
     */
    const host = (() => {
      for (const o of positionedRef.current) {
        if (o.type !== 'scribble' || !o.native) continue;
        if (o.data?.rotation || (o.data?.scale && o.data.scale !== 1)) continue;
        const sz = sizeOf(o);
        if (box.x > o.pos.x + sz.w + MERGE_DIST || box.x + box.w < o.pos.x - MERGE_DIST
          || box.y > o.pos.y + sz.h + MERGE_DIST || box.y + box.h < o.pos.y - MERGE_DIST) continue;
        const oldPts = pathPoints(o.data?.d).map(p => ({ x: p.x + o.pos.x, y: p.y + o.pos.y }));
        for (const q of points) {
          for (const p of oldPts) {
            if (Math.hypot(p.x - q.x, p.y - q.y) <= MERGE_DIST) return o;
          }
        }
      }
      return null;
    })();

    if (host) {
      const sz = sizeOf(host);
      const nx = Math.min(host.pos.x, box.x);
      const ny = Math.min(host.pos.y, box.y);
      const nw = Math.max(host.pos.x + sz.w, box.x + box.w) - nx;
      const nh = Math.max(host.pos.y + sz.h, box.y + box.h) - ny;
      const merged = `${translatePath(host.data.d, host.pos.x - nx, host.pos.y - ny)} ${pointsToPath(points, nx, ny)}`;
      // 服务端 8000 字符闸门：并不进去就各过各的（丢笔画是最差的结果）
      if (merged.length < 7900) {
        patchLayout(host.id, {
          x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh),
          data: { ...host.data, d: merged },
        });
        return;
      }
    }

    const id = `scribble:${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
    const zid = zoneAtPoint({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
    patchLayout(id, {
      x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h),
      z: ++zMaxRef.current,
      kind: 'scribble', data: { d, color: 'ink', width: 2 },
      ...(zid ? { zone: zid } : {}),
    });
  }, [zoneAtPoint, patchLayout]);

  const canvasTools = useCanvasTools({
    // 摆放模式下笔不落墨：喂给工具层一个它不认识的名字，所有分支自然闭合，
    // 指针事件穿回物件拖拽/选中那条路（下面守卫只对墨类放行）
    tool: tool === 'draw' && drawMode === 'arrange' ? 'arrange' : tool,
    toWorld: camera.toWorld,
    // 一次性工具（one-shot）：写完一段自动回到指针。想连写的人多按一次 T 的
    // 代价，远小于"忘了自己拿着笔，想挪字却弹出新输入框"的困惑（用户报）。
    onCreateText: (t, at) => { handleCreateText(t, at); setTool('select'); },
    onCreateScribble: handleCreateScribble,
  });

  /**
   * 关系线的端点解析：**物件和工作区都可以当端点**（用户明确要求文件夹之间
   * 也能连线）。拿不到矩形就返回 null，那条线这一帧不画 —— 端点可能被收进
   * 文件夹了、可能属于当前不可见的工作区，都不是异常。
   */
  const rectOfId = useCallback((id) => {
    const o = positionedRef.current.find(it => it.id === id);
    if (o) { const sz = sizeOf(o); return { x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h }; }
    const z = folderViewRef.current.find(zz => zz.id === id);
    if (z) return { x: z.x, y: z.y, w: z.w, h: z.h };
    return null;
  }, []);

  /** 给浮层/提示用的端点名字。手写字直接报内容 —— 它没有别的名字。 */
  const titleOfId = useCallback((id) => {
    const o = positionedRef.current.find(it => it.id === id) || objectsRef.current.find(it => it.id === id);
    if (o) {
      if (o.type === 'text') return `「${String(o.data?.t || '').slice(0, 14)}」`;
      if (o.type === 'scribble') return '一笔涂鸦';
      return o.title || id.split('/').pop() || id;
    }
    return id.split('/').pop() || id;   // 文件夹（zone）或还没摆上桌的产物
  }, []);

  /**
   * 标注的第二个出口：**留在画布** —— 一段文字 + 一条 `annotates` 关系。
   *
   * **批注是关系不是自由文字**：光写一段话飘在旁边，过两天就没人知道它在说谁；
   * 存成关系之后，被批注的东西一移动，批注跟着走，线自己重画。
   *
   * 2026-08-13 从工具栏的「标注(C)」搬到这儿 —— 那个工具连同它的 commentDraft
   * 输入框一起删了，两条标注路（留在画布 / 发给 agent）收成同一张浮层的两个
   * 按钮，见 AnnotatePopover 的说明。
   *
   * 落点**贴着目标右边**，不落在光标处：光标可能正压在卡上（右键菜单从卡上
   * 弹、标注按钮就长在卡的右上角），落在那儿等于把一段字盖在产物脸上。
   *
   * 批量标注（框选之后右键）落**一段字 + N 条线**：一句话说的是这一组，
   * 抄成 N 段一样的字是把同一件事记 N 遍，改一处还得改 N 处。
   */
  const keepAnnotation = useCallback((targetIds, fallbackAt, text) => {
    const t = (text || '').trim();
    const ids = (Array.isArray(targetIds) ? targetIds : [targetIds]).filter(Boolean);
    if (!t || !ids.length) return;
    const rects = ids.map(rectOfId).filter(Boolean);
    // 落在整组的右边（取所有目标的最右沿、最上沿）
    const at = rects.length
      ? { x: Math.max(...rects.map(r => r.x + r.w)) + 24, y: Math.min(...rects.map(r => r.y)) }
      : fallbackAt;
    if (!at) return;
    const noteId = handleCreateText(t, at);
    if (!noteId) return;
    // 文字落好了才连线 —— 端点必须真实存在，否则画布上留一条通向虚空的线
    const stamp = `${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
    const links = {};
    ids.forEach((id, i) => { links[`b:${stamp}${i}`] = { type: 'annotates', from: noteId, to: id, by: 'user' }; });
    setBindings(prev => ({ ...prev, ...links }));
    Assets.patchBoard(projectId, { bindings: links }).catch(() => {});
  }, [rectOfId, handleCreateText, projectId, setBindings]);

  // 舞台层仍按世界坐标贴卡，夹取上界取内容外沿
  const stageBounds = {
    w: Math.max(DESKTOP_W, contentBox.x + contentBox.w),
    h: contentBox.y + contentBox.h,
  };

  // ── 镜头（相机导演）────────────────────────────────────────────────

  /** 用户接管：任何主动操作后 8s 内跟随不抢镜头 */
  const noteUserTakeover = useCallback(() => {
    userHoldUntilRef.current = Date.now() + 8000;
    camApiRef.current?.noteTakeover();
  }, []);

  /** 跟随 agent：把镜头飞到物件（跟随关 / 用户接管期 / 物件不可见时不动）*/
  const followToObject = useCallback((objectId) => {
    if (!followRef.current) return;
    if (Date.now() < userHoldUntilRef.current) return;
    // 桌面上找不到 = 它在某个文件夹里（桌面只画根这一层）→ 不跟：镜头飞到
    // 一个看不见的坐标上，用户只会看到画布莫名其妙滑走
    const o = positionedRef.current.find(it => it.id === objectId);
    if (!o) return;
    const sz = sizeOf(o);
    // 保持当前缩放，只把目标挪到视口中心 —— 跟随不该顺手改变用户的缩放，
    // 那会让"我正在看细节"突然被拉远。
    camApiRef.current?.flyToPoint({ x: o.pos.x + sz.w / 2, y: o.pos.y + sz.h / 2 });
  }, []);

  /**
   * 开局框一次景，之后镜头永远归用户。
   *
   * 以前这条是"换一层就重新框"（cwd 变化时跑）。桌面只剩一层之后没有"换层"
   * 这件事了，只剩挂载那一次。
   *
   * ⚠️ **不要改成"等内容到齐再框"**。试过，当场翻车：内容分两批到（文件夹一批、
   * 产物一批），等第一批就框会把镜头对到只有产物的那块矩形上，文件夹卡全被顶到
   * 视口上方看不见（检查通道量到 y=-118）。要么开局框（这时内容为空，等于不动
   * 镜头 —— 也就是现在这样），要么老老实实等两批都到齐再框。
   */
  useEffect(() => {
    if (fittedKeyRef.current === 'desktop') return;
    fittedKeyRef.current = 'desktop';
    camApiRef.current?.zoomToFit({ force: true });
  }, [folderView]);

  // ⚠️ 这里曾有「切 session 就切视图」：有会话进工作模式聚焦它的区、回 /work
  // 回项目区。会话与产物 08-08 解绑、双视图 08-13 退役之后，切对话不该动你
  // 站在哪一层 —— 那是两件事。

  // ── 拖拽（物件 / 工作区 / 背景平移共用 pointer 流）──
  const onObjectPointerDown = (e, o) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-board-action]')) return;   // 按钮不触发拖拽
    // 抓手态（工具或空格）：这一下归镜头。卡片的 handler 挂在卡片上、画布的
    // 挂在外层，事件是**先卡片后画布**冒泡上去的 —— 卡片不主动让路的话，
    // 按在卡片上会同时起一个物件拖拽和一次平移，两边各拽各的。
    if (camApiRef.current?.isHandMode?.()) return;
    // 工具在手（画笔/批注）时这一下归工具：按在卡上是要在卡上画、标，不是要
    // 拖卡。少了这条，笔画起点落在卡上会同时武装一次物件拖拽 —— 抬 z、写盘，
    // 而笔画提交又吞掉抬手，dragRef 残骸让那张卡黏住光标
    // （2026-08-13 查实的真 bug，三个症状同一根）。
    //
    // 两条豁免：
    //   - 涂鸦的**摆放模式**对墨类放行 —— 那个模式存在的意义就是挪墨迹。
    //   - **文字工具**整个放行 —— 它 2026-08-13 起只认双击（见 useCanvasTools），
    //     单击这一下本来就该按指针工具那套走："单击不触发，当作操作文字本身"。
    if (toolRef.current !== 'select' && toolRef.current !== 'text') {
      const arrange = toolRef.current === 'draw' && drawModeRef.current === 'arrange';
      if (!(arrange && o.native)) return;
    }
    recentDragMovedRef.current = false;
    noteUserTakeover();
    setDragActive(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const z = ++zMaxRef.current;
    patchLayout(o.id, { x: o.pos.x, y: o.pos.y, z });
    dragRef.current = {
      kind: 'object', id: o.id, startX: e.clientX, startY: e.clientY,
      // 抓点存**世界坐标**：move 时用「当前相机下光标处的世界点 − 抓点」求
      // 位移。相机在拖拽中怎么动（滚轮平移、Ctrl+滚轮缩放），卡都钉在光标下。
      grabWorld: camera.toWorld(e.clientX, e.clientY),
      lastClientX: e.clientX, lastClientY: e.clientY,
      origX: o.pos.x, origY: o.pos.y, moved: false,
    };
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX; const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    d.lastClientX = e.clientX; d.lastClientY = e.clientY;
    {
      // 位移在**世界坐标系**里算：当前相机下光标处的世界点 − 按下时的抓点。
      //
      // 老算法是 `origX + 屏幕位移/scale`，公式里没有相机项 —— 拖着卡滚一格
      // 滚轮，相机平移了，卡却按屏幕位移原地不动，光标底下的目标就这么丢了
      // （2026-08-13 用户报）。Ctrl+滚轮缩放还会叠一个瞬间跳变（历史总位移
      // 除以新 scale）。两次 screenToWorld 相减把相机自然消掉，怎么动都跟手。
      //
      // 落点不再夹范围（原来 x∈[-800,2160]、y≥-800）：画布已全向无限，
      // "拖丢了找不回来"由小地图和 Shift+1 兜底，不由夹子兜底。
      const w = camera.toWorld(e.clientX, e.clientY);
      const nx = d.origX + (w.x - d.grabWorld.x);
      const ny = d.origY + (w.y - d.grabWorld.y);
      setLayout(prev => ({ ...prev, [d.id]: { ...prev[d.id], x: nx, y: ny } }));
      // 实时落点提示：这个物件松手会归到哪（工作区高亮 / 文件夹卡高亮）。
      //
      // **只提示归属，不预告坐标**：2026-08-07 前这里还会算一个 244×210 的
      // 吸附格并画成虚线 ghost，松手时把卡吸过去。那就是「拖动往鼠标反方向
      // 跑」的全部原因 —— 拖拽过程逐帧是像素级跟手的，是松手那一下被吸到
      // 格点上，向左拖 30px 能落到 −34px。落点由用户的手决定，不由格子决定。
      const obj = positioned.find(o => o.id === d.id);
      if (obj) {
        const sz = sizeOf({ ...obj, pos: layoutRef.current[d.id] || obj.pos });
        const cx = nx + sz.w / 2; const cy = ny + sz.h / 2;
        // 一层里只有文件夹方卡，判据从两条（收起态窄条 / 展开态框）收成一条
        const folder = folderView.find(z =>
          cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h);
        /**
         * 没落在文件夹上 → 看是不是**摞在另一件东西上**：桌面语言里这就是
         * "把这两件归到一起"，系统当场建个文件夹把两个都收进去（2026-08-13）。
         *
         * 判据用**被拖那张的中心**落在对方矩形里，跟落进文件夹同一套 ——
         * 用矩形相交会太灵敏，挨着摆一下就成夹。
         */
        const over = folder ? null : positioned.find(it => {
          if (it.id === d.id || it.native) return null;     // 涂鸦/文字不成夹
          if (!isFileBacked(it)) return null;               // doc 那类没有磁盘位置
          const s2 = sizeOf(it);
          return cx >= it.pos.x && cx < it.pos.x + s2.w && cy >= it.pos.y && cy < it.pos.y + s2.h;
        });
        const hint = folder ? { kind: 'folder', id: folder.id }
          : over ? { kind: 'group', id: over.id } : null;
        if (JSON.stringify(dropHintRef.current) !== JSON.stringify(hint)) {
          dropHintRef.current = hint;
          setDropHint(hint);
        }
      }
    }
  };

  // 拖拽中相机动了：滚轮不产生 pointermove，光标停着纯滚轮时上面那条换算
  // 没机会跑，卡会在原世界坐标上"漂走"，直到鼠标动一像素才猛地追上。
  // 这里在相机每次变化时用最后一次已知的光标位置补一帧。
  useEffect(() => {
    const d = dragRef.current;
    if (!d || d.kind !== 'object' || !d.grabWorld) return;
    const w = camera.toWorld(d.lastClientX, d.lastClientY);
    setLayout(prev => ({
      ...prev,
      [d.id]: { ...prev[d.id], x: d.origX + (w.x - d.grabWorld.x), y: d.origY + (w.y - d.grabWorld.y) },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam]);

  /**
   * ⚠️ 这里曾有「拖到空白处 = 搬出当前文件夹」（DRAG_OUT_DETACHES / DETACH_MARGIN）。
   * **2026-08-13 删掉，因为它在当前目录模型下必然误触** —— 用户报「我总是拖一下
   * 就把文件移出文件夹了」，查出来是判据本身错了：
   *
   *   判定拿的是「物件在**这一层**的坐标」跟「`zones[当前文件夹]` 的矩形」比，
   *   可后者是**那张文件夹卡在它父层里的位置**（288×352 的一张卡）。两个数字
   *   活在不同的坐标空间里，比较毫无意义 —— 进了文件夹随便拖一下，中心大概率
   *   就落在那张卡的 48px 之外，于是"明确拖出去了"，文件真的被搬回根目录。
   *
   * 修法不是给它换个正确的矩形（一层桌面是无限的，压根没有"这一层的边界"这种
   * 东西），而是换成**显式动作**：右键「移动到…」挑目标（用户 2026-08-13 定）。
   * 拖拽只剩两条语义，都要求落点上真有个东西：落在文件夹卡上=搬进去、
   * 摞在另一件东西上=归成一夹。落在空地上就只是挪了个位置。
   */

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragActive(false);
    // click/dblclick 在 pointerup 之后才派发，此时 dragRef 已清 —— 拖完的
    // "余韵"记在这个 ref 上，让点击类 handler 能区分"拖完松手"和"真点击"
    recentDragMovedRef.current = !!d?.moved;
    // 点了一下没拖动 = 选中（只有墨类进选中态，产物卡的动作是开窗/拖动）
    if (d?.kind === 'object' && !d.moved) {
      const obj = positioned.find(o => o.id === d.id);
      setSelectedId(obj?.native ? d.id : null);
    }
    if (d?.kind === 'object') {
      // 落点判定 → **真的搬文件**（2026-08-08）：
      //   落在文件夹卡上 = 搬进那个目录
      //   摞在另一件东西上 = 两件归成一个新文件夹
      //   落在空地 = 只是挪了个位置，什么也不搬（搬出去走右键「移动到…」）
      if (d.moved) {
        const obj = positioned.find(o => o.id === d.id);
        const pos = layoutRef.current[d.id];
        const hint = dropHintRef.current;
        if (obj && pos) {
          const prevZone = obj.zoneId || null;
          let target = null;                       // null = 不搬；字符串 = 搬到这个目录（'' = 根）
          if (hint?.kind === 'group') {
            const other = positioned.find(it => it.id === hint.id);
            if (other) groupInto(obj, other);
            dropHintRef.current = null;
            setDropHint(null);
            dirtyRef.current.objects.add(d.id);
            scheduleSave();
            return;
          }
          if (hint?.kind === 'folder' || hint?.kind === 'zone') {
            if (hint.id !== prevZone) target = hint.id;
          }
          if (target !== null) moveEntry(obj, target, { x: pos.x, y: pos.y });
        }
      }
      dropHintRef.current = null;
      setDropHint(null);
      dirtyRef.current.objects.add(d.id);
      scheduleSave();
    }
  };

  // ── 框选（长按起手）────────────────────────────────────────────────
  //
  // 「选中指针控件的时候能够长按拖动以大范围框选」（用户 2026-08-13）。
  //
  // **长按**而不是直接拖：空白处拖拽这个手势已经归相机平移了，那是画布上用得
  // 最多的动作，不能抢。所以按住不动 LONG_PRESS_MS 才转框选 —— 这期间手一动
  // （>4px）就当平移，定时器作废。
  //
  // 转框选的那一下必须**把已经武装的相机平移撤掉**，不然一次手势同时拉框和推
  // 镜头：框的起点钉在世界坐标上，镜头一跑，框看着就往反方向歪。
  const LONG_PRESS_MS = 220;
  /** 比这更小的框算"点了一下空地"（清空选中），不算框选 */
  const MARQUEE_MIN = 6;

  const armMarquee = (e) => {
    if (toolRef.current !== 'select' || e.button !== 0) return;
    if (onChrome(e)) return;
    if (e.target.closest?.('[data-board-object],[data-board-zone],[data-transform-handle]')) return;
    clearTimeout(pressRef.current?.timer);
    const sx = e.clientX; const sy = e.clientY;
    const { pointerId } = e;
    pressRef.current = {
      startX: sx, startY: sy, pointerId,
      timer: setTimeout(() => {
        camera.onPointerUp({ pointerId });         // 撤掉这一下已武装的平移
        const r = scrollRef.current?.getBoundingClientRect();
        const w = camera.toWorld(sx, sy);
        const a = { sx: sx - (r?.left || 0), sy: sy - (r?.top || 0), wx: w.x, wy: w.y };
        marqueeRef.current = { a, b: a };
        setMarquee({ a, b: a });
      }, LONG_PRESS_MS),
    };
  };

  const moveMarquee = (e) => {
    const p = pressRef.current;
    if (p && !marqueeRef.current) {
      if (Math.abs(e.clientX - p.startX) + Math.abs(e.clientY - p.startY) > 4) {
        clearTimeout(p.timer); pressRef.current = null;    // 手动了 = 这是平移
      }
      return false;
    }
    const m = marqueeRef.current;
    if (!m) return false;
    const r = scrollRef.current?.getBoundingClientRect();
    const w = camera.toWorld(e.clientX, e.clientY);
    const b = { sx: e.clientX - (r?.left || 0), sy: e.clientY - (r?.top || 0), wx: w.x, wy: w.y };
    marqueeRef.current = { ...m, b };
    setMarquee({ ...m, b });
    return true;
  };

  /** @returns 这次抬手是不是被框选吃掉了（吃掉了相机和物件都别再收尾） */
  const endMarquee = () => {
    clearTimeout(pressRef.current?.timer);
    pressRef.current = null;
    const m = marqueeRef.current;
    marqueeRef.current = null;
    if (!m) return false;
    setMarquee(null);
    if (Math.abs(m.b.sx - m.a.sx) < MARQUEE_MIN && Math.abs(m.b.sy - m.a.sy) < MARQUEE_MIN) {
      setSelectedIds([]);           // 长按了但没拉开 = 点了一下空地
      return true;
    }
    const x0 = Math.min(m.a.wx, m.b.wx); const x1 = Math.max(m.a.wx, m.b.wx);
    const y0 = Math.min(m.a.wy, m.b.wy); const y1 = Math.max(m.a.wy, m.b.wy);
    // 判据是**相交**不是包含：拉框的人不会去精确包住每一件，框到一半就算
    // （访达、Figma 都是相交）
    const hit = (x, y, w, h) => x < x1 && x + w > x0 && y < y1 && y + h > y0;
    const ids = [];
    for (const o of positionedRef.current) {
      const sz = sizeOf(o);
      if (hit(o.pos.x, o.pos.y, sz.w, sz.h)) ids.push(o.id);
    }
    for (const z of folderViewRef.current) if (hit(z.x, z.y, z.w, z.h)) ids.push(z.id);
    setSelectedIds(ids);
    recentDragMovedRef.current = true;   // 这一下不是点击，别让它把选中清掉
    return true;
  };

  /**
   * 把一个物件真的搬进另一个文件夹。
   *
   * **画布上在哪，磁盘上就在哪** —— 这是用户定的操作系统桌面语义。以前这里只写
   * 一个 `zone` 字段（画布说不属于、磁盘说属于），那种分裂正是「拖进拖出改归属」
   * 这个概念被废掉的原因。
   *
   * id 就是路径，所以搬完之后这张卡换了身份：先把新坐标记在**新 id** 上，再让
   * 服务端搬（它会同步改 board.json 里的物件 / 文件夹 / 归属字段 / 关系线端点），
   * 拿回新 board 后按它对齐本地 state。失败就原样回滚，卡片弹回去。
   */
  const moveEntry = useCallback(async (obj, toFolder, at) => {
    const from = String(obj.id).slice(String(obj.id).indexOf(':') + 1);
    const base = from.split('/').pop();
    /**
     * ⚠️ `POST /move` 的 `to` 是**目标目录**，不是目标文件路径
     * （`{ from:'稿件/主稿.html', to:'定稿' }`，`''` = 工作区根）。
     *
     * 这里一直传的是拼好的新路径（`定稿/主稿.html`），服务端拿它去 stat 目录 →
     * 不是目录 → 404 `target folder not found`。也就是用户看到的"目标文件夹
     * 不存在"：**拖进任何文件夹都失败，而摞两件成夹反倒能成** —— 因为成夹那条
     * 路传的正好是目录本身。
     *
     * 新路径仍然要在本地算一份：id 就是路径，搬完这张卡换身份，乐观更新得先
     * 把坐标记到**新 id** 上。
     */
    const toDir = toFolder || '';
    const to = joinRel(toDir, base);
    if (to === from) return;
    movingRef.current.add(obj.id);
    const nextId = obj.id.includes(':') ? `${obj.id.split(':')[0]}:${to}` : to;

    // 乐观更新：新 id 上先摆好，旧 id 撤掉。不这么做的话下一帧产物清单还没刷新，
    // 卡片会闪一下回到旧位置
    setLayout(prev => {
      const next = { ...prev };
      next[nextId] = { ...(prev[obj.id] || {}), x: at.x, y: at.y, zone: undefined };
      delete next[obj.id];
      return next;
    });
    try {
      const r = await Assets.moveEntry(projectId, from, toDir);   // ← 目录，不是新路径
      if (r?.board) {
        // 服务端已经把身份都改好了 —— 以它为准，别让本地的旧条目再写回去
        setZones(r.board.zones || {});
        setBindings(r.board.bindings || {});
        dirtyRef.current = { objects: new Set(), zones: new Set() };
      }
      reload();
    } catch (err) {
      setLayout(prev => {                       // 搬失败：身份没变，把卡放回去
        const next = { ...prev };
        next[obj.id] = { ...(next[nextId] || {}), x: obj.pos.x, y: obj.pos.y };
        delete next[nextId];
        return next;
      });
      useGlobalStore.getState().showToast(`搬不过去：${err.message}`, 'error');
    } finally {
      // 产物清单重拉之后旧 id 才会真正消失，这之前一直挡着别给它排座
      setTimeout(() => movingRef.current.delete(obj.id), 4000);
    }
  }, [projectId, reload]);

  /**
   * 把一个**文件夹**搬进另一个文件夹。
   *
   * 服务端是同一个 `/move`（它对目录和文件一视同仁，还自带"不能搬进自己肚子里"
   * 的拦截）。分成两个函数只是因为前端这边身份不一样：文件夹住在 `zones` 里、
   * 没有 `pos`，走不了 moveEntry 那套乐观更新（那套要把坐标记到新 id 上）。
   * 这里干脆不做乐观更新 —— 服务端回来的 board 就是权威，reload 一次到位。
   */
  const moveZone = useCallback(async (zid, toDir) => {
    const from = String(zid);
    const base = from.split('/').pop();
    const to = joinRel(toDir, base);
    if (to === from) return;
    movingRef.current.add(from);
    try {
      const r = await Assets.moveEntry(projectId, from, toDir || '');
      if (r?.board) {
        setZones(r.board.zones || {});
        setBindings(r.board.bindings || {});
        dirtyRef.current = { objects: new Set(), zones: new Set() };
      }
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`搬不过去：${err.message}`, 'error');
      reload();
    } finally {
      setTimeout(() => movingRef.current.delete(from), 4000);
    }
  }, [projectId, reload, setZones, setBindings]);

  /**
   * 「移动到…」的落点：一组 id（物件或文件夹）搬进同一个目录。
   *
   * **串行**跑：每一次搬家服务端都会重写一遍 board 并返回，并发发出去的话
   * 后一个请求带的是搬家前的画布，回来直接把前一个的结果盖掉。
   */
  const moveManyTo = useCallback(async (ids, toDir) => {
    for (const id of ids) {
      /**
       * ⚠️ 找物件要**两处都找**：`positioned` 只有桌面这一层，而「移动到…」
       * 在文件夹窗里也能点 —— 窗里那些东西住在别的层。只查 positioned 的话，
       * 窗里选了目标什么都不会发生，连个报错都没有（2026-08-13 真跑抓到）。
       */
      const raw = positionedRef.current.find(o => o.id === id)
        || objectsRef.current.find(o => o.id === id);
      if (raw) {
        const pos = layoutRef.current[id] || raw.pos || { x: 0, y: 0 };
        // eslint-disable-next-line no-await-in-loop
        await moveEntry({ ...raw, pos }, toDir, { x: pos.x, y: pos.y });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (zonesEffRef.current[id]) await moveZone(id, toDir);
    }
  }, [moveEntry, moveZone, layoutRef]);

  const recentDragMovedRef = useRef(false);
  const wasDrag = () => !!(dragRef.current?.moved || recentDragMovedRef.current);

  // ── 动作 ──
  const handleAdd = (o) => {
    if (!onAddToContext) return;
    const path = o.ctxPath || o.path;
    onAddToContext({
      // 托盘条目的契约是**必有 id**：ComposerTray 拿它当 key，移除按
      // `it.id !== id` 过滤。这里以前不带 —— 两个画布条目撞 undefined key，
      // 点任何一个的 × 会把画布来的条目一次删光。path 唯一且稳定，直接当 id
      //（上传那路的 id 是 newId('asset')，不会撞）。
      id: path,
      type: 'asset', path,
      name: o.name || o.title,
      size: o.size || 0,
      mime: EXT_MIME[o.ext] || 'text/markdown',
    });
    setAddedPaths(prev => new Set(prev).add(o.id));
  };

  /**
   * 进阅读器。走哪条路由由形态表的 `reader` 决定（board-kinds.js），
   * 这里只实现三种阅读器本身。
   */
  const READERS = {
    // 记忆 / 品牌 / 指引三张卡的画布分身：正文在服务端，不在磁盘产物里
    async memory(o) {
      const r = await Memory.read(projectId, o.readKey).catch(() => null);
      setViewer({ title: o.title, content: r?.content || o.preview || '(空)' });
    },

    // 普通 .md 产物（世界.md / 正文章节 / agent 写的任何 markdown）。
    // 2026-08-03 之前这类文件只有「打开」= window.open 原始 URL，浏览器给一坨
    // 纯文本 —— 41KB 的正文点开满屏 `**` 和 `##`。阅读器本来就是现成的，
    // 缺的只是这条路由。frontmatter 不剥：便签的 `---` 头是会话元数据该藏，
    // 普通 md 的 frontmatter 是内容的一部分，替用户删掉是自作主张。
    async file(o) {
      const title = o.name || o.title || 'markdown';
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        setViewer({ title, content: await res.text() });
      } catch {
        setViewer({ title, content: o.preview || '(读不出来)' });
      }
    },

    async note(o) {
      const title = o.noteTask ? o.name.replace(/\.md$/i, '') : '便签';
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        const raw = await res.text();
        // 任务便利贴带 note 引用 → 浮层出"编辑"按钮（共享头脑风暴：用户改完
        // agent 下轮从注入清单看到文件、自己 Read 到新内容）
        setViewer({ title, content: raw.replace(/^---\n[\s\S]{0,500}?\n---\n?/, ''), note: o.noteTask ? o : null });
      } catch { setViewer({ title, content: o.text || '', note: o.noteTask ? o : null }); }
    },
  };

  const openViewer = async (o) => {
    const reader = readerOf(o);
    if (reader) await READERS[reader](o);
  };

  const openFile = (o) => {
    window.open(Assets.artifactFileUrl(projectId, o.path), '_blank', 'noopener');
  };

  const handleDeleteNote = async (o) => {
    // 画布原生物件（涂鸦/文字）：board.json 就是本体，删掉那一条就是删掉它。
    // 走下面文件那条路会静默失败 —— native 物件没有 `name`，垃圾桶和右键
    // 删除对它们从来没生效过（2026-08-13 查实）。
    if (o.native) {
      setLayout(prev => { const next = { ...prev }; delete next[o.id]; return next; });
      dirtyRef.current.objects.add(o.id);   // scheduleSave 对缺席的 id 发 null = 服务端删除
      scheduleSave();
      return;
    }
    try {
      // 便利贴落点从 `tasks/<任务>/notes/` 收敛成工作区的 `notes/` 之后，
      // 删除只认文件名（不再需要先知道它属于哪个任务）
      if (o.noteTask) await Assets.removeTaskNote(projectId, o.name);
      else await Assets.removeNote(projectId, o.name);
      reload();
    } catch (err) { console.warn('[board] delete note failed:', err.message); }
  };
  handleDeleteNoteRef.current = handleDeleteNote;

  const focusDeck = (o) => {
    if (o.type === 'world') {
      // 世界窗（2026-08-07）：地图 + 世界书两个视图，跟 deck / 站点同一副外壳。
      // 在这之前这里落到「开那份 .md」—— 因为当时压根没有世界窗。
      onFocusDeck?.({
        kind: 'world', task: o.task, base: o.base || o.task,
        entry: o.entry || '世界.md', title: o.title, nodes: o.nodes,
        exports: o.exports,
      });
    } else if (o.type === 'site') {
      // 站点：开的是"整站"，不是某一个文件 —— 当前看哪一页是窗口内部状态。
      // 试作卡开同一扇窗，但 entry 指向 _drafts/ 里那一份。
      onFocusDeck?.({
        kind: 'site', task: o.task, base: o.base || o.task,
        entry: o.entry || 'index.html', title: o.title, pages: o.pages, exports: o.exports,
        // 构建型（产物根≠源目录）：编辑窗要提示"改的是产物，agent 会同步回源"
        built: !!(o.root && o.root !== o.srcRoot),
      });
    } else {
      // deck：与会话解绑，原地开最大化编辑窗。
      //
      // ⚠️ 判据从 `o.task` 改成走 else（2026-08-13）。`task` 是**文件夹路径**，
      // 而住在工作区根上的 deck 路径是空串 —— 空串 falsy，于是根上的每一份
      // deck 都掉进下面那条"旧式会话 deck"分支，`navigate` 到
      // `/sessions/undefined`。今天双击先走展开态所以少有人踩，但产物本来就
      // 默认摊在根上，展开态一取消这条就是每次必中。
      //
      // 顺带删掉的两条分支（会话 deck / 跨会话切换）是**死代码**：deck 物件
      // 只有一处构造（本文件 `id: deck:${a.file}`），那里一律带 `task: t.id`，
      // 所以"没有 task 的 deck"从 08-08 起就不存在了。
      onFocusDeck?.({ kind: 'task', task: o.task, file: o.deckFile || 'canvas.html', title: o.title, exports: o.exports });
    }
  };

  // 双击打开（统一挂在卡片根节点：pointer capture 会把 click/dblclick 重定向到
  // 捕获元素本身，挂内层 div 事件根本到不了 —— 2026-07-27 双击失灵的根因）
  const PRIMARY = {
    read: openViewer,
    detail: (o) => setDetail(o),
    openFile,
    // 产物：双击直接开那扇窗。
    // ⚠️ 这里曾经是两段式（先展开成画布上的内嵌渲染，再双击一次才开窗）。
    // 展开态 2026-08-13 退役 —— "在画布上并排看两份 deck"这件事本来就该由窗
    // 来做，而一个会自己变大两倍半的卡片是所有落点逻辑的噪声源。
    open: focusDeck,
    // 手写文字：双击改内容（原来是 null —— 写下的字永远改不了）
    editText: openTextEditor,
  };

  const primaryOpen = (o) => PRIMARY[primaryOf(o)]?.(o);
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
      // 有选中先取消选中（比"关窗"近一级的撤销）
      if (selectedIdsRef.current.length) { setSelectedIds([]); return; }
      // ⚠️ 文件夹窗的 ESC **不在这儿**：ArtifactWindow 自己挂了一条（escToClose），
      // 两边都挂的话按一下会同时收选中和关窗。
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deckOpen, projectPanel, viewer, detail]);

  /**
   * 换工具的单键快捷键。
   *
   * 工具栏的 title 里从一开始就写着「（V）（T）（P）（C）」，但**全仓没有一处
   * 监听过这些键** —— 提示写了一个不存在的功能，比不写更坏。2026-08-08 补上，
   * 顺带给抓手一个 H（跟 Figma / Miro 同键位，用户不用学）。
   *
   * 带修饰键的一律放行：Ctrl+V 是粘贴，不是换工具。
   */
  useEffect(() => {
    // c（标注）2026-08-13 退役：标注不再是一种"拿在手里的工具"，见 AnnotatePopover
    const KEYS = { v: 'select', h: 'hand', t: 'text', p: 'draw' };
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // 全局唤出 agent（2026-08-08）：斜杠。用户要「不用找鼠标，沉浸在画布里
      // 随手支使」。选的是 `/` 而不是某个字母 —— 字母全被工具占了，而斜杠在
      // 各家工具里本来就是"开始输入命令"的意思。
      if (e.key === '/') { e.preventDefault(); onAskAgent?.({}); return; }
      const next = KEYS[e.key?.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAskAgent]);

  // Delete / Backspace 删掉选中的墨类物件（选中态 2026-08-13 才有，这键也是）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const sel = selectedIdRef.current;
      if (!sel) return;
      const o = positionedRef.current.find(x => x.id === sel);
      if (!o?.native) return;
      e.preventDefault();
      setSelectedId(null);
      handleDeleteNoteRef.current?.(o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * 打开一个文件夹 = 开那扇窗（2026-08-13）。
   *
   * ⚠️ 这儿曾是 `enterZone` / `exitToProject`（换层）。它们连同「ESC 退一层」
   * 一起删了 —— 打开和关闭现在是同一扇窗的两端，退回桌面不需要"退层"这个
   * 概念。窗内下钻也走这个函数（同一扇窗换 dir）。
   */
  const openFolder = useCallback((zid) => { if (zid) setWinDir(zid); }, []);
  /**
   * 窗里那两个回调必须是**稳定引用**：FolderWindow 拿它们 memo 工具组，而
   * ArtifactWindow 的 effect 依赖工具组、清理函数又会清空工具组 —— 每渲染一个
   * 新函数就等于每渲染跑一遍「清空→重设」，两次状态变更互相触发，死循环。
   */
  const folderGoUp = useCallback(() => setWinDir(d => parentDir(d)), []);
  const closeFolderWindow = useCallback(() => setWinDir(null), []);
  /**
   * 「整理」—— 现在是**手动**的一次动作，不再每帧自动跑（2026-08-07）。
   *
   * 做法故意选了最简单的一种：**把坐标忘掉**。没有坐标的物件会被入座那一趟
   * 重新排（packRow：列宽取最宽的卡、行高贴该行最高的、整块居中），所以
   * "整理"不需要第二套排版实现 —— 它就是让入座重来一遍。
   *
   * 两处不碰：
   * - **画布原生物件**（涂鸦）：它的坐标就是它本身，不是"摆在哪"。把一笔涂鸦
   *   流进网格等于毁了内容。
   * - 收起的文件夹：里面的东西没在渲染，排了也看不见，等展开时自然入座。
   *
   * **文件夹也一起排**（2026-08-08）：从左到右铺、排满换行，跟桌面上的图标一样。
   * 平时不动它们（你摆哪儿就是哪儿），但这是个显式动作 —— 你点了"整理"，
   * 意思就是"把这一桌收拾干净"。存量数据尤其需要：它们的坐标是旧的纵向堆叠
   * 写下来的，全挤在左边一列。
   */
  const tidyBoard = useCallback(() => {
    const targets = positionedRef.current.filter(o => isFileBacked(o));
    const zv = folderViewRef.current;
    if (!targets.length && !zv.length) return;

    setLayout(prev => {
      const next = { ...prev };
      for (const o of targets) { delete next[o.id]; dirtyRef.current.objects.add(o.id); }
      return next;
    });

    if (zv.length) {
      // 顶层文件夹进网格；嵌套的（`a/b`）不单独排 —— 它画在父文件夹里面，
      // 位置由父的排布决定，单独摆会跑到外面去
      const byZid = new Map(zv.filter(z => !z.id.includes('/')).map(z => [z.id, z]));
      const tops = orderByRelations(
        [...byZid.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(z => z.id),
        bindings,
      ).map(id => byZid.get(id));
      const GAP_X = 24; const GAP_Y = 24;
      const maxW = DESKTOP_W - MARGIN_X * 2;
      // 文件夹是**固定尺寸的方卡**（2026-08-13），排布退化成"一行一行摆格子"。
      // 以前这里要按内容算每块区的宽度，还得在同一趟里定死写进去 —— 那是
      // 「贴内容宽的实体区」时代的麻烦，随区几何一起没了。
      let cx = MARGIN_X; let cy = MARGIN_X; let rowH = 0;
      const patches = {};
      for (const z of tops) {
        const { w, h } = FOLDER_CARD;
        if (cx > MARGIN_X && cx + w > MARGIN_X + maxW) { cx = MARGIN_X; cy += rowH + GAP_Y; rowH = 0; }
        patches[z.id] = { x: cx, y: cy, w };
        cx += w + GAP_X; rowH = Math.max(rowH, h);
      }
      setZones(prev => {
        const next = { ...prev };
        for (const [zid, patch] of Object.entries(patches)) {
          if (!next[zid]) continue;
          next[zid] = { ...next[zid], ...patch };
          dirtyRef.current.zones.add(zid);
        }
        return next;
      });
    }
    scheduleSave();
    useGlobalStore.getState().showToast(
      `已整理 ${targets.length} 件产物` + (zv.length ? ` · ${zv.filter(z => !z.id.includes('/')).length} 个文件夹` : ''),
      'success');
  }, [scheduleSave, bindings]);

  const openFolderRef = useRef(null);
  openFolderRef.current = openFolder;

  // ── 工作区操作：收纳 ↔ 展开（文件夹两态）/ 聚焦 / 自建文件夹 ──
  const patchZone = useCallback((zid, patch) => {
    setZones(prev => (prev[zid] ? { ...prev, [zid]: { ...prev[zid], ...patch } } : prev));
    dirtyRef.current.zones.add(zid);
    scheduleSave();
  }, [scheduleSave]);

  // ⚠️ 这一段必须待在 patchZone 之后。它的 useCallback 依赖数组在**渲染时**
  // 求值，写在上面就是 TDZ —— 这个文件第四次栽在 hook 声明顺序上了
  // （前三次：绑定表 memo、splitStageCards、handlePresenceEvent）。
  // 症状一律是整页白屏 + "Cannot access 'X' before initialization"，
  // 而且 build 和单测都照过不误，只有真跑才看得见。
  /**
   * 文件夹卡的手势 —— 2026-08-13 重做：
   *
   *   拖动（>4px）   直接搬走，跟产物卡同一手感
   *   单击           无语义
   *   双击           进这个文件夹
   *
   * 280ms 长按门撤了。它当年防的是"最大命中面积被随手误拖"，但门本身零反馈：
   * 按下就拖的前 280ms 所有位移被吞、光标还是 pointer，松手又因为 moved 被
   * 判"什么都不做" —— 体感就是这卡**既拖不动也点不开**（用户报）。误触之忧
   * 由 4px 阈值 + 单击无副作用兜底，跟产物卡同一套判据。
   *
   * ⚠️ 双击**不能用 `onDoubleClick`**：这里在 pointerdown 时 setPointerCapture
   * （拖拽需要），而捕获会让浏览器不再派发 click / dblclick —— 这个文件
   * 2026-07-27 就栽过同一个坑（当时是卡片双击失灵）。所以双击是自己数的：
   * 第二下 pointerup 时上一次的单击定时器还在，就判定为双击。
   */
  const ZONE_DBLCLICK_MS = 260;
  const zoneDragRef = useRef(null);
  const zoneClickTimer = useRef(null);
  const [draggingZone, setDraggingZone] = useState(null);

  /**
   * @param z 区
   * @param opts.onTap  单击做什么（默认无事）
   * @param opts.onOpen 双击做什么（默认进这个文件夹；传 null 表示没有双击语义）
   */
  const zoneGestureProps = useCallback((z, opts = {}) => ({
    onPointerDown: (e) => {
      if (e.button !== 0 || e.target.closest?.('[data-zone-action]')) return;
      if (camApiRef.current?.isHandMode?.()) return;   // 抓手态归镜头（同 onObjectPointerDown）
      if (toolRef.current !== 'select') return;        // 工具在手归工具（可以在文件夹卡上画/写）
      e.stopPropagation();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      noteUserTakeover();   // 拖动期间 agent 跟随别抢镜头（产物卡同款，原来漏了）
      zoneDragRef.current = {
        id: z.id, startX: e.clientX, startY: e.clientY,
        // 抓点世界坐标 —— 跟物件拖拽同一套换算，相机中途动了也跟手
        grabWorld: camApiRef.current.toWorld(e.clientX, e.clientY),
        origX: z.x, origY: z.y, moved: false,
      };
    },
    onPointerMove: (e) => {
      const d = zoneDragRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) <= 4) return;
      if (!d.moved) { d.moved = true; setDraggingZone(d.id); }
      e.stopPropagation();
      const w = camApiRef.current.toWorld(e.clientX, e.clientY);
      const nx = d.origX + (w.x - d.grabWorld.x);
      const ny = d.origY + (w.y - d.grabWorld.y);
      // upsert 而不是"有才改"：agent 刚 mkdir 出来的影子文件夹（ghostZones）
      // 还没进 zones，旧写法 `prev[d.id] ? ... : prev` 对它是静默 no-op ——
      // 卡画得出来但怎么拖都纹丝不动（2026-08-13 查实）。第一次拖动就落户。
      setZones(prev => ({
        ...prev,
        [d.id]: { w: FOLDER_CARD.w, h: FOLDER_CARD.h, ...prev[d.id], x: nx, y: ny },
      }));
    },
    onPointerUp: () => {
      const d = zoneDragRef.current;
      zoneDragRef.current = null;
      if (!d) return;
      if (d.moved) {
        setDraggingZone(null);
        recentDragMovedRef.current = true;      // 别让这一下被当成点击
        dirtyRef.current.zones.add(d.id);
        scheduleSave();
        return;
      }
      const tap = opts.onTap || (() => {});
      // 没有双击语义的时候不用等 —— 那 260ms 是为了给双击让路，白等就是钝
      if (opts.onOpen === null) { clearTimeout(zoneClickTimer.current); tap(); return; }
      // 第二下来了 = 双击
      if (zoneClickTimer.current) {
        clearTimeout(zoneClickTimer.current);
        zoneClickTimer.current = null;
        (opts.onOpen || (() => openFolderRef.current?.(d.id)))();
        return;
      }
      zoneClickTimer.current = setTimeout(() => { zoneClickTimer.current = null; tap(); }, ZONE_DBLCLICK_MS);
    },
    onPointerCancel: () => {
      zoneDragRef.current = null;
      setDraggingZone(null);
    },
  }), [scheduleSave, noteUserTakeover]);


  /**
   * 删文件夹（2026-08-08）。
   *
   * 以前这里是「删任务」，连带把绑定的那次对话一起删 —— 那条绑定随「任务=会话」
   * 一起废了，所以现在只删目录和它在画布上的那些卡，**对话一个字不动**。
   * zid 就是文件夹的工作区相对路径（可以是嵌套的 `稿件/初稿`）。
   */
  const handleDeleteFolder = useCallback(async (zid, title) => {
    const ok = await useGlobalStore.getState().confirm({
      title: '删除文件夹',
      message: `删除「${title || zid}」？文件夹里的全部内容会一起删掉，此操作不可撤销。对话记录不受影响。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await Assets.removeFolder(projectId, zid);
      // 服务端已把 board.json 里的行清掉，本地 state 也要同步剪，
      // 否则要刷新页面僵尸文件夹才消失（2026-07-30「删不了」修复的一半）
      removedZonesRef.current.add(zid);
      setZones(prev => {
        const next = { ...prev };
        delete next[zid];
        return next;
      });
      // 正开着这个文件夹（或它的子层）的窗 → 关掉，别留一扇指向已删目录的窗
      if (winDirRef.current === zid || winDirRef.current?.startsWith(`${zid}/`)) setWinDir(null);
      reload();
      useGlobalStore.getState().showToast('文件夹已删除', 'info');
    } catch (err) {
      useGlobalStore.getState().showToast(`删除失败：${err.message}`, 'error');
    }
  }, [projectId, reload]);

  // ⚠️ 这里曾经有 handleRemoveLegacyZone（把"旧式会话分区"从桌面拿掉，只清
  // board.json 不动对话）。会话不再产生分区之后，画布上每个框背后都有一个真实
  // 目录，"只从桌面移除、文件留着"这个动作没有对应物了 —— 要么删文件夹，
  // 要么不删。



  /**
   * 右键菜单（2026-08-08，Windows 桌面语言）。
   *
   * 一次 contextmenu 事件能落在三种东西上，菜单跟着变：
   *   空白    新建文件夹 / 写一段字 / 让 agent 在这儿做点什么
   *   文件夹  进去 / 新建子文件夹 / 收起 / 删除
   *   卡片    打开 / 加入上下文 / 让 agent 改它 / 删除
   *
   * 落点的**世界坐标**在打开这一刻就算好存下来 —— 新建出来的东西要落在你右键
   * 的地方，而菜单弹出后镜头可能已经被别的事挪过了。
   */
  const [menu, setMenu] = useState(null);   // { x, y, at:{x,y}, items }
  // 就地标注浮层：{ x, y, target:{ kind, id, title, typeLabel } }（E3）
  const [annotate, setAnnotate] = useState(null);
  /** 「移动到…」浮层：{ x, y, ids:[], current, exclude? } */
  const [moveTo, setMoveTo] = useState(null);
  /** 连线拾取模式：{ id, title } = 起点已定，等着点目标（Esc 取消） */
  const [linkFrom, setLinkFrom] = useState(null);
  // 拾取模式的 Esc：捕获阶段拦住 —— 画布自己的 Esc 是「回上一层」，
  // 不拦的话取消个连线顺便换了层
  useEffect(() => {
    if (!linkFrom) return undefined;
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setLinkFrom(null); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [linkFrom]);
  /** 建线/改线浮层：{ x, y, mode, from:{id?,title}, to:{id?,title}, bindingId?, type?, label? } */
  const [linkPop, setLinkPop] = useState(null);

  const createFolderAt = useCallback(async (parent, at) => {
    try {
      const r = await Assets.createFolder(projectId, { parent });
      if (r?.folder && at) {
        // 落在右键处：不这么做的话它会被自动铺位丢到栈底，你得去找它
        setZones(prev => ({ ...prev, [r.folder]: { x: Math.round(at.x), y: Math.round(at.y), w: FOLDER_CARD.w, h: FOLDER_CARD.h } }));
        dirtyRef.current.zones.add(r.folder);
        scheduleSave();
      }
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`建不了：${err.message}`, 'error');
    }
  }, [projectId, reload, scheduleSave]);

  /** 文件夹窗里的「新建文件夹」（建在窗当前那一层）—— 引用要稳，理由见 folderGoUp */
  const createFolderIn = useCallback((d) => createFolderAt(d, null), [createFolderAt]);

  /**
   * 把两件东西摞在一起 = 当场建个文件夹，两个都收进去（2026-08-13，用户要的）。
   *
   * 桌面/手机上这是最短的归类动作，比"先建夹、再拖两次"少两步。
   *
   * ⚠️ 顺序不能错，也不能并发：**先把文件夹建出来并拿到它的真名**（服务端会
   * 给重名加序号，`新建文件夹` 可能变成 `新建文件夹 2`），再一件件搬。
   * 抢跑的话第二件的 `to` 指向一个还不存在的目录 —— 服务端回
   * `target folder not found`，用户看到的就是"目标文件夹不存在"。
   *
   * 两件都搬完才 reload 一次：中途刷新会让第二件在旧清单上算落点。
   */
  const groupInto = useCallback(async (a, b) => {
    const bothImages = a.type === 'image' && b.type === 'image';
    try {
      const r = await Assets.createFolder(projectId, {
        parent: '',                       // 摞成夹永远发生在桌面这一层
        // 两张图归一起就叫「图片」，其余给通名 —— 名字是给人看的，不是 id
        name: bothImages ? '图片' : undefined,
      });
      const folder = r?.folder;
      if (!folder) throw new Error('没建成');
      // 文件夹落在被摞的那张的位置上（视觉上"它俩合成了这个"）
      setZones(prev => ({
        ...prev,
        [folder]: { x: Math.round(b.pos.x), y: Math.round(b.pos.y), w: FOLDER_CARD.w, h: FOLDER_CARD.h },
      }));
      dirtyRef.current.zones.add(folder);
      const rel = (o) => String(o.id).slice(String(o.id).indexOf(':') + 1);
      movingRef.current.add(a.id); movingRef.current.add(b.id);
      await Assets.moveEntry(projectId, rel(b), folder);
      await Assets.moveEntry(projectId, rel(a), folder);
      scheduleSave();
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`归不到一起：${err.message}`, 'error');
      reload();
    } finally {
      setTimeout(() => { movingRef.current.delete(a.id); movingRef.current.delete(b.id); }, 4000);
    }
  }, [projectId, reload, scheduleSave]);

  /**
   * 就地改名（2026-08-13）。
   *
   * 三层传播的机器 08-08 就造好了（renameBoardPaths 独立动词 / git 对账 /
   * 转发表），**缺的一直只是这扇门** —— 于是文件夹只能叫「新建文件夹」，
   * 要改名得去让 agent `mv`。摞一起自动成夹上线之后这条更硌手：系统天天
   * 给你造通名文件夹。
   *
   * 扩展名不用管，服务端按原文件补回去（用户改 `主稿.html` 时输入的是「定稿」，
   * 让他自己带扩展名的话，删掉它就等于把一份 deck 变成普通文件）。
   */
  const commitRename = useCallback(async (id, name) => {
    setRenamingId(null);
    const from = String(id).slice(String(id).indexOf(':') + 1);
    const next = String(name || '').trim();
    if (!next || next === from.split('/').pop().replace(/\.[^.]+$/, '')) return;
    movingRef.current.add(id);            // 改名 = 换身份，同搬家：别给旧 id 排座
    try {
      const r = await Assets.renameEntry(projectId, from, next);
      if (r?.board) {
        setZones(r.board.zones || {});
        setBindings(r.board.bindings || {});
        dirtyRef.current = { objects: new Set(), zones: new Set() };
      }
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`改不了名：${err.message}`, 'error');
    } finally {
      setTimeout(() => movingRef.current.delete(id), 4000);
    }
  }, [projectId, reload]);

  /**
   * 一件东西 → 标注浮层认的目标描述。
   *
   * `path` 是给 agent 的**落点**：消息里报的位置必须是它能 Read 的路径，
   * 而 id 不是（`deck:主稿.html` 这种带形态前缀的读不出来）。剥前缀的规矩跟
   * moveEntry 一致 —— id 就是路径，冒号前那截是形态名。
   */
  const annotTargetOf = useCallback((o) => ({
    kind: 'object',
    id: o.id,
    path: o.path || (typeof o.id === 'string' && /^[a-z]+:/.test(o.id) ? o.id.slice(o.id.indexOf(':') + 1) : o.id),
    title: o.title || o.name || o.id,
    typeLabel: labelOf(o),
  }), []);

  const openContextMenu = useCallback((e) => {
    const mx = e.clientX; const my = e.clientY;
    const at = camApiRef.current?.toWorld(e.clientX, e.clientY) || { x: 0, y: 0 };
    // 这一下发生在文件夹窗里吗？窗里的东西**不在桌面那一层**，所以查找和
    // 兜底都要换一套（见下）
    const winEl = e.target.closest?.('[data-folder-window]');
    const winIn = winEl ? (winEl.getAttribute('data-folder-window') || '') : null;
    const objEl = e.target.closest?.('[data-board-object]');
    const objId = objEl?.getAttribute('data-board-object') || null;
    // 桌面那一层找不到就去全清单里找（窗里的东西住在别的层）
    const obj = objId
      ? (positionedRef.current.find(o => o.id === objId) || objectsRef.current.find(o => o.id === objId))
      : null;
    // 文件夹：卡片没命中时才按几何找（展开态的框是 pointerEvents:'none'）。
    // ⚠️ 窗里**不做几何兜底** —— 窗的坐标系跟画布无关，拿相机换算出来的世界点
    // 去命中桌面上的文件夹，右键窗里的空白会弹出另一个文件夹的菜单
    const zoneId = !obj
      ? (e.target.closest?.('[data-zone-header]')?.getAttribute('data-zone-header')
        || e.target.closest?.('[data-board-zone]')?.getAttribute('data-board-zone')
        || (winIn === null ? zoneAtPoint(at) : null))
      : null;

    /**
     * 右键落在**选中集里**的东西上，而且选了不止一件 → 出批量菜单。
     *
     * 判据是"点的这一件在选中集里"，不是"有选中集"：选了五件之后去右键第六件，
     * 用户要的显然是对第六件动手，不是对那五件。这跟操作系统桌面一致。
     */
    const sel = selectedIdsRef.current;
    const batch = sel.length > 1 && sel.includes(objId || zoneId);

    let items;
    if (batch) {
      const objs = sel.map(id => positionedRef.current.find(o => o.id === id)).filter(Boolean);
      const zones = sel.filter(id => zonesEffRef.current[id]);
      const addable = objs.filter(canAddToContext);
      const movable = [...objs.filter(isFileBacked).map(o => o.id), ...zones];
      items = [
        {
          id: 'move', icon: FolderInput, label: `移动到…`, hint: `${movable.length} 件`,
          disabled: !movable.length,
          onClick: () => setMoveTo({ x: mx, y: my, ids: movable, current: '', exclude: zones }),
        },
        {
          id: 'add', icon: Plus, label: '加入上下文', hint: `${addable.length} 件`,
          disabled: !addable.length,
          onClick: () => addable.forEach(handleAdd),
        },
        {
          id: 'ask', icon: MessageSquarePlus, label: '标注给 agent', hint: '发送即处理',
          onClick: () => setAnnotate({
            x: mx, y: my,
            target: { kind: 'multi', id: sel[0], title: `${sel.length} 件`, typeLabel: '选中' },
            targets: [
              ...objs.map(annotTargetOf),
              ...zones.map(z => ({ kind: 'folder', id: z, path: z, title: z.split('/').pop() || z, typeLabel: '文件夹' })),
            ],
          }),
        },
        { divider: true },
        {
          id: 'del', icon: Trash2, label: '删除', danger: true, hint: `${sel.length} 件`,
          // 批量删除加一道确认：单件删错了还能从 git 里捞，一次删十件是另一
          // 个量级的事故，而这个菜单项就挨着"移动到…"
          onClick: () => {
            if (!window.confirm(`删掉这 ${sel.length} 件？`)) return;
            objs.forEach(o => handleDeleteNote(o));
            zones.forEach(z => handleDeleteFolder(z, z.split('/').pop()));
          },
        },
      ];
    } else if (obj) {
      items = [
        { id: 'open', icon: FolderOpen, label: '打开', onClick: () => primaryOpenRef.current?.(obj) },
        // 改名只给磁盘上真有位置的（涂鸦 / 手写文字没有文件可改）
        ...(isFileBacked(obj) ? [{ id: 'rename', icon: PencilLine, label: '重命名', onClick: () => setRenamingId(obj.id) }] : []),
        ...(canAddToContext(obj) ? [{ id: 'add', icon: Plus, label: '加入上下文', onClick: () => handleAdd(obj) }] : []),
        // 搬家的**唯一显式入口**（拖到空地搬出去那条 2026-08-13 撤了，见
        // onPointerUp 上面那段墓志铭）。画布原生物件没有磁盘位置，不给。
        ...(isFileBacked(obj) ? [{
          id: 'move', icon: FolderInput, label: '移动到…',
          // 窗里的东西住在窗那一层（`zoneId` 只有桌面上的卡才带）
          onClick: () => setMoveTo({ x: mx, y: my, ids: [obj.id], current: obj.zoneId ?? (winIn || '') }),
        }] : []),
        // 连线（2026-08-14）：从这件东西拉一条关系线到画布上另一件。
        // 全类型都给 —— 手写字/涂鸦也能当端点（标注全局化）。
        { id: 'linkto', icon: Link2, label: '连线到…', onClick: () => setLinkFrom({ id: obj.id, title: titleOfId(obj.id) }) },
        // E3：从「垫半句话进输入框」升级成就地标注 —— 在东西上写完一句，
        // 按发送 agent 立刻来。全类型都给（图片/文件/涂鸦/手写字也算产物）。
        { id: 'ask', icon: MessageSquarePlus, label: '标注给 agent', hint: '发送即处理', onClick: () => setAnnotate({
          x: mx, y: my,
          target: annotTargetOf(obj),
        }) },
        { divider: true },
        { id: 'del', icon: Trash2, label: '删除', danger: true, onClick: () => handleDeleteNote(obj) },
      ];
    } else if (zoneId) {
      items = [
        { id: 'enter', icon: FolderOpen, label: '进入', onClick: () => focusZoneAction(zoneId) },
        { id: 'new', icon: FolderPlus, label: '在里面新建文件夹', onClick: () => createFolderAt(zoneId, null) },
        { id: 'ask', icon: MessageSquarePlus, label: '标注给 agent', hint: '发送即处理', onClick: () => setAnnotate({
          x: mx, y: my,
          target: { kind: 'folder', id: zoneId, path: zoneId, title: zoneId.split('/').pop() || zoneId, typeLabel: '文件夹' },
        }) },
        { id: 'linkto', icon: Link2, label: '连线到…', onClick: () => setLinkFrom({ id: zoneId, title: titleOfId(zoneId) }) },
        { id: 'rename', icon: PencilLine, label: '重命名', onClick: () => setRenamingId(zoneId) },
        // 文件夹在这之前**根本没有搬家入口**：卡片能拖，但拖只改画布坐标，
        // 磁盘上它永远待在原地（拖到另一张文件夹卡上也不算数）。
        {
          id: 'move', icon: FolderInput, label: '移动到…',
          onClick: () => setMoveTo({
            x: mx, y: my, ids: [zoneId],
            current: zoneId.includes('/') ? zoneId.slice(0, zoneId.lastIndexOf('/')) : '',
            exclude: [zoneId],     // 自己和自己的子孙不能当目标
          }),
        },
        { divider: true },
        { id: 'del', icon: Trash2, label: '删除文件夹', danger: true, onClick: () => handleDeleteFolder(zoneId, zoneId.split('/').pop()) },
      ];
    } else if (winIn !== null) {
      // 文件夹窗里的空白：能做的只有"在这一层新建"。写字/涂鸦/整理画布都是
      // 桌面那一层的动作（窗里是算出来的网格，没有"摆在哪儿"这回事）
      items = [
        { id: 'new', icon: FolderPlus, label: '新建文件夹', onClick: () => createFolderAt(winIn, null) },
      ];
    } else {
      items = [
        // 桌面上右键就建在桌面上。文件夹**里面**新建走窗里那个按钮（它带着
        // 自己的 dir）—— 桌面这一层永远是根，这里不需要再问"我在哪一层"
        { id: 'new', icon: FolderPlus, label: '新建文件夹', onClick: () => createFolderAt('', at) },
        { id: 'note', icon: StickyNote, label: '新建便利贴', hint: 'agent 能看到', onClick: () => createNoteAt(at) },
        { divider: true },
        { id: 'ask', icon: MessageSquarePlus, label: '让 agent 在这儿做…', onClick: () => onAskAgent?.({ at }) },
        { id: 'tidy', icon: LayoutGrid, label: '整理这块画布', onClick: tidyBoard },
      ];
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, [zoneAtPoint, createFolderAt, createNoteAt, handleAdd, handleDeleteNote, handleDeleteFolder, tidyBoard, onAskAgent]);

  // ── agent 正在写什么 → 视图跟过去（2026-08-13 从"自动展开"改剩这一半）──
  //
  // 原来这里是一整条「deck 自动内嵌渲染」链：进会话 HEAD 探测已有 canvas、
  // agent 写 deck（file_changed）时自动把那张卡展开成内嵌 iframe，还带一个
  // per-session 的"用户手动收起过就不抢"记忆。展开态退役后这条链没有了落点。
  //
  // ⚠️ **不要把它原样映射成"自动开窗"**：`preview_deck`（agent 主动摊给用户看）
  // 翻译成开窗是对的，但 file_changed 是每写一个文件就来一发 —— 那会变成
  // agent 每存一次盘就把一扇模态窗拍在用户脸上。方卡带实时缩略图之后，
  // "工作过程当场可见"这件事缩略图自己就做到了。
  //
  // 只留下有意义的那一半：把视图切到 agent 正在动的那个文件夹。
  //
  // ⚠️ 而这半条 2026-08-13 也没了：桌面不再有"层"，切不过去。agent 在文件夹里
  // 干活的可见性由**那张文件夹卡上的光圈 + 实时缩略**承担（ringZones 会把
  // 目标一路归到桌面上那张卡）。这里曾经是 `setCwd(...)` —— 换层模型拆掉之后
  // 它成了一处**悬空引用**（build 不报，真事件一来才炸），是拆全局状态之后
  // 必须 grep 一遍 setter 的老教训。

  /**
   * 舞台卡认领目标（agent 刚开始写某个文件）：目标落脚的文件夹还不存在就先
   * 长一块影子区（任务目录是 agent 现建的）。
   */
  const handleStageTarget = useCallback((objectId) => {
    ensureZoneForTarget(objectId);
  }, [ensureZoneForTarget]);

  // preview_deck 工具：等价于用户双击那张卡。
  // **不挑层**：窗是浮在桌面之上的，被预览的东西住在哪个文件夹里都能直接开。
  const handlePreviewRequest = useCallback((objectId) => {
    const o = positionedRef.current.find(it => it.id === objectId)
      || objectsRef.current.find(it => it.id === objectId);
    if (!o) { pendingPreviewRef.current = objectId; return; }  // 刚写出来的 deck 等产物重拉
    primaryOpenRef.current?.(o);
    followToObject?.(objectId);
  }, [followToObject]);

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
  /**
   * 目录型产物的覆盖表：`[{ path, id }]`，**按 path 长度降序**。
   *
   * 舞台寻址靠它把"落在一件产物里的一切"收敛到那一张卡：站点的
   * index / about / style.css / 图片、世界的立绘和地点 .md 各给一个 id 的话，
   * agent 改一次样式表桌面就多冒一张卡 —— 用户要的是"我那个网站"。
   *
   * 长的先匹配是必需的：子目录站 `鉴赏页/v2` 必须排在根站 `鉴赏页` 前面，
   * 否则子目录站的文件全被父站吞掉。
   *
   * ⚠️ 这里以前是 `Map<任务名, 站点root[]>` —— 那是任务模型的形状，需要
   * "先知道文件属于哪个任务，再问那个任务是不是站点"。id = 路径之后不需要
   * 中间那一跳了：物件 id 剥掉 kind 前缀**就是**它在磁盘上占的那块地方。
   */
  const artifactRoots = useMemo(() => (
    objects
      .filter(o => o.type === 'site' || o.type === 'world')
      .map(o => ({ path: o.id.slice(o.id.indexOf(':') + 1), id: o.id }))
      .filter(r => r.path)
      .sort((a, b) => b.path.length - a.path.length)
  ), [objects]);
  // ⚠️ 下面这两个必须声明在 useStageState **之前**：它把 handlePresenceEvent
  // 当参数收走，声明在后面就是 TDZ 白屏。这个文件已经栽过三次同样的事
  // （绑定表 memo / splitStageCards / 这次），组件里 hook 参数的声明顺序
  // 不是风格问题，是硬约束。
  /**
   * 镜头跟**人**，不跟事件。
   *
   * 以前 `followToObject` 挂在每一条 file_changed 上 —— 多个子代理并行时
   * 镜头会在它们之间来回横跳，看着像抽搐。现在只跟 `followTarget` 选出来的
   * 那一个（主 agent 优先），它换了目标才动一次。
   */
  const followedIdRef = useRef(null);
  useEffect(() => {
    const who = followTarget(presence);
    if (!who) { followedIdRef.current = null; return; }
    const key = `${who.id}:${who.targetId}`;
    if (followedIdRef.current === key) return;
    followedIdRef.current = key;   // 关着也记下来：重新打开时不该把攒的一路补播一遍
    if (!followAgent) return;
    followToObject(who.targetId);
  }, [presence, followToObject, followAgent]);

  // 在场表：从同一条事件流归约出"谁在哪干活"（board-presence.js，19 条测试）。
  // 解析器用画布自己的寻址规则（zoneOfObjectId），跟舞台卡贴物件同一套口径。
  const handlePresenceEvent = useCallback((evt) => {
    setPresence(prev => reducePresence(prev, evt, (file) => {
      if (!file) return null;
      const objectId = String(file);
      return { objectId, zoneId: zoneOfObjectId(objectId) };
    }));
  }, []);

  const { stageCards, stageBadges, dismissStageCard } = useStageState({
    stageRef, artifactRoots, followToObject,
    onStageTarget: handleStageTarget, onPreviewRequest: handlePreviewRequest,
    onRawEvent: handlePresenceEvent,
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
    stageCards, positioned, visibleIdSet, visibleZones, focusZone: '', occupancy: stageOccupancy,
  });

  // agent 此刻在动谁：橙色光圈套在目标外圈（物件还没上墙就套它落脚的工作区）。
  // 与"已更新"角标分工：光圈=正在动（过程），角标=刚动完（结果）。
  const { ringObjects, ringZones } = useMemo(() => {
    const objs = new Set(); const zs = new Set();
    for (const c of Object.values(stageCards)) {
      if (c.kind === 'chip' || c.kind === 'question' || c.status !== 'running') continue;
      if (c.objectId && positioned.some(o => o.id === c.objectId)) { objs.add(c.objectId); continue; }
      // 目标不在桌面上 = 它在某个文件夹里 → 光圈套在**那个文件夹卡**上
      // （桌面只画根这一层；agent 在文件夹里干活时你看到的是那张卡在转）
      const z = zoneOfObjectId(c.objectId);
      if (z) zs.add(z.includes('/') ? z.split('/')[0] : z);
    }
    return { ringObjects: objs, ringZones: zs };
  }, [stageCards, positioned]);

  /**
   * 小地图要画的东西：一件一个小方块（世界坐标）。
   *
   * 拿的是**可见**的那批，不是全部 —— 小地图该跟画布所见一致，画上一堆
   * 当前看不到的东西只会让人对不上号。
   */
  const minimapItems = useMemo(() => {
    const out = visibleZones.map(z => ({
      id: `z:${z.id}`, x: z.x, y: z.y,
      w: z.w, h: z.h, folder: true,
    }));
    for (const o of visibleObjects) {
      const sz = sizeOf(o);
      out.push({ id: o.id, x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h, folder: false });
    }
    return out;
  }, [visibleZones, visibleObjects]);

  // ── 外层工具栏桥（工具栏合并：控件画在 CanvasToolbar，操作从这里走）──
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      /** 面包屑点某一级：窗切到那一层（'' = 关窗回桌面） */
      goTo: (dir) => setWinDir(dir || null),
      reload,
      // 项目级四件套（记忆 / 指引 / 风格 / 文件）2026-08-07 从画布顶带收进
      // 顶栏的「⋯」——它们是**设置**不是产物，占着画布最好的一条横带每天
      // 看却几乎不点。面板本身没动，只是换了个入口。
      openProjectPanel: (key) => setProjectPanel(key),
      /**
       * 就地标注发出的瞬间把精灵放到目标上（E4）：真事件（run.start /
       * file_changed）要过服务端一圈才回来，等它们精灵才动，"收到指令立刻
       * 飘过去"的手感就没了。这是**本地合成**的在场条目，不走 reducer ——
       * 后续真事件来了会自然接管（run.start 幂等、file_changed 挪位置、
       * tool_use 换那句话、run.done 收场）。
       */
      presenceHint: (targetId) => {
        if (!targetId) return;
        setPresence(prev => {
          const cur = prev[MAIN_AGENT_ID] || {};
          return {
            ...prev,
            [MAIN_AGENT_ID]: {
              id: MAIN_AGENT_ID, kind: 'main', name: '助手', color: colorFor(0),
              at: null,
              ...cur,
              active: true, targetId, zoneId: zoneOfObjectId(targetId), message: '收到，来了',
            },
          };
        });
      },
    };
    return () => { apiRef.current = null; };
  });
  const lastUiRef = useRef('');
  useEffect(() => {
    // 面包屑：当前目录一路拆到根。顶栏据此渲染「Demo 项目 / 鉴赏页 / 初稿」，
    // 每一级可点 —— 换层的第三个入口（另两个是双击文件夹卡和 ESC）。
    const crumbs = [];
    if (winDir) {
      const segs = winDir.split('/');
      for (let i = 0; i < segs.length; i += 1) {
        const path = segs.slice(0, i + 1).join('/');
        crumbs.push({ id: path, title: taskTitles.get(path) || segs[i] });
      }
    }
    // artifactKind / artifactExports：当前这一层做的是什么形态、可用哪些导出
    // 格式（服务端 kinds/ 注册表吐的）—— 导出菜单据此渲染，不在前端硬编码。
    const focusTaskObj = winDir ? tasks.find(t => t.id === winDir) : null;
    const ui = {
      // 顶栏面包屑读的就是它。名字沿用 `cwd` —— 语义从"桌面在哪一层"变成
      // "窗开在哪一层"，但对顶栏来说是同一件事：你现在看着哪儿
      cwd: winDir || '',
      crumbs,
      artifactKind: focusTaskObj?.kind || null,
      artifactExports: focusTaskObj?.exports || null,
      // 项目级四件套的一行摘要 —— 卡片撤出画布后，这几句话跟着入口一起
      // 搬进顶栏的「⋯」，不能因为换了个地方就把"里面有没有东西"弄丢
      projectBand: bandSummaries,
    };
    // 布局每次变更都换新引用（拖拽期间逐帧）—— 序列化对比，内容没变不上报
    const key = JSON.stringify(ui);
    if (key === lastUiRef.current) return;
    lastUiRef.current = key;
    onUiState?.(ui);
  }, [onUiState, winDir, taskTitles, tasks, bandSummaries]);

  /**
   * 画布的工具组。**这里不渲染工具栏** —— 全项目只有一条，活在 CanvasFrame，
   * 内容跟着当前焦点走（没开窗是这一份，开了窗是那扇窗的）。
   *
   * 2026-08-13 范式改造前：画布一条 + 每扇窗各一条，各自算落点、各自持久化
   * 位置。用户报的「两套工具栏」「位置没对齐」「偏到右下角」是同一个结构病。
   *
   * 顺带退役的是 `autoHide` + `wake`（按需浮现）：既然常驻，就没有"唤出"这回事。
   */
  /**
   * ⚠️ 镜头动作要用 ref 转一手，**不能直接把 `camera.zoomBy` 写进依赖**。
   *
   * `useBoardCamera` 每次渲染返回新对象，而它里面的 `zoomToFit` 又依赖
   * `contentBox`，`contentBox` 依赖 `visibleObjects` —— 那是个每渲染
   * `.filter()` 出来的新数组。整条链每帧换身份，写进依赖就是：
   * memo 每帧重算 → 报上去一个新数组 → 外层 setState → 再渲染一帧 → **死循环**。
   * build 和单测都照不出来，因为它要真挂起来跑才发作。
   */
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const zoomFitStable = useCallback(() => cameraRef.current.zoomToFit(), []);
  const zoomByStable = useCallback((d) => cameraRef.current.zoomBy(d), []);
  const zoomToStable = useCallback((z) => cameraRef.current.zoomTo(z), []);

  const boardToolGroups = useMemo(() => ([
            {
              id: 'view',
              items: [
                {
                  id: 'tidy', icon: LayoutGrid, label: '整理',
                  title: '重排这块画布上的产物（自动排版只在新产物到货时跑一次，别的时候不动你摆的位置）',
                  onClick: tidyBoard,
                },
                { id: 'fit', icon: Maximize2, label: '全部', title: '全部内容入镜（Shift+1）', onClick: zoomFitStable },
                { id: 'zoomOut', icon: Minus, title: '缩小（Ctrl -）', onClick: () => zoomByStable(-1) },
                { id: 'zoomLevel', icon: null, label: `${Math.round(scale * 100)}%`, title: '回到 100%（Ctrl 0）', onClick: () => zoomToStable(1) },
                { id: 'zoomIn', icon: Plus, title: '放大（Ctrl +）', onClick: () => zoomByStable(1) },
              ],
            },
            {
              id: 'tools',
              type: 'mode',
              value: tool,
              onChange: setTool,
              items: [
                { id: 'select', icon: MousePointer2, title: '指针：选中和挪动东西（V）' },
                { id: 'hand', icon: Hand, title: '抓手：拖任何地方都是挪镜头（H，或按住空格）' },
                { id: 'text', icon: Type, title: '写一段字（T）：双击空地落输入框，单击照常选中/拖动' },
                { id: 'draw', icon: PenLine, title: '涂鸦（P）' },
                // 标注 2026-08-13 从这儿撤了：它的对象永远是一个具体物件，
                // 所以入口在物件自己身上（右键菜单 / 卡片右上角的标注按钮），
                // 工具栏只留"要在空地上起手势"的那几种。
              ],
            },
            // 拿着笔时多出的子模式组：落笔 / 摆放（见 drawMode 的说明）
            ...(tool === 'draw' ? [{
              id: 'drawMode',
              type: 'mode',
              value: drawMode,
              onChange: setDrawMode,
              items: [
                { id: 'ink', icon: PenLine, label: '落笔', title: '只管画 —— 不会碰到已有的墨迹' },
                { id: 'arrange', icon: Move, label: '摆放', title: '挪动/缩放已有墨迹 —— 不会落笔' },
              ],
            }] : []),
          ]), [tool, drawMode, scale, tidyBoard, zoomFitStable, zoomByStable, zoomToStable]);

  useEffect(() => { onToolbarGroups?.(boardToolGroups); }, [boardToolGroups, onToolbarGroups]);

  /**
   * 一张产物卡 / 一张文件夹卡的渲染。
   *
   * **桌面和文件夹窗共用这两个函数**（2026-08-13）。窗里那套要是自己抄一版
   * 简化卡，hover 工具条、标注按钮、缩略图闸门、双击语义就得在两个地方各修
   * 一遍 —— 这个仓库最贵的一课正是「同一件东西有多个实例」。
   *
   * 窗里的差别只有三处，全在 `win` 分支里：位置是算出来的（不是 board.json 的
   * 坐标）、不参与拖拽和框选、镜头缩放固定 1（窗不跟着画布缩放）。
   */
  const renderObjectCard = (o, winPos = null) => {
    const win = !!winPos;
    const obj = win ? { ...o, pos: { ...winPos, z: 1 } } : o;
    return (
      <BoardObject
        key={obj.id}
        o={obj}
        projectId={projectId}
        currentSessionId={currentSessionId}
        fileVersions={fileVersions}
        added={addedPaths.has(obj.id)}
        // 避让系统：拖拽中只有被拖的卡要逐帧跟手（关过渡），被避让的
        // 邻居保持 380ms 滑动 —— 挤开和弹回都是顺滑的
        animateLayout={!win && (!dragActive || dragRef.current?.id !== obj.id)}
        agentActive={ringObjects.has(obj.id)}
        groupTarget={!win && dropHint?.kind === 'group' && dropHint.id === obj.id}
        // 单选一件墨类时选中态由变换控制器画（那圈框就是它的选中框），
        // 别再叠一道外框
        selected={!win && selectedIds.includes(obj.id) && !(obj.native && selectedIds.length === 1)}
        renaming={renamingId === obj.id}
        onRenameCommit={(v) => commitRename(obj.id, v)}
        onRenameCancel={() => setRenamingId(null)}
        onPointerDown={win ? undefined : (e) => onObjectPointerDown(e, obj)}
        wasDrag={win ? () => false : wasDrag}
        onPrimary={() => primaryOpen(obj)}
        onAdd={() => handleAdd(obj)}
        onOpenViewer={() => openViewer(obj)}
        onOpenFile={() => openFile(obj)}
        onDetail={() => setDetail(obj)}
        onDeleteNote={() => handleDeleteNote(obj)}
        onFocus={() => focusDeck(obj)}
        // 标注：浮层从按钮底下长出来（at 是按钮的屏幕坐标），
        // target 的形状跟右键菜单那条**逐字一致** —— 同一张浮层
        onAnnotate={(at) => setAnnotate({ x: at.x, y: at.y, target: annotTargetOf(obj) })}
        noteCount={noteCounts[obj.id] || 0}
        // 缩略图的第二道限流：镜头拉太远就不挂 iframe（看不清，纯浪费）
        scale={win ? 1 : scale}
      />
    );
  };

  const renderFolderCard = (z, winPos = null) => {
    const win = !!winPos;
    const card = win ? { ...z, x: winPos.x, y: winPos.y } : z;
    return (
      <FolderCard
        key={card.id}
        z={card}
        projectId={projectId}
        fileVersions={fileVersions}
        scale={win ? 1 : scale}
        dropTarget={!win && dropHint?.kind === 'folder' && dropHint.id === card.id}
        selected={!win && selectedIds.includes(card.id)}
        ring={ringZones.has(card.id)}
        dragging={!win && draggingZone === card.id}
        animate={!win && !(dragActive || draggingZone === card.id)}
        renaming={renamingId === card.id}
        onRenameCommit={(v) => commitRename(card.id, v)}
        onRenameCancel={() => setRenamingId(null)}
        onDelete={() => !wasDrag() && handleDeleteFolder(card.id, card.title)}
        onAnnotate={(at) => setAnnotate({
          x: at.x, y: at.y,
          target: { kind: 'folder', id: card.id, path: card.id, title: card.title, typeLabel: '文件夹' },
        })}
        noteCount={noteCounts[card.id] || 0}
        // 窗里没有拖拽（位置是算的），双击直接下钻到下一层
        gestureProps={win
          ? { onDoubleClick: () => openFolder(card.id) }
          : zoneGestureProps(card)}
        hint={win ? '双击进去' : '双击打开 · 拖动搬走'}
      />
    );
  };

  // ── 渲染 ──
  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: CANVAS.paper }}>
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
        '@keyframes ndPresencePulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.25);opacity:.75}}',
        '@keyframes ndPulse{from{box-shadow:0 0 0 0 rgba(79,143,91,0.4)}to{box-shadow:0 0 0 12px rgba(79,143,91,0)}}',
        // agent 正在动的目标：外圈橙色呼吸光圈
        // agent 正在动这个东西：**一圈跑动的光**，不只是边框在呼吸。
        // 用户要的是"运动环绕光圈"—— 呼吸是"这里有点什么"，跑动才是"有人正在
        // 这儿干活"。两层叠着：底下一圈稳的实边（认得出是哪一个），上面
        // 一段亮弧沿着边转（看得出在动）。
        '@keyframes ndAgentRing{0%,100%{box-shadow:0 0 0 2px rgba(176,140,79,0.85),0 0 0 7px rgba(176,140,79,0.16),0 6px 20px rgba(40,32,16,0.12)}50%{box-shadow:0 0 0 2px rgba(176,140,79,0.95),0 0 0 13px rgba(176,140,79,0.05),0 6px 20px rgba(40,32,16,0.12)}}',
        '@keyframes ndAgentSweep{to{transform:rotate(1turn)}}',
      ].join('')}</style>
      {/* 视口：不滚动，镜头就是相机（2026-08-07 无限画布）
       *
       * 点阵台面画在**视口**上不画在世界层上：世界是无限的，给不出一个"多大"
       * 的背景元素。做法是背景尺寸跟着 z 缩、背景位置跟着相机走 —— 视觉上等价
       * 于一张无限大的点阵纸，而且不需要为它铺任何 DOM。 */}
      <div
        ref={scrollRef}
        data-board-pane
        data-tool={tool}
        data-drawing={canvasTools.draft ? canvasTools.draft.points.length : ''}
        onPointerDown={(e) => {
          // 点到既不是物件也不是变换手柄的地方 → 取消选中（选中态的唯一出口
          // 之一；另一个是 Esc）。放在工具分派**之前**：不管手里拿什么，点空白
          // 都该收掉选框。
          if (selectedIdsRef.current.length && !e.target.closest('[data-board-object],[data-board-zone],[data-transform-handle]')) {
            setSelectedIds([]);
          }
          // 顺序即优先级：工具在手就归工具，工具没接才轮到相机平移。
          // 否则「拖着画一笔」和「拖空白平移」抢同一个手势，画一笔就跑镜头。
          if (canvasTools.onPointerDown(e)) return;
          armMarquee(e);
          camera.onPointerDown(e);
        }}
        onDoubleClick={(e) => { canvasTools.onDoubleClick(e); }}
        // 连线拾取模式：捕获阶段截胡这一下点击 —— 点中物件/文件夹就是目标，
        // 点空地/点自己 = 取消。stopPropagation 挡住卡片自己的选中/打开。
        onClickCapture={linkFrom ? ((e) => {
          e.preventDefault(); e.stopPropagation();
          const tid = e.target.closest?.('[data-board-object]')?.getAttribute('data-board-object')
            || e.target.closest?.('[data-zone-header]')?.getAttribute('data-zone-header')
            || e.target.closest?.('[data-board-zone]')?.getAttribute('data-board-zone')
            || null;
          const from = linkFrom;
          setLinkFrom(null);
          if (!tid || tid === from.id) return;
          setLinkPop({ x: e.clientX, y: e.clientY, mode: 'create', from, to: { id: tid, title: titleOfId(tid) } });
        }) : undefined}
        onContextMenu={(e) => {
          if (onChrome(e)) return;                 // 工具栏上右键交给浏览器
          e.preventDefault();
          openContextMenu(e);
        }}
        onPointerMove={(e) => {
          if (canvasTools.onPointerMove(e)) return;
          if (moveMarquee(e)) return;              // 框选中：相机和物件都不管事
          if (!camera.onPointerMove(e)) onPointerMove(e);
        }}
        onPointerUp={(e) => {
          if (canvasTools.onPointerUp(e)) {
            // 工具吃掉了这次抬手（一笔提交）。物件拖拽若曾误武装，这里必须
            // 收尾 —— dragRef 残留会让那张卡黏住光标（2026-08-13 真栽过；
            // 现在 onObjectPointerDown 有工具守卫，这条是保险丝）。
            if (dragRef.current) { dragRef.current = null; setDragActive(false); }
            return;
          }
          if (endMarquee()) return;
          camera.onPointerUp(e); onPointerUp(e);
        }}
        onPointerCancel={(e) => {
          canvasTools.onPointerUp(e); endMarquee(); camera.onPointerUp(e); onPointerUp(e);
        }}
        style={{
          position: 'absolute', inset: 0, overflow: 'hidden',
          touchAction: 'none',
          cursor: linkFrom ? 'crosshair'
            : camera.panning ? 'grabbing'
            : tool === 'hand' ? 'grab'
            : tool === 'draw' ? (drawMode === 'arrange' ? 'default' : 'crosshair')
            : tool === 'text' ? 'text'
            : 'default',
          background: CANVAS.paper,
          backgroundImage: `radial-gradient(circle, ${CANVAS.grid} 1px, transparent 1px)`,
          backgroundSize: `${24 * scale}px ${24 * scale}px`,
          backgroundPosition: `${cam.x * scale}px ${cam.y * scale}px`,
        }}
      >
        {/* 世界层：所有内容都用世界坐标摆，整层由相机一次性变换。
            transform 从右往左应用 → 先 translate 再 scale = (world + cam) * z，
            跟 board-camera.js 的坐标约定逐字对应。 */}
        <div
          style={{
            position: 'absolute', left: 0, top: 0, width: 0, height: 0,
            transform: `scale(${scale}) translate(${cam.x}px, ${cam.y}px)`,
            transformOrigin: '0 0',
          }}
        >
          {/* 工作区（物件下层）：展开态 = 实体区域（标题栏拖整区），收纳态 = 文件夹卡 */}
          {/* 文件夹：一张方卡（2026-08-13）。
              在这之前它有两态 —— 收起是一条整宽窄条、展开是一块带标题栏的
              实体区域、成员摆在框里。那套是"分区"时代的形状：文件夹是版面上
              摊开的一块地。现在它是**桌面上的一个东西**，双击进去换一层。 */}
          {visibleZones.map((z) => renderFolderCard(z))}

          {/* 吸附预览：松手后物件将落到的格位（虚线 ghost）*/}
          {visibleObjects.map((o) => renderObjectCard(o))}


          {/* 关系线（世界坐标，铺在物件之下）*/}
          <BindingLayer
            bindings={bindings}
            rectOf={rectOfId}
            epoch={positioned}
            width={stageBounds.w}
            height={stageBounds.h}
            hoveredId={hoveredBinding}
            onHover={setHoveredBinding}
            onSelect={(bid, cx, cy) => {
              const b = bindings[bid];
              if (!b) return;
              setLinkPop({
                x: cx, y: cy, mode: 'edit', bindingId: bid,
                from: { id: b.from, title: titleOfId(b.from) },
                to: { id: b.to, title: titleOfId(b.to) },
                type: b.type, label: b.label || '',
              });
            }}
          />

          {/* 正在画的那一笔（还没落盘，纯渲染层）*/}
          {canvasTools.draft && canvasTools.draft.points.length > 1 && (
            <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 290 }}>
              <path
                d={pointsToPath(canvasTools.draft.points)}
                fill="none" stroke={PAPER.ink} strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          )}

          {/* 选中态变换控制器（世界层，跟着被选物件的 transform 走）。
              被选物件可能这一帧刚被删/被搬走 —— find 不到就整层不画。 */}
          {(() => {
            if (!selectedId) return null;
            const o = positioned.find(it => it.id === selectedId);
            if (!o?.native) return null;
            return (
              <TransformControls
                o={o}
                sz={sizeOf(o)}
                camScale={scale}
                toWorld={camera.toWorld}
                onChange={(patch) => {
                  const cur = layoutRef.current[o.id];
                  if (!cur) return;
                  patchLayout(o.id, { data: { ...cur.data, ...patch } });
                }}
              />
            );
          })()}

          {/* 在场：谁在画布上干活（PresenceLayer.jsx）*/}
          <PresenceLayer table={presence} rectOf={rectOfId} />

          {/* 舞台层（板内坐标系）：角标 + 贴物件卡（StageLayer.jsx）
              单独一层浮在所有物件之上 —— 物件的 z 是会长的（pin_to_board 每次
              置顶都 zMax+1），跟舞台卡比大小早晚会盖住 agent 正在写的那个框。
              这层自己不吃事件，卡片各自开 pointerEvents。 */}
          <div style={{ position: 'absolute', left: 0, top: 0, zIndex: 300, pointerEvents: 'none' }}>
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

        {/* 文字输入框：屏幕空间定位，但锚在世界坐标上。
            放在世界层**外面**是有意的 —— 输入框不该跟着缩放变小变糊，
            那样在 0.4 倍视图下根本没法打字。 */}
        {canvasTools.textAt && (
          <TextDraft
            screen={{
              x: (canvasTools.textAt.x + cam.x) * scale,
              y: (canvasTools.textAt.y + cam.y) * scale,
            }}
            onCommit={canvasTools.commitText}
            onCancel={canvasTools.cancelText}
          />
        )}

        {/* 改字输入框：双击一段字 / 文字工具点在字上，预填原文（清空=删除） */}
        {editingText && (
          <TextDraft
            screen={{
              x: (editingText.at.x + cam.x) * scale,
              y: (editingText.at.y + cam.y) * scale,
            }}
            initial={editingText.initial}
            placeholder="改成什么…（⌘/Ctrl+Enter 落笔，清空=删除）"
            onCommit={commitTextEdit}
            onCancel={() => setEditingText(null)}
          />
        )}

        {/* 框选的那个框：画在**视口空间**（不在世界层里），所以它的边框粗细
            不跟着缩放变 —— 0.4 倍视图下一条 1px 的虚线会细到看不见。 */}
        {marquee && (
          <div style={{
            position: 'absolute', pointerEvents: 'none', zIndex: 320,
            left: Math.min(marquee.a.sx, marquee.b.sx),
            top: Math.min(marquee.a.sy, marquee.b.sy),
            width: Math.abs(marquee.b.sx - marquee.a.sx),
            height: Math.abs(marquee.b.sy - marquee.a.sy),
            border: `1px dashed ${CANVAS.brass}`,
            background: alpha(CANVAS.brass, 0.08),
          }} />
        )}

        {/* ⚠️ 这里曾有第三个 TextDraft：工具栏「标注(C)」的批注输入框。
            标注 2026-08-13 收敛成 AnnotatePopover 的两个出口之后它没有入口了，
            连同 commentDraft 状态一起删。留在画布那条路现在走 keepAnnotation。 */}

        {/* 小地图（屏幕空间，左下角）。总览从"一种视图"变成"一个导航控件"之后
            全貌靠它看 —— 干活始终在当前这一层。窗开着时跟工具栏一起收掉。 */}
        {!deckOpen && !winDir && (
          <Minimap
            bounds={camera.bounds}
            cam={cam}
            viewport={camera.viewport}
            items={minimapItems}
            onJump={(pt) => camera.jumpToPoint(pt)}
          />
        )}

      </div>

      {/* 舞台 dock（屏幕坐标系，StageLayer.jsx）*/}
      <StageDock dockPanels={dockPanels} dockChips={dockChips} onDismiss={dismissStageCard} />

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {linkPop && (
        <LinkPopover
          x={linkPop.x} y={linkPop.y} mode={linkPop.mode}
          fromTitle={linkPop.from.title} toTitle={linkPop.to.title}
          initialType={linkPop.type || 'link'} initialLabel={linkPop.label || ''}
          onSubmit={({ type, label }) => {
            if (linkPop.mode === 'edit') {
              const old = bindings[linkPop.bindingId];
              if (!old) return;
              const b = { ...old, type, by: old.by || 'user' };
              if (label) b.label = label; else delete b.label;
              setBindings(prev => ({ ...prev, [linkPop.bindingId]: b }));
              Assets.patchBoard(projectId, { bindings: { [linkPop.bindingId]: b } }).catch(() => {});
            } else {
              const id = `b:${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
              const b = { type, from: linkPop.from.id, to: linkPop.to.id, by: 'user', ...(label ? { label } : {}) };
              setBindings(prev => ({ ...prev, [id]: b }));
              Assets.patchBoard(projectId, { bindings: { [id]: b } }).catch(() => {});
            }
          }}
          onDelete={linkPop.mode === 'edit' ? (() => {
            setBindings(prev => { const n = { ...prev }; delete n[linkPop.bindingId]; return n; });
            Assets.patchBoard(projectId, { bindings: { [linkPop.bindingId]: null } }).catch(() => {});
          }) : null}
          onClose={() => setLinkPop(null)}
        />
      )}
      {linkFrom && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 76, transform: 'translateX(-50%)',
          zIndex: 8000, padding: '6px 14px', borderRadius: 999,
          background: COLOR.text, color: COLOR.bg,
          fontFamily: FONT_SANS, fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          连线：{linkFrom.title} ⟶ 点一个目标（Esc 取消）
        </div>
      )}

      {/* 就地标注（E3）：写一句话 → 发送 → agent 立刻起一轮 */}
      {annotate && (
        <AnnotatePopover
          x={annotate.x} y={annotate.y} target={annotate.target}
          onClose={() => setAnnotate(null)}
          onSubmit={(text) => onAnnotate?.({ target: annotate.target, targets: annotate.targets, text })}
          // 攒着：同一条回调，多一个 queue 标记 —— 落点在 ProjectWorkspace
          // （pending-changes buffer 和那条浮钮都住在那儿）
          onQueue={(text) => onAnnotate?.({ target: annotate.target, targets: annotate.targets, text, queue: true })}
          onKeep={(text) => keepAnnotation(
            annotate.targets?.length ? annotate.targets.map(t => t.id) : [annotate.target.id],
            camApiRef.current?.toWorld(annotate.x, annotate.y),
            text,
          )}
        />
      )}

      {/* 文件夹窗（2026-08-13）：双击文件夹卡开这扇窗，桌面不动。
          卡片用的是上面那两个 render 函数 —— 窗只负责排位置。 */}
      {winDir && (
        <FolderWindow
          dir={winDir}
          list={listDir}
          onUp={parentDir(winDir) !== null ? folderGoUp : null}
          onClose={closeFolderWindow}
          onNewFolder={createFolderIn}
          onToolbarGroups={onWindowToolbarGroups}
          onContextMenu={openContextMenu}
          renderObject={(o, pos) => renderObjectCard(o, pos)}
          renderFolder={(z, pos) => renderFolderCard(z, pos)}
        />
      )}

      {/* 「移动到…」目标选择：搬出当前文件夹的唯一显式入口 */}
      {moveTo && (
        <MoveToPopover
          x={moveTo.x} y={moveTo.y}
          folders={folders}
          current={moveTo.current || ''}
          exclude={moveTo.exclude || []}
          count={moveTo.ids.length}
          onClose={() => setMoveTo(null)}
          onPick={(dir) => moveManyTo(moveTo.ids, dir)}
        />
      )}

      {/* 项目区浮层：直接用原 Hub 的四张卡（编辑 / 上传 / 删除全套照旧）*/}
      {projectPanel && (
        <Overlay onClose={() => setProjectPanel(null)}>
          <div style={{
            width: 'min(560px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'auto',
            background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
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
            background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
            width: 'min(720px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: GAP.sm, flexShrink: 0 }}>
              <BookOpen size={14} color={COLOR.sub} />
              <span style={{ marginLeft: GAP.sm, fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.md, color: COLOR.text }}>{viewer.title}</span>
              {viewer.note && viewerEdit === null && (
                <button title="编辑" onClick={() => setViewerEdit(viewer.content)} style={{ ...toolBtn, marginLeft: 'auto' }}>
                  <PencilLine size={12} />
                </button>
              )}
              {viewer.note && viewerEdit !== null && (
                <div style={{ marginLeft: 'auto', display: 'flex', gap: GAP.xs }}>
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
                style={{ ...toolBtn, ...(viewer.note ? { marginLeft: GAP.xs } : { marginLeft: 'auto' }) }}><X size={12} /></button>
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
                  border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.lg, padding: GAP.md,
                  background: CANVAS.note, outline: 'none',
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
            background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
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
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: RADIUS.lg, border: `1px solid ${COLOR.borderLt}` }}
              />
            </div>
            {detail.meta?.prompt && (
              <div style={{
                padding: GAP.md, borderRadius: RADIUS.lg, background: COLOR.bgCard, border: `1px solid ${COLOR.borderLt}`,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                flexShrink: 0, maxHeight: 150, overflow: 'auto',
              }}>
                <div style={{ letterSpacing: '0.06em', marginBottom: GAP.xs, color: COLOR.text }}>PROMPT</div>
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


/**
 * 便利贴卡体 —— `\n---\n` 分面翻页（note-faces.js 统一约定）。
 * 任务贴（noteTask 非空）右上角带文件名小签，和项目级灵感便签区分。
 * 翻页按钮挂 data-board-action：不触发拖拽 / 双击打开。
 */
/**
 * 画布上写字的输入框。
 *
 * 提交语义：**Enter 换行、Cmd/Ctrl+Enter 提交、点别处也提交、Esc 丢弃**。
 * 用 Enter 直接提交是错的 —— 用户在画布上写的多半是一段话不是一个词，
 * 单行提交会把"想写三行"变成"写了三次"。
 */
function TextDraft({ screen, onCommit, onCancel, placeholder = '写点什么…（⌘/Ctrl+Enter 落笔）', initial = '' }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  // 「点别处 = 提交」靠 onBlur 实现，但**创建它的那一次点击自己就会触发 blur**：
  // mousedown 开框 → 自动聚焦 → 同一次点击的 mouseup 把焦点抢回画布 → blur →
  // 当成"写完了"，空内容，框当场消失。所以 blur 要等这一拍过去才算数。
  const settledRef = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    const t = setTimeout(() => { settledRef.current = true; }, 150);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      data-no-pan
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute', left: screen.x, top: screen.y,
        zIndex: 420, width: 260,
        ...paperCard('near'), padding: GAP.sm,
        animation: POP_IN,
      }}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (settledRef.current) onCommit(value); else ref.current?.focus(); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(value); }
        }}
        placeholder={placeholder}
        rows={3}
        style={{
          width: '100%', border: 'none', outline: 'none', resize: 'none',
          background: 'transparent', color: PAPER.ink,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, lineHeight: 1.6,
        }}
      />
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


const toolBtn = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.md,
  background: COLOR.bgCard, color: COLOR.text, cursor: 'pointer',
  padding: `${GAP.xs}px ${GAP.sm + 2}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
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
