import { useEffect, useState, useRef, useCallback } from 'react';
import { Image as ImageIcon, PencilLine, Terminal, X } from 'lucide-react';
import { COLOR, GAP, FONT_MONO } from '../../lib/theme.js';
import { stageKindOf, resolveObjectId, zoneOfObjectId, fileNameOf, chipHintOf, toolLabelOf } from '../../lib/stage.js';
import { ZONE, STAGE_CARD_W, POP_IN, sizeOf } from '../../lib/board-geometry.js';
import { AskUserQuestionView } from '../chat/Message.jsx';

// 生图占位卡的身位（4:3 图区 + 一行说明），铺坑位时按它算行列
const SHIMMER_W = 200;
const SHIMMER_H = 196;
const SHIMMER_LABEL_H = 22;      // 底部那行说明
const SHIMMER_MIN_H = 84;        // 再挤也不低于这个高度

/**
 * StageLayer — 舞台层（2026-07-28 重构 3 从 BoardCanvas 抽出）
 *
 * 桌面上的"第二渲染平面"：agent 的实时动作演出（代码直播 / 终端 / 生图
 * shimmer / chip / 已更新角标 / 画布内答题）。与桌面只共享一个事实——
 * "物件在哪"（positioned / 可见性），其余状态全部自治：
 *
 *   useStageState   事件驱动的卡片状态机（stageRef 接线、镜头跟随触发、
 *                   deck 自动展开触发都在这）
 *   splitStageCards 渲染分流：锚得到可见物件 → 板内；锚不到 → dock
 *   StageBoardLayer 板内坐标系那一面（角标 + 贴物件卡），随桌面缩放
 *   StageDock       屏幕坐标系那一面（视口底部居中）
 *
 * 子代理时间轴与这里共享 lib/stage.js 的同一份事件翻译。
 */

// ── 状态机 ──

