import { Exports } from '../../lib/api.js';
import { defaultFormatFor } from '../../lib/export-formats.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * card-export.js — 导出画布上的一张卡（2026-08-17 重做导出）
 *
 * 从 BoardCanvas 拆出来（行数棘轮：那份贴着上限）。拆得动是因为它不闭包
 * BoardCanvas 的任何状态 —— 只要 projectId 和那个物件。
 *
 * ⚠️ 调用方只该对**背后真有文件**的卡挂这颗按钮（BoardCanvas 用 isFileBacked 判）：
 * 涂鸦和画布文字是画布原生物件，它们的 id 是布局档里的条目不是路径，导出必然 404。
 *
 * 默认格式按卡类型来：文件类（图 / 视频 / 便签 / 其它文件）给原件，目录与页面类
 * 给打包。想换格式走顶栏那个菜单 —— 卡上这颗是「我就要这个东西」的快捷键，
 * 不该在卡上再长一层菜单。
 */

/** 把 blob 塞进浏览器下载。objectURL 要回收，不然一次会话点几十次就攒一堆 */
function pushDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '导出';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {string} projectId
 * @param {{id:string, cardKind?:string, type?:string, title?:string}} obj 画布物件
 */
export async function exportCard(projectId, obj) {
  const format = defaultFormatFor(obj.cardKind || obj.type);
  const toast = useGlobalStore.getState().showToast;
  try {
    const { blob, filename, skipped } = await Exports.cards(projectId, [obj.id], format);
    pushDownload(blob, filename || obj.title);
    // ⚠️ 收不到的卡必须说出来。静默少东西是导出最贵的失败方式：用户解压之后
    // 才发现少了，那时他已经不知道是哪一步丢的。
    if (skipped?.total) {
      const first = skipped.items?.[0];
      toast(`有 ${skipped.total} 张没导出${first ? `：${first.reason}` : ''}`, 'error');
    }
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error');
  }
}

/**
 * 顶栏导出菜单的下载动作。
 *
 * ⭐**工程包走「按卡导出」那条新路**：旧的 `GET /exports/handoff` 把整个项目级
 * `shared/assets` 打进包（生产上最大的项目 280MB，含别的任务的图），README 还是
 * 静态模板。新路只收这份产物真正引用到的素材，README 带「你的后端要实现哪些接口」
 * 的清单。其余格式（PDF / PPTX / 单页 HTML / 整站 zip）要跑 playwright / esbuild
 * 烘焙管线，仍走各自的老路由。
 *
 * 聚焦不到具体产物时（cardId 为空）退回老路 —— 别让用户点了没反应。
 */
export async function exportFromMenu(projectId, format, cardId, fallbackName) {
  const toast = useGlobalStore.getState().showToast;
  try {
    const useCards = format === 'handoff' && cardId;
    const { blob, filename } = useCards
      ? await Exports.cards(projectId, [cardId], 'handoff')
      : await Exports.download(projectId, format);
    const name = filename || `${fallbackName || 'design'}.${format === 'handoff' ? 'zip' : format}`;
    pushDownload(blob, name);
    toast(`已下载：${name}`, 'success');
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error');
  }
}

