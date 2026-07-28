import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  Image as ImageIcon, FileText, Plus, ExternalLink,
  X, Trash2, BookOpen, Folder, FolderOpen, FolderInput,
  Presentation, PencilLine, ChevronsUpDown, Focus,
} from 'lucide-react';
import { Assets, Sessions, Memory, Canvas } from '../../lib/api.js';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import {
  DESKTOP_W, MARGIN_X, ZONE_GAP_Y, FOLDER_CARD_H, DECK_EMBED_W, ZONE, SIZES,
  EASE, POP_IN, sizeOf, newStackedZoneRect,
} from '../../lib/board-geometry.js';
import { useStageState, splitStageCards, StageBoardLayer, StageDock } from './StageLayer.jsx';

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
  projectId, currentSessionId, refreshToken, boardVersion, onAddToContext, onFocusDeck,
  // 工具栏合并（2026-07-27）：画布自己不再渲工具条 —— 通过 apiRef 暴露操作、
  // onUiState 上报状态，控件统一画在外层 CanvasToolbar
  apiRef, onUiState,
  // ✏️ 跨会话编辑前打招呼：切会话后 CanvasFrame 直接进 Edit（唯一的自动切换意图；
  // 工作台已是常驻默认视图，切会话本身不再离开画布）
  onEditNav,
  // 舞台层（2026-07-28）：ProjectWorkspace 把 run.* 事件经这个 ref 转发进来，
  // 画布把 agent 的实时动作演出来（代码直播 / 终端 / shimmer / chip / 角标）
  stageRef,
}) {
  const navigate = useNavigate();
  const scrollRef = useRef(null);          // 纵向滚动容器（桌面的"视口"）
  const [paneSize, setPaneSize] = useState({ w: 0, h: 0 });

  // 数据源
  const [artifacts, setArtifacts] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [memoryDocs, setMemoryDocs] = useState([]);
  // 布局（saved + 本地改动合一）：{ [id]: {x,y,z,expanded} }；zones：{ [sid]: {x,y,w,h,title} }
  const [layout, setLayout] = useState({});
  const [zones, setZones] = useState({});
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
  const [addedPaths, setAddedPaths] = useState(() => new Set());
  const [detail, setDetail] = useState(null);       // 图片详情
  const [viewer, setViewer] = useState(null);       // { title, content } markdown 阅读
  const [noteDraft, setNoteDraft] = useState(null);
  const [folderDraft, setFolderDraft] = useState(null);   // 新建文件夹工作区标题草稿
  // 拖拽实时落点提示：{ kind:'zone'|'folder', id, ghost?:{x,y,w,h} }（ghost=吸附预览格）
  const [dropHint, setDropHint] = useState(null);
  const dropHintRef = useRef(null);

  // 跟随：agent 动作发生时平滑滚动过去；用户任何操作立即接管、静置后恢复
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true); followRef.current = follow;
  const userHoldUntilRef = useRef(0);       // 用户接管截止时刻（pointerdown/wheel 后 +8s）
  // 拖拽期间关掉物件/工作区的 left/top 过渡（拖拽要逐帧跟手；agent 改布局要动画）
  const [dragActive, setDragActive] = useState(false);

  // ── 数据加载 ──
  const reload = useCallback(async () => {
    const [a, s, m, b] = await Promise.all([
      Assets.artifacts(projectId).catch(() => ({ artifacts: [] })),
      Sessions.list(projectId, { limit: 30 }).catch(() => ({ sessions: [] })),
      Memory.list(projectId).catch(() => ({ memory: [] })),
      layoutLoadedRef.current ? Promise.resolve(null) : Assets.getBoard(projectId).catch(() => null),
    ]);
    setArtifacts(Array.isArray(a?.artifacts) ? a.artifacts : []);
    setSessions(Array.isArray(s?.sessions) ? s.sessions : []);
    setMemoryDocs(Array.isArray(m?.memory) ? m.memory : []);
    if (b?.board && !layoutLoadedRef.current) {
      layoutLoadedRef.current = true;
      setLayout(b.board.objects || {});
      setZones(b.board.zones || {});
      // 桌面化：board.json 的 size 不再决定画布大小 —— 桌面宽度固定、高度随内容
      const zs = Object.values(b.board.objects || {}).map(o => o.z || 0);
      zMaxRef.current = Math.max(10, ...zs);
    }
  }, [projectId]);

  useEffect(() => { reload(); }, [reload, refreshToken]);

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

  // ── 物件派生（数据源 → 物件列表；布局只管摆放）──
  const objects = useMemo(() => {
    const out = [];
    // 项目文档：记忆(_root) + 品牌(brand)（有内容才上墙）
    for (const doc of memoryDocs) {
      if (doc.agentType === null) {
        out.push({ id: 'doc:_root', type: 'doc', title: '项目记忆', sub: 'agent-memory/memory.md', ctxPath: 'agent-memory/memory.md', readKey: '_root', preview: doc.preview });
      } else if (doc.agentType === 'brand') {
        out.push({ id: 'doc:brand', type: 'doc', title: '品牌档案', sub: 'agent-memory/brand/memory.md', ctxPath: 'agent-memory/brand/memory.md', readKey: 'brand', preview: doc.preview });
      }
    }
    for (const s of sessions) {
      const sid = s.sessionId || s.id;
      out.push({
        id: `deck:${sid}`, type: 'deck', sid,
        title: s.customTitle || s.title || s.summary || s.firstPrompt || '未命名 deck',
        mtime: s.lastModified || s.mtime,
      });
    }
    for (const a of artifacts) {
      const sid = a.sessionId || a.meta?.sessionId || null;
      if (a.kind === 'note') out.push({ id: a.path, type: 'note', sid, ...a });
      else if (a.isImage) out.push({ id: a.path, type: 'image', sid, ...a });
      else out.push({ id: a.path, type: 'file', sid, ...a });
    }
    return out;
  }, [memoryDocs, sessions, artifacts]);

  const sessionTitles = useMemo(() => {
    const map = new Map();
    for (const s of sessions) {
      map.set(s.sessionId || s.id, s.customTitle || s.title || s.summary || s.firstPrompt || '未命名 deck');
    }
    return map;
  }, [sessions]);

  // ── 工作区派生：当前 session + 有产物的 session 各一块，缺的建出来并持久化 ──
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const needed = new Set();
    if (currentSessionId) needed.add(currentSessionId);
    for (const o of objects) {
      if (o.sid && o.type !== 'deck') needed.add(o.sid);
    }
    const missing = [...needed].filter(zid => !zones[zid]);
    if (!missing.length) return;
    setZones(prev => {
      const next = { ...prev };
      for (const zid of missing) {
        if (next[zid]) continue;
        // 桌面化：新工作区先落在栈底占位（y 取超大值），堆叠 effect 下一拍归位
        next[zid] = {
          ...newStackedZoneRect(next),
          ...(sessionTitles.get(zid) ? { title: sessionTitles.get(zid) } : {}),
        };
        dirtyRef.current.zones.add(zid);
      }
      scheduleSave();
      return next;
    });
  }, [objects, currentSessionId, zones, sessionTitles, scheduleSave]);

  /**
   * 自动摆位 + 归属判定：
   *   1. 有 sid 且工作区存在的未摆放物件 → 区内网格自动入座（deck 先占第一格）
   *   2. 其余未摆放物件 → 画布下方的收纳带（文档架 / deck 架 / 素材 / 文件）
   *   3. 归属 = 物件中心落在工作区有效矩形内（区随内容向下自然生长）
   */
  const { positioned, zoneView, contentBottom } = useMemo(() => {
    // 占格：placed 成员先标格子，未摆放的按空格入座
    const grids = {};
    for (const [zid, z] of Object.entries(zones)) {
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

    // 归属解析（显式优先）：layout.zone 字段是真相（'' = 明确无归属），
    // 没写过字段的回落到数据派生（有 sid 且工作区存在 → 归它）。
    // 几何不再决定归属 —— 它只在拖放松手那一刻用来判定写什么进 zone 字段。
    const effZoneOf = (o) => {
      const stored = layout[o.id];
      if (stored && stored.zone !== undefined) return stored.zone || null;
      return o.sid && grids[o.sid] ? o.sid : null;
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
      const zid = o.type === 'deck' ? (zones[o.sid] ? o.sid : null) : (o.sid && zones[o.sid] ? o.sid : null);
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
    const zoneBottom = Object.values(grids).reduce(
      (acc, g) => Math.max(acc, g.rect.y + (g.rect.collapsed ? FOLDER_CARD_H : Math.max(g.rect.h, g.bottom - g.rect.y))), ZONE.bandY);
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

    // zone 视图（有效高度随内容生长）+ 逐物件归属（显式字段优先）
    const zv = Object.entries(grids).map(([zid, g]) => ({
      id: zid,
      x: g.rect.x, y: g.rect.y, w: g.rect.w,
      h: Math.max(g.rect.h, g.bottom - g.rect.y),
      title: sessionTitles.get(zid) || g.rect.title || '工作区',
      collapsed: !!g.rect.collapsed,
    }));
    for (const it of items) it.zoneId = effZoneOf(it);
    for (const z of zv) z.memberCount = items.filter(it => it.zoneId === z.id).length;
    // 桌面高度 = 可见内容最低点 + 余量（收纳进文件夹的成员藏着，不该撑出死滚动区）
    const collapsedSet = new Set(zv.filter(z => z.collapsed).map(z => z.id));
    let bottom = zoneBottom;
    for (const it of items) {
      if (it.zoneId && collapsedSet.has(it.zoneId)) continue;
      bottom = Math.max(bottom, it.pos.y + sizeOf(it).h);
    }
    return { positioned: items, zoneView: zv, contentBottom: bottom };
  }, [objects, layout, zones, sessionTitles]);
  positionedRef.current = positioned;

  // 桌面几何：宽度固定，视口窄则整体等比缩小（非交互）；高度随内容生长
  const scale = Math.min(1, (paneSize.w || DESKTOP_W) / DESKTOP_W);
  scaleRef.current = scale;
  const boardH = Math.max(
    (contentBottom || 0) + 280,
    Math.ceil((paneSize.h || 600) / (scale || 1)),
  );
  const boardSize = { w: DESKTOP_W, h: boardH };

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
      const stored = zonesRef.current[z.id];
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
    const top = Math.max(0, (o.pos.y + sz.h / 2) * scaleRef.current - el.clientHeight / 2);
    el.scrollTo({ top, behavior: 'smooth' });
  }, []);

  // 工作模式：滚到聚焦的工作区顶部（聚焦目标变化只滚一次）
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
    el.scrollTo({ top: Math.max(0, zv.y * scaleRef.current - 16), behavior: 'smooth' });
  }, [viewMode, focusZoneId, currentSessionId, zoneView]);

  // 切 session：有 session 默认工作模式（聚焦它的工作区），回 /work 默认整理模式
  useEffect(() => {
    fittedKeyRef.current = '';
    setFocusZoneId(currentSessionId || null);
    setViewMode(currentSessionId ? 'work' : 'arrange');
  }, [currentSessionId]);

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
          } else if (prevZone) {
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
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        const raw = await res.text();
        setViewer({ title: '便签', content: raw.replace(/^---\n[\s\S]{0,500}?\n---\n?/, '') });
      } catch { setViewer({ title: '便签', content: o.text || '' }); }
    }
  };

  const openFile = (o) => {
    window.open(Assets.artifactFileUrl(projectId, o.path), '_blank', 'noopener');
  };

  const handleCreateNote = async () => {
    const text = (noteDraft || '').trim();
    if (!text) { setNoteDraft(null); return; }
    try {
      // 有活跃 session 时便签自动归属它的工作区
      await Assets.createNote(projectId, { text, sessionId: currentSessionId || undefined });
      setNoteDraft(null);
      reload();
    } catch (err) { console.warn('[board] create note failed:', err.message); }
  };

  const handleDeleteNote = async (o) => {
    try { await Assets.removeNote(projectId, o.name); reload(); }
    catch (err) { console.warn('[board] delete note failed:', err.message); }
  };

  const focusDeck = (o) => {
    if (o.sid === currentSessionId) onFocusDeck?.();
    else {
      onEditNav?.();   // ✏️ 意图=编辑：切会话后 CanvasFrame 直接进 Edit 视图
      navigate(`/projects/${projectId}/sessions/${o.sid}`);
    }
  };

  // 双击打开（统一挂在卡片根节点：pointer capture 会把 click/dblclick 重定向到
  // 捕获元素本身，挂内层 div 事件根本到不了 —— 2026-07-27 双击失灵的根因）
  const primaryOpen = (o) => {
    if (o.type === 'doc' || o.type === 'note') openViewer(o);
    else if (o.type === 'image') setDetail(o);
    else if (o.type === 'file') openFile(o);
    else if (o.type === 'deck') {
      if (o.pos.expanded) focusDeck(o);
      else patchLayout(o.id, { expanded: true });
    }
  };

  const switchView = useCallback((m) => {
    if (m === 'work') {
      const target = focusZoneId || currentSessionId;
      if (!target) return;
      if (!focusZoneId) setFocusZoneId(target);
      fittedKeyRef.current = '';           // 强制重新锁定工作区
      setViewMode('work');
    } else {
      setViewMode('arrange');
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
    }
  }, [focusZoneId, currentSessionId]);

  // ── 工作区操作：收纳 ↔ 展开（文件夹两态）/ 聚焦 / 自建文件夹 ──
  const patchZone = useCallback((zid, patch) => {
    setZones(prev => (prev[zid] ? { ...prev, [zid]: { ...prev[zid], ...patch } } : prev));
    dirtyRef.current.zones.add(zid);
    scheduleSave();
  }, [scheduleSave]);

  const focusZoneAction = (zid) => {
    if (zones[zid]?.collapsed) patchZone(zid, { collapsed: false });
    // 聚焦别的 session 的工作区 = 会话也跟着切（左栏上下文随之变），
    // 视图天然留在工作台（自动切 edit 已退役）
    if (sessionTitles.has(zid) && zid !== currentSessionId) {
      navigate(`/projects/${projectId}/sessions/${zid}`);
      return;
    }
    setFocusZoneId(zid);
    fittedKeyRef.current = '';
    setViewMode('work');
  };

  const handleCreateFolder = () => {
    const title = (folderDraft || '').trim();
    if (!title) { setFolderDraft(null); return; }
    const zid = `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setZones(prev => ({ ...prev, [zid]: { ...newStackedZoneRect(prev), title } }));
    dirtyRef.current.zones.add(zid);
    scheduleSave();
    setFolderDraft(null);
  };

  // ── deck 自动内嵌渲染（2026-07-28：工作台=常驻默认视图后的配套）──
  // 工作内容直接在画布里看：当前会话的 deck 有 canvas 就自动展开成内嵌 iframe。
  // 两个触发源：进会话时 HEAD 探测已有 canvas；agent 正在写 deck（file_changed）。
  // 用户手动收起过（layout.expanded 有显式值）就不抢——每 sid 只自动展开一次。
  const autoExpandedRef = useRef(new Set());
  const pendingExpandRef = useRef(new Set());

  const tryAutoExpand = useCallback((sid) => {
    if (!sid || autoExpandedRef.current.has(sid)) return true;
    const deckId = `deck:${sid}`;
    const entry = layoutRef.current[deckId];
    if (entry && entry.expanded !== undefined) {
      autoExpandedRef.current.add(sid);   // 用户碰过展开态，尊重
      return true;
    }
    const o = positionedRef.current.find(it => it.id === deckId);
    if (!o) return false;                 // deck 物件还没派生出来，等布局更新再试
    autoExpandedRef.current.add(sid);
    patchLayout(deckId, { x: o.pos.x, y: o.pos.y, expanded: true });
    return true;
  }, [patchLayout]);

  useEffect(() => {
    if (!currentSessionId || autoExpandedRef.current.has(currentSessionId)) return;
    let cancelled = false;
    fetch(Canvas.artifactUrl(projectId, currentSessionId, 0), { method: 'HEAD' })
      .then((r) => {
        if (cancelled || !r.ok) return;
        if (!tryAutoExpand(currentSessionId)) pendingExpandRef.current.add(currentSessionId);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, currentSessionId, tryAutoExpand]);

  // 布局每次变化把挂起的自动展开消化掉（deck 物件迟到的场景）
  useEffect(() => {
    if (!pendingExpandRef.current.size) return;
    for (const sid of [...pendingExpandRef.current]) {
      if (tryAutoExpand(sid)) pendingExpandRef.current.delete(sid);
    }
  }, [positioned, tryAutoExpand]);

  // 舞台层的 file_changed 触发口：立刻试展开，deck 物件还没派生出来就挂起等布局
  const requestAutoExpand = useCallback((sid) => {
    if (!tryAutoExpand(sid)) pendingExpandRef.current.add(sid);
  }, [tryAutoExpand]);

  // ── 舞台层（StageLayer.jsx 自治）：事件状态机 + 跟随触发 + deck 自动展开触发 ──
  const { stageCards, stageBadges, dismissStageCard } = useStageState({
    stageRef, currentSessionId, followToObject, tryAutoExpand: requestAutoExpand,
  });

  // 舞台卡分流（StageLayer.jsx）：锚得到可见物件贴物件，锚不到落 dock
  const visibleIdSet = new Set(visibleObjects.map(o => o.id));
  const { anchoredCards, dockPanels, dockChips } = splitStageCards({
    stageCards, positioned, visibleIdSet, visibleZones, currentSessionId, focusZone,
  });

  // ── 外层工具栏桥（工具栏合并：控件画在 CanvasToolbar，操作从这里走）──
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      switchView,
      newNote: () => setNoteDraft(''),
      newFolder: () => setFolderDraft(''),
      newTask: () => navigate(`/projects/${projectId}/work`),
      reload,
      // 跟随 agent 镜头开关：开 → 立即解除用户接管冷却
      toggleFollow: () => setFollow(f => {
        if (!f) userHoldUntilRef.current = 0;
        return !f;
      }),
    };
    return () => { apiRef.current = null; };
  });
  const lastUiRef = useRef('');
  useEffect(() => {
    const fz = viewMode === 'work' ? (focusZoneId || currentSessionId) : null;
    const zv = fz ? zoneView.find(z => z.id === fz) : null;
    const ui = {
      viewMode, follow, canWork: !!(focusZoneId || currentSessionId),
      hasSession: !!currentSessionId,
      focus: zv ? { id: zv.id, title: zv.title, count: zv.memberCount, isSession: sessionTitles.has(zv.id) } : null,
    };
    // zoneView 每次布局变更都换新引用（拖拽期间逐帧）—— 序列化对比，内容没变不上报
    const key = JSON.stringify(ui);
    if (key === lastUiRef.current) return;
    lastUiRef.current = key;
    onUiState?.(ui);
  }, [onUiState, viewMode, follow, focusZoneId, currentSessionId, zoneView, sessionTitles]);

  // ── 渲染 ──
  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#f6f4ef' }}>
      <style>{[
        '@keyframes ndPopIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}',
        '@keyframes ndStageOut{to{opacity:0;transform:scale(.97)}}',
        '@keyframes ndShimmer{from{background-position:200% 0}to{background-position:-60% 0}}',
        '@keyframes ndCaret{0%,100%{opacity:1}50%{opacity:0}}',
        '@keyframes ndSpin{to{transform:rotate(360deg)}}',
        '@keyframes ndPulse{from{box-shadow:0 0 0 0 rgba(79,143,91,0.4)}to{box-shadow:0 0 0 12px rgba(79,143,91,0)}}',
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
            width: DESKTOP_W, height: boardSize.h,
            transform: `scale(${scale})`,
            transformOrigin: '0 0',
            background: '#f6f4ef',
            backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.07) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        >
          {/* 工作区（物件下层）：展开态 = 实体区域（标题栏拖整区），收纳态 = 文件夹卡 */}
          {visibleZones.map((z) => z.collapsed ? (
            <div
              key={z.id}
              onClick={(e) => {
                if (e.target.closest('[data-zone-action]')) return;
                if (!wasDrag()) patchZone(z.id, { collapsed: false });
              }}
              title="点击展开工作区"
              style={{
                position: 'absolute', left: z.x, top: z.y, width: 210,
                zIndex: 1, borderRadius: 10,
                background: dropHint?.kind === 'folder' && dropHint.id === z.id ? '#fff8e8' : COLOR.bgCard,
                border: `1px solid ${dropHint?.kind === 'folder' && dropHint.id === z.id ? '#b08c4f' : COLOR.borderLt}`,
                boxShadow: dropHint?.kind === 'folder' && dropHint.id === z.id
                  ? '0 0 0 3px rgba(176,140,79,0.18), 0 8px 20px rgba(0,0,0,0.14)'
                  : '0 1px 4px rgba(0,0,0,0.05)',
                transform: dropHint?.kind === 'folder' && dropHint.id === z.id ? 'scale(1.04)' : 'none',
                transition: `transform 150ms cubic-bezier(0.32, 0.72, 0, 1), box-shadow 150ms, border-color 150ms${dragActive ? '' : `, left 380ms ${EASE}, top 380ms ${EASE}`}`,
                padding: GAP.md, cursor: 'pointer', userSelect: 'none',
                animation: POP_IN,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Folder size={14} color="#8a7a5c" />
                <span style={{
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600, color: COLOR.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }}>{z.title}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
                  {z.memberCount} 项 · 点击展开
                </span>
                <button
                  data-zone-action title="聚焦（工作视图打开）"
                  onClick={() => !wasDrag() && focusZoneAction(z.id)}
                  style={{ marginLeft: 'auto', border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.text, display: 'flex', padding: 2 }}
                ><Focus size={12} /></button>
              </div>
            </div>
          ) : (
            <div
              key={z.id}
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
                transition: `border-color 150ms, background 150ms, box-shadow 150ms${dragActive ? '' : `, left 380ms ${EASE}, top 380ms ${EASE}, width 380ms ${EASE}, height 380ms ${EASE}`}`,
              }}
            >
              <div
                onClick={(e) => {
                  if (e.target.closest('[data-zone-action]')) return;
                  if (wasDrag()) return;
                  patchZone(z.id, { collapsed: true });
                  if (focusZone === z.id) switchView('arrange');
                }}
                title="点击收纳成文件夹"
                style={{
                  pointerEvents: 'auto', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                  margin: 6, height: ZONE.header - 12, padding: '0 10px',
                  borderRadius: 8, background: 'rgba(0,0,0,0.045)',
                  userSelect: 'none', touchAction: 'none',
                }}
              >
                <Focus size={12} color={COLOR.sub} />
                <span style={{
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 600, color: COLOR.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{z.title}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: COLOR.sub }}>{z.memberCount}</span>
                {z.id === currentSessionId && (
                  <span style={{
                    fontFamily: FONT_MONO, fontSize: 9,
                    color: COLOR.bg, background: COLOR.text, borderRadius: 4, padding: '1px 6px',
                  }}>当前任务</span>
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
                  {viewMode === 'arrange' && (
                    <button
                      data-zone-action title="聚焦（工作视图打开）"
                      onClick={() => !wasDrag() && focusZoneAction(z.id)}
                      style={zoneHeaderBtn}
                    ><FolderOpen size={12} /></button>
                  )}
                  <button
                    data-zone-action title="收纳成文件夹"
                    onClick={() => {
                      if (wasDrag()) return;
                      patchZone(z.id, { collapsed: true });
                      if (focusZone === z.id) switchView('arrange');
                    }}
                    style={zoneHeaderBtn}
                  ><FolderInput size={12} /></button>
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
              refreshToken={refreshToken}
              added={addedPaths.has(o.id)}
              animateLayout={!dragActive}
              onPointerDown={(e) => onObjectPointerDown(e, o)}
              wasDrag={wasDrag}
              onPrimary={() => primaryOpen(o)}
              onAdd={() => handleAdd(o)}
              onOpenViewer={() => openViewer(o)}
              onOpenFile={() => openFile(o)}
              onDetail={() => setDetail(o)}
              onDeleteNote={() => handleDeleteNote(o)}
              onToggleExpand={() => patchLayout(o.id, { expanded: !o.pos.expanded })}
              onFocus={() => focusDeck(o)}
            />
          ))}

          {/* 舞台层（板内坐标系）：角标 + 贴物件卡（StageLayer.jsx）*/}
          <StageBoardLayer
            stageBadges={stageBadges}
            anchoredCards={anchoredCards}
            positioned={positioned}
            visibleIdSet={visibleIdSet}
            boardSize={boardSize}
            onDismiss={dismissStageCard}
          />
        </div>
        </div>
      </div>

      {/* 舞台 dock（屏幕坐标系，StageLayer.jsx）*/}
      <StageDock dockPanels={dockPanels} dockChips={dockChips} onDismiss={dismissStageCard} />

      {/* 新建文件夹浮层 */}
      {folderDraft != null && (
        <Overlay onClose={() => setFolderDraft(null)}>
          <div style={{ padding: GAP.lg, background: COLOR.bg, borderRadius: 10, width: 'min(400px, 90vw)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: GAP.sm }}>
              <Folder size={14} color="#8a7a5c" />
              <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.md, color: COLOR.text }}>新建文件夹工作区</span>
            </div>
            <input
              autoFocus value={folderDraft} onChange={(e) => setFolderDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
              placeholder="标题（比如：参考素材 / 视频关键帧）"
              style={{
                width: '100%', border: `1px solid ${COLOR.borderLt}`, borderRadius: 6,
                padding: `${GAP.sm}px ${GAP.md}px`, outline: 'none',
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.md, color: COLOR.text,
                background: COLOR.bgCard,
              }}
            />
            <div style={{ display: 'flex', gap: GAP.sm, justifyContent: 'flex-end', marginTop: GAP.md }}>
              <button onClick={() => setFolderDraft(null)} style={toolBtn}>取消</button>
              <button onClick={handleCreateFolder} style={{ ...toolBtn, background: COLOR.text, color: COLOR.bg }}>创建</button>
            </div>
          </div>
        </Overlay>
      )}

      {/* 便签编辑浮层 */}
      {noteDraft != null && (
        <Overlay onClose={() => setNoteDraft(null)}>
          <div style={{ padding: GAP.lg, background: '#fffbeb', borderRadius: 10, width: 'min(480px, 90vw)' }}>
            <textarea
              autoFocus value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="灵感、方向、要给 agent 的约束……存上画布，随时拖动、随时带进对话"
              style={{
                width: '100%', minHeight: 100, border: 0, outline: 'none', resize: 'vertical',
                background: 'transparent', fontFamily: FONT_SANS, fontSize: FONT_SIZE.md,
                color: COLOR.text, lineHeight: 1.6,
              }}
            />
            <div style={{ display: 'flex', gap: GAP.sm, justifyContent: 'flex-end' }}>
              <button onClick={() => setNoteDraft(null)} style={toolBtn}>取消</button>
              <button onClick={handleCreateNote} style={{ ...toolBtn, background: COLOR.text, color: COLOR.bg }}>存上画布</button>
            </div>
          </div>
        </Overlay>
      )}

      {/* markdown 阅读浮层（便签全文 / 记忆 / 品牌）*/}
      {viewer && (
        <Overlay onClose={() => setViewer(null)}>
          <div style={{
            background: COLOR.bg, borderRadius: 12, padding: GAP.lg,
            width: 'min(720px, 92vw)', maxHeight: '82vh', overflow: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: GAP.sm }}>
              <BookOpen size={14} color={COLOR.sub} />
              <span style={{ marginLeft: 6, fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.md, color: COLOR.text }}>{viewer.title}</span>
              <button onClick={() => setViewer(null)} style={{ ...toolBtn, marginLeft: 'auto' }}><X size={12} /></button>
            </div>
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.7 }}>
              <ReactMarkdown>{viewer.content}</ReactMarkdown>
            </div>
          </div>
        </Overlay>
      )}

      {/* 图片详情浮层 */}
      {detail && (
        <Overlay onClose={() => setDetail(null)}>
          <div style={{
            background: COLOR.bg, borderRadius: 12, padding: GAP.lg,
            maxWidth: 'min(920px, 92vw)', maxHeight: '88vh', overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: GAP.md,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text }}>{detail.name}</span>
              <button onClick={() => setDetail(null)} style={{ ...toolBtn, marginLeft: 'auto' }}><X size={12} /></button>
            </div>
            <img
              src={Assets.artifactFileUrl(projectId, detail.path)} alt={detail.name}
              style={{ maxWidth: '100%', borderRadius: 8, border: `1px solid ${COLOR.borderLt}` }}
            />
            {detail.meta?.prompt && (
              <div style={{
                padding: GAP.md, borderRadius: 8, background: COLOR.bgCard, border: `1px solid ${COLOR.borderLt}`,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.6, whiteSpace: 'pre-wrap',
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
  o, projectId, currentSessionId, refreshToken, added, animateLayout = false,
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
    // agent 改布局（pin / board.updated 重拉 / 自动入座）时位置变化以滑动呈现；
    // 用户拖拽期间关掉（要逐帧跟手）—— dragActive 经 animateLayout 传进来
    transition: `${animateLayout ? `left 380ms ${EASE}, top 380ms ${EASE}, ` : ''}width 260ms ${EASE}, box-shadow 0.15s`,
  };

  const actions = [];
  if (o.type !== 'deck') actions.push({ icon: Plus, title: added ? '已在托盘' : '加入上下文', fn: onAdd });
  if (o.type === 'doc' || o.type === 'note') actions.push({ icon: BookOpen, title: '阅读', fn: onOpenViewer });
  if (o.type === 'image') actions.push({ icon: ExternalLink, title: '详情', fn: onDetail });
  if (o.type === 'file') actions.push({ icon: ExternalLink, title: '打开', fn: onOpenFile });
  if (o.type === 'deck') actions.push({ icon: ChevronsUpDown, title: o.pos.expanded ? '收起' : '内嵌渲染', fn: onToggleExpand });
  if (o.type === 'deck') actions.push({ icon: PencilLine, title: '编辑（开放 deck 工具）', fn: onFocus });
  if (o.type === 'note') actions.push({ icon: Trash2, title: '删除', fn: onDeleteNote });

  const Actions = hover && (
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
            <button data-board-action title="内嵌渲染" onClick={onToggleExpand} style={winBtn}>
              <ChevronsUpDown size={11} />
            </button>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
            {o.sid === currentSessionId ? '当前会话 · 双击内嵌渲染' : `${formatTime(o.mtime)} · 双击内嵌渲染`}
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
            style={{ width: DECK_EMBED_W, height: 360, overflow: 'hidden', background: '#fff', borderRadius: '0 0 10px 10px' }}
          >
            {/* 内嵌渲染：live iframe 缩到 1/3，pointer-events 关闭 —— deck 元素级
                工具（DirectEdit / Drag / Comment）只在聚焦（✏️）后的编辑视图开放 */}
            <iframe
              title={`deck-${o.sid}`}
              src={Canvas.artifactUrl(projectId, o.sid, refreshToken)}
              sandbox="allow-scripts allow-same-origin"
              style={{
                width: 1920, height: 1080, border: 0,
                transform: `scale(${DECK_EMBED_W / 1920})`, transformOrigin: '0 0',
                pointerEvents: 'none',
              }}
            />
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

      {o.type === 'note' && (
        <div
          style={{
            padding: GAP.md, background: '#fffbeb', borderRadius: 10, minHeight: SIZES.note.h - 2,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.6,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}
        >
          {o.text || o.name}
        </div>
      )}

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

function Overlay({ children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: GAP.page,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ animation: POP_IN }}>{children}</div>
    </div>
  );
}

function thumbSrcOf(projectId, item) {
  if (item.hasThumb) {
    const base = item.name.replace(/\.[^.]+$/, '');
    return Assets.artifactFileUrl(projectId, `assets/generated/.thumbnails/${base}.thumb.jpg`);
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