export function useStageState({ stageRef, currentSessionId, siteTasks, followToObject, tryAutoExpand, onStageTarget, onPreviewRequest }) {
  const [stageCards, setStageCards] = useState({});
  const [stageBadges, setStageBadges] = useState({});
  const followedBlocksRef = useRef(new Set());   // 每张舞台卡只推一次镜头

  const removeStageCardLater = useCallback((blockId, ms) => {
    setTimeout(() => {
      setStageCards(prev => {
        const c = prev[blockId];
        if (!c || c.status === 'fail') return prev;   // 失败卡保留，用户点 × 关
        const next = { ...prev };
        delete next[blockId];
        return next;
      });
    }, ms);
  }, []);

  const newStageCard = (evt, kind) => ({
    blockId: evt.blockId, kind, tool: evt.name, status: 'running',
    text: '', filePath: null, objectId: null, oldString: null, startedAt: Date.now(),
  });

  const handleStageEvent = useCallback((evt) => {
    switch (evt.type) {
      case 'run.tool_use.started': {
        const kind = stageKindOf(evt.name);
        if (!kind || !evt.blockId) return;
        setStageCards(prev => (prev[evt.blockId] ? prev : { ...prev, [evt.blockId]: newStageCard(evt, kind) }));
        break;
      }
      case 'run.delta.tool_input': {
        // 真流式：append = Edit.new_string / Write.content 的纯文本增量
        if (!evt.blockId) return;
        const oid = evt.filePath ? resolveObjectId(evt.filePath, currentSessionId, siteTasks) : null;
        setStageCards(prev => {
          const c = prev[evt.blockId] || newStageCard(evt, stageKindOf(evt.name) || 'code');
          return {
            ...prev,
            [evt.blockId]: {
              ...c,
              filePath: c.filePath || evt.filePath || null,
              objectId: c.objectId || oid,
              text: c.text + (evt.append || ''),
            },
          };
        });
        if (oid && !followedBlocksRef.current.has(evt.blockId)) {
          followedBlocksRef.current.add(evt.blockId);
          onStageTarget?.(oid);
          followToObject?.(oid);
        }
        break;
      }
      case 'run.delta.tool_use': {
        // 完整入参快照（工具执行前到达）
        const kind = stageKindOf(evt.name);
        if (!kind || !evt.blockId) return;
        const input = evt.input || {};
        const oid = typeof input.file_path === 'string' ? resolveObjectId(input.file_path, currentSessionId, siteTasks) : null;
        setStageCards(prev => {
          const c = prev[evt.blockId] || newStageCard(evt, kind);
          const patch = {
            filePath: c.filePath || input.file_path || null,
            objectId: c.objectId || oid,
          };
          if (kind === 'code') {
            if (typeof input.old_string === 'string' && input.old_string) patch.oldString = input.old_string;
            const full = typeof input.new_string === 'string' ? input.new_string
              : typeof input.content === 'string' ? input.content : null;
            if (full != null && full.length > c.text.length) patch.text = full;
          } else if (kind === 'terminal') {
            patch.command = typeof input.command === 'string' ? input.command : '';
          } else if (kind === 'image') {
            patch.prompt = typeof input.prompt === 'string' ? input.prompt : '';
          } else if (kind === 'question') {
            patch.input = input;   // 完整 questions 给画布上的答题卡
          } else {
            patch.hint = chipHintOf(evt.name, input);
          }
          return { ...prev, [evt.blockId]: { ...c, ...patch } };
        });
        if (kind === 'code' && oid && !followedBlocksRef.current.has(evt.blockId)) {
          followedBlocksRef.current.add(evt.blockId);
          onStageTarget?.(oid);
          followToObject?.(oid);
        }
        break;
      }
      case 'run.deck_preview': {
        // preview_deck 工具：agent 把 deck 摊到用户眼前（= 用户双击那张卡）
        const oid = evt.path ? resolveObjectId(evt.path, currentSessionId, siteTasks) : (currentSessionId ? `deck:${currentSessionId}` : null);
        if (oid) onPreviewRequest?.(oid);
        break;
      }
      case 'run.delta.tool_result': {
        if (!evt.blockId) return;
        setStageCards(prev => {
          const c = prev[evt.blockId];
          if (!c) return prev;
          const patch = { status: evt.ok ? 'ok' : 'fail', doneAt: Date.now() };
          if (typeof evt.output === 'string' && evt.output) {
            patch.output = evt.output.split('\n').slice(-8).join('\n').slice(-1200);
          }
          if (!evt.ok && typeof evt.error === 'string') patch.error = evt.error.slice(0, 600);
          return { ...prev, [evt.blockId]: { ...c, ...patch } };
        });
        removeStageCardLater(evt.blockId, 1600);
        break;
      }
      case 'run.file_changed': {
        // 物件"已更新"角标（在板上才有意义）
        const oid = resolveObjectId(evt.filePath, currentSessionId, siteTasks);
        if (!oid) return;
        // agent 正在写 deck → 自动展开内嵌渲染，工作过程直接在画布里看
        if (oid.startsWith('deck:')) tryAutoExpand?.(oid.slice(5));
        const ts = Date.now();
        setStageBadges(prev => ({ ...prev, [oid]: ts }));
        setTimeout(() => {
          setStageBadges(prev => {
            if (prev[oid] !== ts) return prev;
            const next = { ...prev };
            delete next[oid];
            return next;
          });
        }, 2600);
        break;
      }
      case 'run.done':
      case 'run.error':
      case 'run.cancelled': {
        // 收场：残留 running/ok 卡淡出，失败卡留给用户看
        setTimeout(() => {
          setStageCards(prev => {
            const next = {};
            for (const [k, c] of Object.entries(prev)) if (c.status === 'fail') next[k] = c;
            return next;
          });
        }, 900);
        followedBlocksRef.current.clear();
        break;
      }
      default: break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, siteTasks, followToObject, removeStageCardLater, tryAutoExpand, onStageTarget, onPreviewRequest]);

  useEffect(() => {
    if (!stageRef) return;
    stageRef.current = { onEvent: handleStageEvent };
    return () => { stageRef.current = null; };
  }, [stageRef, handleStageEvent]);

  const dismissStageCard = useCallback((blockId) => {
    setStageCards(prev => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
  }, []);

  return { stageCards, stageBadges, dismissStageCard };
}

// ── 渲染分流 ──

/**
 * 落点三级兜底（2026-07-28）：
 *   ① 目标物件已经在墙上且可见 → 贴着它摆
 *   ② 物件还没上墙（新文件正在写，产物列表要等这次写完才知道它存在）
 *      → 贴到它天然归属的那块工作区里（zone id 由路径派生）
 *   ③ 连工作区都定位不到（路径认不出 / 那块区被收纳了）→ 落 dock
 *
 * ② 是这次补的：以前 ①失败直接掉 dock，于是"写新文件"的代码卡整场都钉在屏幕
 * 底部，等写完 file_changed 触发产物重拉、物件出现，才突然跳到文件旁边。
 */
const hitRect = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/**
 * 生图占位卡的落点：沿工作区下沿从左往右铺，一行放不下往上翻行，**跳过已被占的位置**
 * （区里已有的图片 / 已经摆好的其他占位卡）。跟物件之间的防遮盖是同一套判定。
 *
 * 工作区矮到装不下整张卡时把卡压扁 —— 宁可矮一点也不要探出工作区外面。
 */
function placeImageCard(zoneRect, taken) {
  const avail = zoneRect.h - ZONE.header - ZONE.pad * 2;
  const h = Math.max(SHIMMER_MIN_H, Math.min(SHIMMER_H, avail));
  const SLOT_W = SHIMMER_W + 12;
  const SLOT_H = h + 12;
  const perRow = Math.max(1, Math.floor((zoneRect.w - ZONE.pad * 2) / SLOT_W));
  const rows = Math.max(1, Math.floor((zoneRect.h - ZONE.header - ZONE.pad * 2 + 12) / SLOT_H));
  const at = (col, row) => ({
    x: zoneRect.x + ZONE.pad + col * SLOT_W,
    y: Math.max(
      zoneRect.y + ZONE.header + ZONE.pad,
      zoneRect.y + zoneRect.h - ZONE.pad - h - row * SLOT_H,
    ),
    w: SHIMMER_W,
    h,
  });
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < perRow; col++) {
      const r = at(col, row);
      if (!taken.some(t => hitRect(t, r))) return r;
    }
  }
  return at(0, 0);   // 全满了就压在左下角（它是浮层，盖住也看得见）
}

