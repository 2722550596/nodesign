/**
 * 「双击一件东西会发生什么」（2026-08-17 从 BoardCanvas 拆出 —— 行数棘轮）。
 *
 * 一张 PRIMARY 表把物件形态映射到打开语义（阅读 / 图片详情 / 下载原文件 /
 * 开产物窗 / 改字 / 编排设置页），外加两个跟"处置一件东西"同族的动作：
 * 加进对话上下文、删一条便签。
 *
 * ⚠️ 双击的事件为什么统一挂在卡片根节点：pointer capture 会把 click/dblclick
 * 重定向到捕获元素本身，挂内层 div 事件根本到不了 —— 2026-07-27 双击失灵的根因。
 * 那条接线在 BoardCanvas 的 renderObjectCard 里，这里只提供"打开"本身。
 */
import { Assets } from '../../lib/api.js';
import { primaryOf } from '../../lib/board-kinds.js';
import { makeBoardReaders } from './BoardOverlays.jsx';

const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.md': 'text/markdown',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.zip': 'application/zip',
};

export function useBoardOpen({
  projectId, onAddToContext, onFocusDeck,
  setLayout, dirtyRef, scheduleSave, reload,
  setAddedPaths, setViewer, setOrchestrate, setDetail,
  openTextEditor,
}) {
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

  // 进阅读器：路由与三种阅读器本体在 BoardOverlays.jsx（B5 抽出）
  const openViewer = makeBoardReaders({ projectId, setViewer });

  const openFile = (o) => {
    window.open(Assets.artifactFileUrl(projectId, o.path), '_blank', 'noopener');
  };

  // 编排.yaml → 图形设置页。dir = 配置所在文件夹（演出文件夹）
  const openOrchestrate = (o) => {
    const p = String(o.path || '');
    setOrchestrate({ dir: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '' });
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

  const focusDeck = (o) => {
    if (o.type === 'site') {
      // 站点：开的是"整站"，不是某一个文件 —— 当前看哪一页是窗口内部状态。
      // 试作卡开同一扇窗，但 entry 指向 _drafts/ 里那一份。
      onFocusDeck?.({
        kind: 'site', task: o.task, base: o.base || o.task,
        entry: o.entry || 'index.html', title: o.title, pages: o.pages, exports: o.exports,
        // 构建型（产物根≠源目录）：编辑窗要提示"改的是产物，agent 会同步回源"
        built: !!(o.root && o.root !== o.srcRoot),
      });
    } else if (o.type === 'docx') {
      // word：开的是一份文档，当前看第几页是窗口内部状态（页是排版算出来的，
      // 不像 deck 的 section 或站点的文件那样可以外部指定）
      onFocusDeck?.({
        kind: 'docx', file: o.deckFile, title: o.title,
        sourceFile: o.sourceFile || null, exports: o.exports,
        // 卡 id 就是导出的寻址地址，窗里的导出按钮要靠它 —— 不带的话
        // 导出会退回「当前聚焦」那套猜测，而窗开着的时候那套是空的
        cardId: o.id,
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
    // 编排.yaml：图形设置页
    orchestrate: openOrchestrate,
  };

  const primaryOpen = (o) => PRIMARY[primaryOf(o)]?.(o);

  return {
    handleAdd, openViewer, openFile, openOrchestrate,
    handleDeleteNote, focusDeck, primaryOpen,
  };
}
