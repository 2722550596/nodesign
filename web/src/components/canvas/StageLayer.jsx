import { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { PencilLine, Terminal, X, Bot } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_MONO, FONT_SANS, FONT_SIZE, TERM, CANVAS, alpha } from '../../lib/theme.js';
import { stageKindOf, resolveObjectId, zoneOfObjectId, fileNameOf, chipHintOf, toolLabelOf } from '../../lib/stage.js';
import { ZONE, STAGE_CARD_W, POP_IN } from '../../lib/board-geometry.js';
import { sizeOf } from '../../lib/board-kinds.js';
import { AskUserQuestionView } from '../chat/Message.jsx';
import ClaudeMark, { CLAUDE_BRAND } from '../ui/ClaudeMark.jsx';

// （生图占位 2026-08-14 迁出：shimmer 从舞台层搬进纸面层的幻影物件
//   （PhantomLayer.jsx，幻影入座+座位过户）。舞台状态机仍然维护 image 条目
//   —— 它是幻影的数据源，只是不再由舞台渲染。）

/**
 * StageLayer — 舞台层（2026-07-28 重构 3 从 BoardCanvas 抽出）
 *
 * 桌面上的"第二渲染平面"：agent 的实时动作演出（代码直播 / 终端 / 生图
 * shimmer / chip / 已更新角标 / 画布内答题）。与桌面只共享一个事实——
 * "物件在哪"（positioned / 可见性），其余状态全部自治：
 *
 *   useStageState   事件驱动的卡片状态机（stageRef 接线、镜头跟随触发都在这）
 *   splitStageCards 渲染分流：锚得到可见物件 → 板内；锚不到 → dock
 *   StageBoardLayer 板内坐标系那一面（角标 + 贴物件卡），随桌面缩放
 *   StageDock       屏幕坐标系那一面（视口底部居中）
 *
 * 子代理时间轴与这里共享 lib/stage.js 的同一份事件翻译。
 */

// ── 状态机 ──