/**
 * 落点三级兜底（2026-07-28）：
 *   ① 目标物件已经在墙上且可见 → 贴着它摆
 *   ② 物件还没上墙（新文件正在写，产物列表要等这次写完才知道它存在）
 *      → 贴到它天然归属的那块工作区里（zone id 由路径派生）
 *   ③ 连工作区都定位不到（路径认不出 / 那块区被收纳了）→ 落 dock
 *
 * ② 是这次补的：以前 ①失败直接掉 dock，于是"写新文件"的代码卡整场都钉在屏幕
 * 底部，等写完 file_changed 触发产物重拉、物件出现，才突然跳到文件旁边。
 *
 * occupancy：zoneId → 该区内已有物件的矩形。生图占位卡据此避开已有的图。
 */
export function splitStageCards({ stageCards, positioned, visibleIdSet, visibleZones, currentSessionId, focusZone, occupancy }) {
  const anchoredCards = [];
  const dockPanels = [];
  const dockChips = [];
  const visibleZoneOf = (zid) => (zid ? visibleZones.find(v => !v.collapsed && v.id === zid) : null);
  // 同一块区里并发的同类卡各占一个坑位，不要叠在同一个点上（生图经常一次发好几张）
  const slots = new Map();
  const takeSlot = (zid, kind) => {
    const k = `${zid}|${kind}`;
    const n = slots.get(k) || 0;
    slots.set(k, n + 1);
    return n;
  };
  // 每块区已占的矩形：区内物件打底，摆一张占位卡就往里加一张
  const takenOf = (zid) => {
    if (!slots.has(`rects|${zid}`)) {
      const base = (occupancy && (occupancy.get ? occupancy.get(zid) : occupancy[zid])) || [];
      slots.set(`rects|${zid}`, [...base]);
    }
    return slots.get(`rects|${zid}`);
  };
  for (const c of Object.values(stageCards)) {
    if (c.kind === 'chip') { dockChips.push(c); continue; }
    if (c.kind === 'question') { dockPanels.push(c); continue; }
    if (c.kind !== 'image') {
      const o = c.objectId ? positioned.find(it => it.id === c.objectId) : null;
      if (o && visibleIdSet.has(o.id)) { anchoredCards.push({ card: c, obj: o }); continue; }
    }
    // 物件不在（或不可见，生图更是压根还没有物件）→ 退到工作区。
    // 目标未知的（file_path 还没流出来）就贴当前工作区，反正 agent 正在这里干活。
    //
    // 兜底顺序里 focusZone 必须排在 currentSessionId 前面（2026-07-28）：任务绑了
    // 会话之后，会话区被任务区取代、id 是 `task/<名字>` —— 拿 sessionId 去找区永远
    // 找不到，生图卡就全掉进屏幕底部的 dock 叠成一摞，看着像"没放进工作文件夹"。
    const zid = zoneOfObjectId(c.objectId, currentSessionId) || focusZone || currentSessionId;
    const zr = visibleZoneOf(zid);
    if (!zr) { dockPanels.push(c); continue; }
    if (c.kind === 'image') {
      const taken = takenOf(zr.id);
      const pos = placeImageCard(zr, taken);
      taken.push(pos);
      anchoredCards.push({ card: c, zoneRect: zr, pos });
    } else {
      anchoredCards.push({ card: c, zoneRect: zr, slot: takeSlot(zr.id, c.kind) });
    }
  }
  return { anchoredCards, dockPanels, dockChips };
}

