import { useCallback, useEffect, useRef } from 'react';

/**
 * preview_deck 的落点（2026-08-18 从 BoardCanvas 拆出来）
 *
 * 语义 = **等价于用户双击那张卡**。不挑层：窗是浮在桌面之上的，被预览的东西住在
 * 哪个文件夹里都能直接开。
 *
 * 两件容易漏的事，也是这块值得单独成文件的原因：
 *
 * 1. **目标可能还没上墙。** agent 刚写出来的文件，产物列表要下一次重拉才认它。
 *    所以命中不了就挂起，等它出现再补开。
 * 2. ⚠️ **挂起时路径要跟着一起挂。** 只记 objectId 的话，补开时站点会退回首页，
 *    而 agent 明明点的是某一页 —— 那是"看起来成功了"的又一种形态。
 *
 * @param {object} p
 * @param {React.RefObject<Array>} p.positionedRef 已定位物件（当前帧）
 * @param {React.RefObject<Array>} p.objectsRef    全部物件（含未定位）
 * @param {Array} p.positioned  用来触发"补开"的响应式依赖
 * @param {React.RefObject<Function>} p.primaryOpenRef  双击打开的那个函数
 * @param {Function} p.followToObject  镜头跟过去
 */
export function usePreviewRequest({
  positionedRef, objectsRef, positioned, primaryOpenRef, followToObject,
}) {
  const pendingRef = useRef(null);

  const handlePreviewRequest = useCallback((objectId, previewPath = null) => {
    const o = positionedRef.current?.find(it => it.id === objectId)
      || objectsRef.current?.find(it => it.id === objectId);
    if (!o) { pendingRef.current = { objectId, previewPath }; return; }
    primaryOpenRef.current?.(o, previewPath);
    followToObject?.(objectId);
  }, [positionedRef, objectsRef, primaryOpenRef, followToObject]);

  // 挂起的 preview：目标物件一上墙就补开
  useEffect(() => {
    const want = pendingRef.current;
    if (!want) return;
    const o = positioned.find(it => it.id === want.objectId);
    if (!o) return;
    pendingRef.current = null;
    primaryOpenRef.current?.(o, want.previewPath);
    followToObject?.(want.objectId);
  }, [positioned, primaryOpenRef, followToObject]);

  return handlePreviewRequest;
}