export function useStageState({
  stageRef, artifactRoots, followToObject,
  onStageTarget, onPreviewRequest,
  /**
   * 原始事件旁路。舞台层独占 `stageRef`，别的消费者（在场层）没有第二个入口 ——
   * 与其再开一条事件通道，不如让它在这儿分一份出去。**先分再处理**：舞台层
   * 自己的 switch 会 `return` 掉不认识的事件，放在后面就漏掉一半。
   */
  onRawEvent,
}) {
  const [stageCards, setStageCards] = useState({});
  const [stageBadges, setStageBadges] = useState({});
  // 铅笔精灵的手写行（2026-08-14 日记本批）：服务端把回复压成短句推过来
  // （run.sprite_summary：首句底稿先到，haiku 精修后到覆盖 ——"显影"）。
  // 曾经这里是 voice（正文流全文尾巴、SpriteVoiceBubble 直播），同日退役：
  // 画布上要的是一行手写旁白，不是聊天记录的镜像。
  const [spriteLine, setSpriteLine] = useState(null);   // { round, text, refined }
  const [recap, setRecap] = useState(null);             // { text, at } —— 收场小结，闲时精灵写它
  const followedBlocksRef = useRef(new Set());   // 每张舞台卡只推一次镜头
  // Task/Agent 工具入参里的 subagent_type（真名）。task_started 的 taskType 可能
  // 是 'local_agent' 泛名，tool_use 快照和 task.started 到达顺序不定 → 两头接
  const pendingAgentTypeRef = useRef(new Map());
  // 用 ref 转一手：直接进 handleStageEvent 的依赖会让 stageRef 每次重挂，
  // 重挂的缝里到达的事件会丢。
  const onRawEventRef = useRef(null);
  onRawEventRef.current = onRawEvent;

  const removeStageCardLater = useCallback((blockId, ms) => {
    setTimeout(() => {
      setStageCards(prev => {
        const c = prev[blockId];
        // 子代理便利贴不自动收束：结果面留给用户看，手动 × 才蒸发
        if (!c || c.kind === 'subagent') return prev;
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
    onRawEventRef.current?.(evt);
    switch (evt.type) {
      case 'run.sprite_summary': {
        // 子代理的话不上精灵 —— 它们有自己的舞台便利贴
        if (evt.parentToolUseId || !evt.text) return;
        setSpriteLine(prev => {
          if (prev && prev.round != null && evt.round != null) {
            if (evt.round < prev.round) return prev;               // 旧回合的迟到精修，不要
            if (evt.round === prev.round && prev.refined && !evt.refined) return prev;
          }
          return { round: evt.round ?? null, text: evt.text, refined: !!evt.refined };
        });
        break;
      }
      case 'run.recap': {
        if (evt.text) setRecap({ text: evt.text, at: Date.now() });
        break;
      }
      case 'run.tool_use.started': {
        const kind = stageKindOf(evt.name);
        if (!kind || !evt.blockId) return;
        setStageCards(prev => (prev[evt.blockId] ? prev : { ...prev, [evt.blockId]: newStageCard(evt, kind) }));
        break;
      }
      case 'run.delta.tool_input': {
        // 真流式：append = Edit.new_string / Write.content 的纯文本增量
        if (!evt.blockId) return;
        const oid = evt.filePath ? resolveObjectId(evt.filePath, artifactRoots) : null;
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
        // 子代理真名：Task/Agent 是 SILENT 工具（下面 kind 为 null 直接 return），
        // 但入参里的 subagent_type 是舞台便利贴标题的最好来源，先截下来
        if ((evt.name === 'Task' || evt.name === 'Agent') && evt.blockId
            && typeof evt.input?.subagent_type === 'string') {
          pendingAgentTypeRef.current.set(evt.blockId, evt.input.subagent_type);
          setStageCards(prev => {
            const c = prev[evt.blockId];
            if (!c || c.kind !== 'subagent') return prev;
            return { ...prev, [evt.blockId]: { ...c, agentType: evt.input.subagent_type } };
          });
          return;
        }
        const kind = stageKindOf(evt.name);
        if (!kind || !evt.blockId) return;
        const input = evt.input || {};
        const oid = typeof input.file_path === 'string' ? resolveObjectId(input.file_path, artifactRoots) : null;
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
        const oid = evt.path ? resolveObjectId(evt.path, artifactRoots) : null;
        if (oid) onPreviewRequest?.(oid);
        break;
      }
      case 'run.delta.tool_result': {
        if (!evt.blockId) return;
        setStageCards(prev => {
          const c = prev[evt.blockId];
          if (!c) return prev;
          // 子代理便利贴的生命周期由 run.task.* / run.subagent.stop 管——Task 工具
          // 自己的 tool_result 不许动它（撞 key：blockId == toolUseId），否则
          // removeStageCardLater 会在完成 1.6s 后把结果面收走
          if (c.kind === 'subagent') return prev;
          const patch = { status: evt.ok ? 'ok' : 'fail', doneAt: Date.now() };
          if (typeof evt.output === 'string' && evt.output) {
            patch.output = evt.output.split('\n').slice(-8).join('\n').slice(-1200);
          }
          if (!evt.ok && typeof evt.error === 'string') patch.error = evt.error.slice(0, 600);
          return { ...prev, [evt.blockId]: { ...c, ...patch } };
        });
        // 失败卡多留一会儿（红卡要被看见）但也自动收束 —— 详细错误在聊天时间轴
        // 里一直都有，画布不该积着一排要手点 × 的尸体（2026-07-29 用户反馈）
        removeStageCardLater(evt.blockId, evt.ok ? 1600 : 10000);
        break;
      }
      case 'run.file_changed': {
        // 物件"已更新"角标（在板上才有意义）
        const oid = resolveObjectId(evt.filePath, artifactRoots);
        if (!oid) return;
        // ⚠️ 这里曾经"agent 正在写 deck → 自动把那张卡展开成内嵌渲染"。
        // 展开态 2026-08-13 退役，而**不该原样映射成"自动开窗"** —— file_changed
        // 是每写一个文件就来一发，那会变成 agent 每存一次盘就把一扇模态窗拍在
        // 用户脸上。方卡自带实时缩略图，"工作过程当场可见"它自己就做到了；
        // 视图跟到那个文件夹由 onStageTarget 那条负责，不必在这儿再来一次。
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
      // ── 子代理舞台便利贴（2026-07-30）──
      // key = toolUseId（与 blockId 同命名空间：它就是主 agent 那次 Task 调用的
      // tool_use_id）。运行中显示 30s 摘要，完成后翻成结果内容；不自动收束。
      case 'run.task.started': {
        if (!evt.toolUseId) return;
        setStageCards(prev => ({
          ...prev,
          [evt.toolUseId]: {
            blockId: evt.toolUseId, kind: 'subagent', status: 'running',
            agentType: pendingAgentTypeRef.current.get(evt.toolUseId) || evt.taskType || 'agent',
            description: evt.description || '',
            summary: null, result: null, startedAt: Date.now(),
          },
        }));
        break;
      }
      case 'run.task.progress': {
        if (!evt.toolUseId) return;
        setStageCards(prev => {
          const c = prev[evt.toolUseId];
          if (!c || c.kind !== 'subagent') return prev;
          return { ...prev, [evt.toolUseId]: { ...c, summary: evt.summary || c.summary } };
        });
        break;
      }
      case 'run.task.notification': {
        if (!evt.toolUseId) return;
        setStageCards(prev => {
          const c = prev[evt.toolUseId];
          if (!c || c.kind !== 'subagent') return prev;
          return {
            ...prev,
            [evt.toolUseId]: {
              ...c,
              status: evt.status === 'completed' ? 'ok' : 'fail',
              summary: evt.summary || c.summary,
              doneAt: Date.now(),
            },
          };
        });
        break;
      }
      case 'run.subagent.stop': {
        // 结果面数据源：所有子代理都有 lastAssistantMessage（SubagentStop hook）
        if (!evt.toolUseId) return;
        setStageCards(prev => {
          const c = prev[evt.toolUseId];
          if (!c || c.kind !== 'subagent') return prev;
          return {
            ...prev,
            [evt.toolUseId]: {
              ...c,
              result: evt.lastAssistantMessage || c.result,
              // SubagentStop hook 带真名（explorer / vision-checker…），补正泛名
              agentType: evt.agentType || c.agentType,
            },
          };
        });
        break;
      }
      case 'run.done':
      case 'run.error':
      case 'run.cancelled': {
        // 收场：残留 running/ok 卡淡出；失败卡留到自己的 10s 定时器收束；
        // 子代理便利贴不清（结果面留给用户，手动 × 蒸发）
        setTimeout(() => {
          setStageCards(prev => {
            const next = {};
            for (const [k, c] of Object.entries(prev)) {
              if (c.status === 'fail' || c.kind === 'subagent') next[k] = c;
            }
            return next;
          });
        }, 900);
        followedBlocksRef.current.clear();
        pendingAgentTypeRef.current.clear();
        // 手写行收场：工作精灵随 run 一起下场，行也一起清（闲时轮到 recap 上）
        setTimeout(() => setSpriteLine(null), 900);
        break;
      }
      default: break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactRoots, followToObject, removeStageCardLater, onStageTarget, onPreviewRequest]);

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

  return { stageCards, stageBadges, spriteLine, recap, dismissStageCard };
}

// （2026-08-14 当日拆除：SpriteVoiceBubble —— 正文流直播泡只活了半天，被
//   铅笔精灵的手写短句取代（SpriteSketchLayer.jsx）。拆干净不留空壳。）

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
/**
 * 落点兜底（2026-07-28；2026-08-14 生图占位迁出后简化）：
 *   ① 目标物件已经在墙上且可见 → 贴着它摆
 *   ② 物件还没上墙（新文件正在写，产物列表要等这次写完才知道它存在）
 *      → 贴到它天然归属的那块工作区里（zone id 由路径派生）
 *   ③ 连工作区都定位不到（路径认不出 / 那块区被收纳了）→ 落 dock
 *
 * image 卡不再走这里 —— 它是纸面层的幻影物件（PhantomLayer.jsx），
 * 占位在哪成品就落哪，跟舞台浮层无关。
 *
 * ⚠️ 曾经还有第三级兜底"回落到当前会话区"。会话不再产生画布物件
 * （2026-08-08）之后那一级只会指向一个不存在的 id，2026-08-13 拆掉：
 * 认不出来就老实掉 dock，别猜。
 */
export function splitStageCards({ stageCards, positioned, visibleIdSet, visibleZones, focusZone }) {
  const anchoredCards = [];
  const dockPanels = [];
  const dockChips = [];
  const visibleZoneOf = (zid) => (zid ? visibleZones.find(v => !v.collapsed && v.id === zid) : null);
  // 同一块区里并发的同类卡各占一个坑位，不要叠在同一个点上
  const slots = new Map();
  const takeSlot = (zid, kind) => {
    const k = `${zid}|${kind}`;
    const n = slots.get(k) || 0;
    slots.set(k, n + 1);
    return n;
  };
  for (const c of Object.values(stageCards)) {
    if (c.kind === 'image') continue;   // 幻影层接管（PhantomLayer.jsx）
    if (c.kind === 'chip') { dockChips.push(c); continue; }
    if (c.kind === 'question') { dockPanels.push(c); continue; }
    const o = c.objectId ? positioned.find(it => it.id === c.objectId) : null;
    if (o && visibleIdSet.has(o.id)) { anchoredCards.push({ card: c, obj: o }); continue; }
    const zid = zoneOfObjectId(c.objectId) || focusZone;
    const zr = visibleZoneOf(zid);
    if (!zr) { dockPanels.push(c); continue; }
    anchoredCards.push({ card: c, zoneRect: zr, slot: takeSlot(zr.id, c.kind) });
  }
  return { anchoredCards, dockPanels, dockChips };
}

// ── 板内坐标系那一面（角标 + 贴物件卡）──

export function StageBoardLayer({ stageBadges, anchoredCards, positioned, visibleIdSet, boardSize, scale = 1, onDismiss }) {
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
            background: CANVAS.brass, color: COLOR.bgWhite, borderRadius: RADIUS.md,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, padding: `${GAP.xxs}px ${GAP.sm}px`,
          }}>已更新</div>
        );
      })}
      {anchoredCards.map(({ card, obj, zoneRect, slot }) => (
        <StageCard
          key={card.blockId}
          card={card}
          obj={obj}
          zoneRect={zoneRect}
          slot={slot}
          boardSize={boardSize}
          scale={scale}
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
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: GAP.sm,
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
        <div style={{ display: 'flex', gap: GAP.sm, flexWrap: 'wrap', justifyContent: 'center', pointerEvents: 'auto' }}>
          {dockChips.map((card) => (
            <StageChip key={card.blockId} card={card} onDismiss={() => onDismiss(card.blockId)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 卡片组件 ──

/** 舞台卡（板内坐标系定位）：贴目标物件摆（右侧优先，放不下换左/下） */
function StageCard({ card, obj, zoneRect, slot = 0, boardSize, scale = 1, onDismiss }) {
  // 物件还没上墙：贴在工作区右上（标题栏下面），跟着这块区一起动。
  // 同区并发多张时逐张往左下错开，免得后来的把前面那张完全盖住。
  if (!obj && zoneRect) {
    const step = Math.min(slot, 3) * 18;
    const x = Math.max(12, Math.min(boardSize.w - STAGE_CARD_W - 12,
      zoneRect.x + zoneRect.w - STAGE_CARD_W - ZONE.pad - step));
    const y = zoneRect.y + ZONE.header + ZONE.pad + step;
    return (
      <div style={{ position: 'absolute', left: x, top: y, width: STAGE_CARD_W, zIndex: 60 + slot, pointerEvents: 'auto' }}>
        <StageCardBody card={card} scale={scale} onDismiss={onDismiss} />
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
      <StageCardBody card={card} scale={scale} onDismiss={onDismiss} />
    </div>
  );
}

/**
 * 舞台卡内容体（代码直播 / 终端）—— 板内锚定与 dock 共用。
 *
 * 2026-08-14 起它是**精灵的输出框**：头上一枚 Claude 星芒 + 跑动时描
 * 品牌橙边 —— 跟精灵徽记、语音泡同一个身份。墨面正文不动：机器写的
 * 东西保持等宽墨底，这条是设计语言的底线，换身份不换物料。
 */
function StageCardBody({ card, scale = 1, onDismiss }) {
  if (card.kind === 'subagent') return <SubagentStickyCard card={card} onDismiss={onDismiss} scale={scale} />;
  const running = card.status === 'running';
  const isTerm = card.kind === 'terminal';
  const border = card.status === 'fail' ? '#b0554f' : card.status === 'ok' ? '#4f8f5b' : alpha(CLAUDE_BRAND, 0.7);
  const label = card.tool === 'Edit' ? '修改' : card.tool === 'Write' ? '写入' : toolLabelOf(card.tool);
  return (
    <div
      data-stage="card" data-stage-kind={card.kind} data-stage-status={card.status}
      style={{
        borderRadius: RADIUS.xxl, overflow: 'hidden', border: `1.5px solid ${border}`,
        background: TERM.bg, boxShadow: '0 10px 30px rgba(40,32,16,0.35)',
        animation: card.status === 'ok'
          ? `${POP_IN}, ndPulse 700ms ease-out, ndStageOut 380ms ease 1150ms forwards`
          : POP_IN,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, padding: `${GAP.sm}px ${GAP.base}px`, background: 'rgba(255,255,255,0.06)' }}>
        <ClaudeMark size={12} />
        {isTerm ? <Terminal size={10} color="#c8b98c" /> : <PencilLine size={10} color="#c8b98c" />}
        <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: TERM.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {isTerm ? (card.command || 'bash') : `${label} · ${fileNameOf(card.filePath) || '…'}`}
        </span>
        {running ? (
          <span style={{ width: 10, height: 10, border: '1.5px solid rgba(232,226,210,0.35)', borderTopColor: TERM.ink, borderRadius: RADIUS.round, animation: 'ndSpin 800ms linear infinite', flexShrink: 0 }} />
        ) : (
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: card.status === 'ok' ? TERM.ok : TERM.err, flexShrink: 0 }}>
            {card.status === 'ok' ? '✓' : '✗'}
          </span>
        )}
        {card.status === 'fail' && (
          <button onClick={onDismiss} style={{ border: 0, background: 'transparent', color: TERM.ink, cursor: 'pointer', display: 'flex', padding: GAP.xxs }}>
            <X size={10} />
          </button>
        )}
      </div>
      {card.kind === 'code' && card.oldString && (
        <div style={{
          padding: `${GAP.xs}px ${GAP.base}px`, background: 'rgba(176,85,79,0.16)', color: '#dba49f',
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
        <div style={{ padding: `5px ${GAP.base}px`, fontFamily: FONT_MONO, fontSize: 9.5, color: TERM.err, whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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
    <div ref={ref} style={{ maxHeight: 280, overflowY: 'auto', padding: `${GAP.md}px ${GAP.base}px` }}>
      <pre style={{ margin: 0, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, lineHeight: 1.55, color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {text || placeholder}
        {running && (
          <span style={{ display: 'inline-block', width: 6, height: 11, marginLeft: GAP.xxs, verticalAlign: '-2px', background: TERM.ink, animation: 'ndCaret 900ms step-end infinite' }} />
        )}
      </pre>
    </div>
  );
}

/**
 * 舞台卡的位移拖拽（2026-07-31）：transform 偏移，不进任何持久层 —— 舞台卡
 * 是转瞬态，拖只是"别挡着我看"。scale = 桌面缩放（板内坐标系里 pointer 的
 * 屏幕像素要除掉它才是板内位移；dock 在屏幕坐标系，scale=1）。
 * 只从带 data-stage-drag 的把手（标题栏）起拖，正文可以照常滚动选字。
 */
function useCardDrag(scale = 1) {
  const [off, setOff] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const offRef = useRef(off);
  offRef.current = off;
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (!e.target.closest('[data-stage-drag]')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: offRef.current.x, oy: offRef.current.y };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const s = scale || 1;
    setOff({ x: d.ox + (e.clientX - d.sx) / s, y: d.oy + (e.clientY - d.sy) / s });
  };
  const onPointerUp = () => { dragRef.current = null; };
  return { off, handlers: { onPointerDown, onPointerMove, onPointerUp } };
}

/**
 * 子代理舞台便利贴：运行中 = 当前 30s 摘要直播；完成 = 翻成结果内容
 * （lastAssistantMessage，markdown）。不自动蒸发 —— 结果要留给用户读，
 * × 手动关。持久层由服务端 task-notes.js 负责（每个 Task 落
 * tasks/<任务>/notes/子任务.md 一面，桌面上是可拖真便签）；这张舞台贴
 * 抓标题栏也能拖（transform 位移，不落盘）。
 */
function SubagentStickyCard({ card, onDismiss, scale = 1 }) {
  const running = card.status === 'running';
  const { off, handlers } = useCardDrag(scale);
  return (
    <div
      data-stage="card" data-stage-kind="subagent" data-stage-status={card.status}
      {...handlers}
      style={{
        borderRadius: RADIUS.xl, overflow: 'hidden',
        border: `1.5px solid ${card.status === 'fail' ? '#b0554f' : alpha(CANVAS.brass, 0.55)}`,
        background: CANVAS.note, boxShadow: '0 8px 24px rgba(60,48,20,0.22)',
        animation: POP_IN,
        transform: (off.x || off.y) ? `translate(${off.x}px, ${off.y}px)` : undefined,
        touchAction: 'none',
      }}
    >
      <div data-stage-drag style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, padding: `${GAP.sm}px ${GAP.base}px`, borderBottom: `1px solid ${alpha(CANVAS.brass, 0.22)}`, cursor: 'grab', userSelect: 'none' }}>
        <Bot size={11} color="#8a744d" />
        <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: '#6d5c3d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {card.agentType}{card.description ? ` · ${card.description}` : ''}
        </span>
        {running ? (
          <span style={{ width: 10, height: 10, border: '1.5px solid rgba(138,116,77,0.35)', borderTopColor: '#8a744d', borderRadius: RADIUS.round, animation: 'ndSpin 800ms linear infinite', flexShrink: 0 }} />
        ) : (
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: card.status === 'ok' ? '#4f8f5b' : '#b0554f', flexShrink: 0 }}>
            {card.status === 'ok' ? '✓' : '✗'}
          </span>
        )}
        <button onClick={onDismiss} title="关闭"
          style={{ border: 0, background: 'transparent', color: '#8a744d', cursor: 'pointer', display: 'flex', padding: GAP.xxs }}>
          <X size={10} />
        </button>
      </div>
      <div style={{ padding: `${GAP.md}px ${GAP.lg}px`, maxHeight: 280, overflowY: 'auto' }}>
        {running ? (
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontStyle: 'italic', color: '#6d5c3d', lineHeight: 1.6 }}>
            {card.summary || '子代理工作中…'}
          </span>
        ) : card.result ? (
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: '#4a3f2c', lineHeight: 1.65 }}>
            <ReactMarkdown>{card.result}</ReactMarkdown>
          </div>
        ) : (
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: '#6d5c3d' }}>
            {card.summary || (card.status === 'ok' ? '已完成' : '失败了，细节看聊天侧栏')}
          </span>
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
        borderRadius: RADIUS.xxl, border: `1.5px solid ${alpha(CANVAS.brass, 0.65)}`, background: COLOR.bg,
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
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
          <span style={{ width: 9, height: 9, border: `1.5px solid ${COLOR.borderLt}`, borderTopColor: COLOR.text, borderRadius: RADIUS.round, animation: 'ndSpin 800ms linear infinite' }} />
          agent 正在整理问题…
        </div>
      )}
      {card.status === 'fail' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: GAP.sm }}>
          <button onClick={onDismiss} style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.md,
            background: COLOR.bgCard, color: COLOR.text, cursor: 'pointer',
            padding: `${GAP.xs}px ${GAP.sm + 2}px`, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
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
        borderRadius: RADIUS.pill, background: 'rgba(33,30,23,0.88)', color: TERM.ink,
        fontFamily: FONT_MONO, fontSize: 9.5, animation: POP_IN,
        border: `1px solid ${card.status === 'fail' ? '#b0554f' : 'transparent'}`,
        cursor: card.status === 'fail' ? 'pointer' : 'default',
      }}
    >
      {running ? (
        <span style={{ width: 8, height: 8, border: '1.5px solid rgba(232,226,210,0.3)', borderTopColor: TERM.ink, borderRadius: RADIUS.round, animation: 'ndSpin 800ms linear infinite' }} />
      ) : (
        <span style={{ color: card.status === 'ok' ? TERM.ok : TERM.err }}>{card.status === 'ok' ? '✓' : '✗'}</span>
      )}
      {toolLabelOf(card.tool)}{card.hint ? ` ${card.hint}` : ''}
    </span>
  );
}

function clampLines(s, n) {
  const lines = String(s).split('\n');
  return lines.length <= n ? s : `${lines.slice(0, n).join('\n')}\n…`;
}