// ── 板内坐标系那一面（角标 + 贴物件卡）──

export function StageBoardLayer({ stageBadges, anchoredCards, positioned, visibleIdSet, boardSize, onDismiss }) {
  return (
    <>
      {Object.entries(stageBadges).map(([oid, ts]) => {
        const o = positioned.find(it => it.id === oid);
        if (!o || !visibleIdSet.has(oid)) return null;
        const sz = sizeOf(o);
        return (
          <div key={`${oid}:${ts}`} data-stage="badge" style={{
            position: 'absolute', left: o.pos.x + sz.w - 40, top: o.pos.y - 13,
            zIndex: 55, pointerEvents: 'none', animation: POP_IN,
            background: '#b08c4f', color: '#fff', borderRadius: 6,
            fontFamily: FONT_MONO, fontSize: 9, padding: '2px 6px',
          }}>已更新</div>
        );
      })}
      {anchoredCards.map(({ card, obj, zoneRect, slot, pos }) => (
        <StageCard
          key={card.blockId}
          card={card}
          obj={obj}
          zoneRect={zoneRect}
          slot={slot}
          pos={pos}
          boardSize={boardSize}
          onDismiss={() => onDismiss(card.blockId)}
        />
      ))}
    </>
  );
}

// ── 屏幕坐标系那一面（dock）──

export function StageDock({ dockPanels, dockChips, onDismiss }) {
  if (dockPanels.length === 0 && dockChips.length === 0) return null;
  return (
    <div data-stage="dock" style={{
      position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      zIndex: 80, pointerEvents: 'none', maxWidth: '74%',
    }}>
      {[...dockPanels.filter(c => c.kind !== 'question'), ...dockPanels.filter(c => c.kind === 'question')]
        .slice(-3).map((card) => (
          <div key={card.blockId} style={{ pointerEvents: 'auto', width: card.kind === 'question' ? 'min(640px, 62vw)' : 'min(560px, 56vw)' }}>
            {card.kind === 'question'
              ? <QuestionStageCard card={card} onDismiss={() => onDismiss(card.blockId)} />
              : <StageCardBody card={card} onDismiss={() => onDismiss(card.blockId)} />}
          </div>
        ))}
      {dockChips.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', pointerEvents: 'auto' }}>
          {dockChips.map((card) => (
            <StageChip key={card.blockId} card={card} onDismiss={() => onDismiss(card.blockId)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 卡片组件 ──

/** 舞台卡（板内坐标系定位）：贴目标物件摆（右侧优先，放不下换左/下）；shimmer 贴工作区下沿 */
function StageCard({ card, obj, zoneRect, slot = 0, pos, boardSize, onDismiss }) {
  // 物件还没上墙：贴在工作区右上（标题栏下面），跟着这块区一起动。
  // 同区并发多张时逐张往左下错开，免得后来的把前面那张完全盖住。
  if (!obj && zoneRect && card.kind !== 'image') {
    const step = Math.min(slot, 3) * 18;
    const x = Math.max(12, Math.min(boardSize.w - STAGE_CARD_W - 12,
      zoneRect.x + zoneRect.w - STAGE_CARD_W - ZONE.pad - step));
    const y = zoneRect.y + ZONE.header + ZONE.pad + step;
    return (
      <div style={{ position: 'absolute', left: x, top: y, width: STAGE_CARD_W, zIndex: 60 + slot, pointerEvents: 'auto' }}>
        <StageCardBody card={card} onDismiss={onDismiss} />
      </div>
    );
  }
  // 生图占位：沿工作区下沿从左往右铺，一行放不下就往上翻一行 —— 一次发好几张
  // 是常态（风格探索的九宫格），全叠在同一个点上会看成"没放进工作区"。
  // 生图占位：落点由 splitStageCards 算好（避开区内已有的图和别的占位卡）
  if (card.kind === 'image' && pos) {
    return (
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: pos.w, zIndex: 60, pointerEvents: 'auto' }}>
        <ShimmerCard card={card} height={pos.h} onDismiss={onDismiss} />
      </div>
    );
  }
  const sz = sizeOf(obj);
  let x = obj.pos.x + sz.w + 24;
  let y = obj.pos.y;
  if (x + STAGE_CARD_W > boardSize.w - 12) x = obj.pos.x - STAGE_CARD_W - 24;
  if (x < 12) {
    x = Math.max(12, Math.min(boardSize.w - STAGE_CARD_W - 12, obj.pos.x));
    y = obj.pos.y + sz.h + 20;
  }
  y = Math.max(12, Math.min(boardSize.h - 400, y));
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: STAGE_CARD_W, zIndex: 60, pointerEvents: 'auto' }}>
      <StageCardBody card={card} onDismiss={onDismiss} />
    </div>
  );
}

/** 舞台卡内容体（代码直播 / 终端）—— 板内锚定与 dock 共用 */
function StageCardBody({ card, onDismiss }) {
  if (card.kind === 'image') return <ShimmerCard card={card} onDismiss={onDismiss} />;
  const running = card.status === 'running';
  const isTerm = card.kind === 'terminal';
  const border = card.status === 'fail' ? '#b0554f' : card.status === 'ok' ? '#4f8f5b' : 'rgba(176,140,79,0.65)';
  const label = card.tool === 'Edit' ? '修改' : card.tool === 'Write' ? '写入' : toolLabelOf(card.tool);
  return (
    <div
      data-stage="card" data-stage-kind={card.kind} data-stage-status={card.status}
      style={{
        borderRadius: 12, overflow: 'hidden', border: `1.5px solid ${border}`,
        background: '#211e17', boxShadow: '0 10px 30px rgba(40,32,16,0.35)',
        animation: card.status === 'ok'
          ? `${POP_IN}, ndPulse 700ms ease-out, ndStageOut 380ms ease 1150ms forwards`
          : POP_IN,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'rgba(255,255,255,0.06)' }}>
        {isTerm ? <Terminal size={11} color="#c8b98c" /> : <PencilLine size={11} color="#c8b98c" />}
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: '#e8e2d2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {isTerm ? (card.command || 'bash') : `${label} · ${fileNameOf(card.filePath) || '…'}`}
        </span>
        {running ? (
          <span style={{ width: 10, height: 10, border: '1.5px solid rgba(232,226,210,0.35)', borderTopColor: '#e8e2d2', borderRadius: '50%', animation: 'ndSpin 800ms linear infinite', flexShrink: 0 }} />
        ) : (
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: card.status === 'ok' ? '#8fc79a' : '#e09a94', flexShrink: 0 }}>
            {card.status === 'ok' ? '✓' : '✗'}
          </span>
        )}
        {card.status === 'fail' && (
          <button onClick={onDismiss} style={{ border: 0, background: 'transparent', color: '#e8e2d2', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <X size={10} />
          </button>
        )}
      </div>
      {card.kind === 'code' && card.oldString && (
        <div style={{
          padding: '4px 10px', background: 'rgba(176,85,79,0.16)', color: '#dba49f',
          fontFamily: FONT_MONO, fontSize: 9.5, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 64, overflow: 'hidden',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          {clampLines(card.oldString, 3)}
        </div>
      )}
      <AutoScrollPre
        text={isTerm ? (card.output || '') : card.text}
        running={running}
        color={isTerm ? '#cfe3cf' : '#d9e4c9'}
        placeholder={running ? (isTerm ? '运行中…' : '正在生成…') : ''}
      />
      {card.status === 'fail' && card.error && (
        <div style={{ padding: '5px 10px', fontFamily: FONT_MONO, fontSize: 9.5, color: '#e09a94', whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {card.error}
        </div>
      )}
    </div>
  );
}

/** 代码/终端正文：文本追加时自动贴底滚动（直播视角永远看最新一行）*/
function AutoScrollPre({ text, running, color, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  if (!text && !running) return null;
  return (
    <div ref={ref} style={{ maxHeight: 280, overflowY: 'auto', padding: '8px 10px' }}>
      <pre style={{ margin: 0, fontFamily: FONT_MONO, fontSize: 10, lineHeight: 1.55, color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {text || placeholder}
        {running && (
          <span style={{ display: 'inline-block', width: 6, height: 11, marginLeft: 2, verticalAlign: '-2px', background: '#e8e2d2', animation: 'ndCaret 900ms step-end infinite' }} />
        )}
      </pre>
    </div>
  );
}

/** 生图占位（shimmer 扫光），真图由 board.updated / 产物重拉落座 */
function ShimmerCard({ card, height, onDismiss }) {
  const running = card.status === 'running';
  // height 由落点给（工作区矮的时候压扁）；dock 里没人给就走默认身位
  const imgH = height ? Math.max(28, height - SHIMMER_LABEL_H) : null;
  return (
    <div
      data-stage="card" data-stage-kind="image" data-stage-status={card.status}
      style={{
        width: SHIMMER_W, borderRadius: 10, overflow: 'hidden',
        border: `1px solid ${card.status === 'fail' ? '#b0554f' : 'rgba(176,140,79,0.5)'}`,
        background: COLOR.bgCard, boxShadow: '0 6px 18px rgba(60,48,20,0.18)',
        animation: card.status === 'ok' ? `${POP_IN}, ndStageOut 380ms ease 1150ms forwards` : POP_IN,
      }}
    >
      <div style={{
        ...(imgH ? { height: imgH } : { aspectRatio: '4 / 3' }),
        background: 'linear-gradient(100deg, #ece7db 30%, #faf8f2 45%, #ece7db 60%)',
        backgroundSize: '240% 100%',
        animation: running ? 'ndShimmer 1.5s linear infinite' : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <ImageIcon size={22} color="#b3a58a" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: COLOR.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {running ? '生成图片中…' : card.status === 'ok' ? '已生成' : '生成失败'}
          {card.prompt ? ` · ${card.prompt}` : ''}
        </span>
        {card.status === 'fail' && (
          <button onClick={onDismiss} style={{ border: 0, background: 'transparent', color: COLOR.sub, cursor: 'pointer', display: 'flex', padding: 2 }}>
            <X size={10} />
          </button>
        )}
      </div>
    </div>
  );
}

/** agent 提问直接在画布里答：复用聊天栏的 wizard 卡（同一个 /answer 端点，
 *  谁先答谁生效，另一张随 tool_result 变已答态）*/
function QuestionStageCard({ card, onDismiss }) {
  const status = card.status === 'ok' ? 'success' : card.status === 'fail' ? 'error' : 'running';
  return (
    <div
      data-stage="card" data-stage-kind="question" data-stage-status={card.status}
      style={{
        borderRadius: 12, border: '1.5px solid rgba(176,140,79,0.65)', background: COLOR.bg,
        boxShadow: '0 12px 34px rgba(40,32,16,0.28)', padding: GAP.md,
        maxHeight: '52vh', overflowY: 'auto',
        animation: card.status === 'ok' ? `${POP_IN}, ndStageOut 380ms ease 1150ms forwards` : POP_IN,
      }}
    >
      {Array.isArray(card.input?.questions) && card.input.questions.length > 0 ? (
        <AskUserQuestionView
          toolInput={card.input}
          toolOutput={card.output}
          status={status}
          toolUseId={card.blockId}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
          <span style={{ width: 9, height: 9, border: `1.5px solid ${COLOR.borderLt}`, borderTopColor: COLOR.text, borderRadius: '50%', animation: 'ndSpin 800ms linear infinite' }} />
          agent 正在整理问题…
        </div>
      )}
      {card.status === 'fail' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: GAP.sm }}>
          <button onClick={onDismiss} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            border: `1px solid ${COLOR.borderLt}`, borderRadius: 6,
            background: COLOR.bgCard, color: COLOR.text, cursor: 'pointer',
            padding: `${GAP.xs}px ${GAP.sm + 2}px`, fontFamily: FONT_MONO, fontSize: 10,
          }}><X size={10} /> 关闭</button>
        </div>
      )}
    </div>
  );
}

/** 轻量工具 chip：检索 / 读文件 / 装技能这类不抢戏的动作 */
function StageChip({ card, onDismiss }) {
  const running = card.status === 'running';
  return (
    <span
      data-stage="chip" data-stage-status={card.status}
      onClick={card.status === 'fail' ? onDismiss : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
        borderRadius: 999, background: 'rgba(33,30,23,0.88)', color: '#e8e2d2',
        fontFamily: FONT_MONO, fontSize: 9.5, animation: POP_IN,
        border: `1px solid ${card.status === 'fail' ? '#b0554f' : 'transparent'}`,
        cursor: card.status === 'fail' ? 'pointer' : 'default',
      }}
    >
      {running ? (
        <span style={{ width: 8, height: 8, border: '1.5px solid rgba(232,226,210,0.3)', borderTopColor: '#e8e2d2', borderRadius: '50%', animation: 'ndSpin 800ms linear infinite' }} />
      ) : (
        <span style={{ color: card.status === 'ok' ? '#8fc79a' : '#e09a94' }}>{card.status === 'ok' ? '✓' : '✗'}</span>
      )}
      {toolLabelOf(card.tool)}{card.hint ? ` ${card.hint}` : ''}
    </span>
  );
}

function clampLines(s, n) {
  const lines = String(s).split('\n');
  return lines.length <= n ? s : `${lines.slice(0, n).join('\n')}\n…`;
}
