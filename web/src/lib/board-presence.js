/**
 * 在场（presence）—— 把 agent 和每个子代理当成画布上的另一个「人」。
 *
 * ## 思路
 *
 * 取自 tldraw 的 `TLInstancePresence`（多人协作里每个协作者一条记录：光标、
 * 选中了什么、镜头在哪、叫什么名字、什么颜色、正在跟着谁）。**抄的是这个
 * 数据模型，不是它的代码。**
 *
 * 为什么对我们成立：Nodesign 的 agent 本来就是"另一个在这块板上干活的人"。
 * 它有位置（正在动哪个文件）、有选中（当前目标）、有话说（正在做什么）。
 * 以前这些信息只以**瞬时**形式存在 —— 舞台卡飘一下、跑完就收（StageLayer）——
 * 于是「谁在哪干活」这件事从来没有被持续地表达过。
 *
 * ## 它解决的具体问题
 *
 * 1. 多个子代理并行时，用户只能在聊天侧栏的 tab 里翻，看不见"三个在同时动"。
 * 2. 「跟随」以前是跟着**事件**跑（哪个文件被写就飞过去），镜头会在几个子代理
 *    之间来回横跳。有了 presence 就能跟**某一个人**，稳定得多。
 *
 * ## 这里只做纯逻辑
 *
 * 从既有事件流（run.task.started / run.subagent.* / file_changed / run.done）
 * 归约出一张在场表。不新增任何服务端事件 —— 信号本来就都有，缺的是把它们
 * 攒成"人"而不是"一串卡片"。
 */

/**
 * 在场者的颜色。用**暖色系里能互相分开**的几支，不用彩虹色 ——
 * 画布是纸面，饱和度高的光标会像贴纸一样浮在上面，很吵。
 */
export const PRESENCE_COLORS = [
  '#B08C4F',   // 暖棕（主 agent，跟"正在动"的光圈同色）
  '#7C8F6B',   // 苔绿
  '#8A6E9E',   // 灰紫
  '#A8362B',   // 朱
  '#5A7A9A',   // 石青
  '#9E7B5A',   // 陶
];

/** 主 agent 固定第一色，子代理按出场顺序取后面的 */
export function colorFor(index) {
  return PRESENCE_COLORS[index % PRESENCE_COLORS.length];
}

export const MAIN_AGENT_ID = 'agent:main';

/**
 * 空表。形状固定，调用方不用到处判空。
 * `[id]: { id, name, kind, color, targetId, zoneId, message, active, at }`
 */
export function emptyPresence() {
  return {};
}

/**
 * 把一条事件归约进在场表（纯函数，不改入参）。
 *
 * 只认这些信号，别的一律原样返回：
 * - `run.start`            主 agent 上场
 * - `run.task.started`     一个子代理上场（带 subagent_type 当名字）
 * - `run.task.notification`/`run.subagent.stop` 子代理下场
 * - `run.file_changed`     谁在动哪个文件 → 更新它的位置
 * - `run.tool_use`         正在做什么 → 更新它那句话
 * - `run.done` / `run.error` 全体下场
 *
 * @param {object} table 当前在场表
 * @param {object} evt   事件
 * @param {(fileOrId:string)=>{objectId:string, zoneId:string}|null} resolve
 *        把文件路径解析成画布物件（调用方给，因为寻址规则住在 stage.js）
 */
export function reducePresence(table, evt, resolve) {
  if (!evt?.type) return table;
  const t = evt.type;
  const parent = evt.parentToolUseId || null;

  // 谁发的这条事件：带 parentToolUseId 的是子代理，否则是主 agent
  const who = parent ? `agent:${parent}` : MAIN_AGENT_ID;

  switch (t) {
    case 'run.start': {
      if (table[MAIN_AGENT_ID]?.active) return table;
      return {
        ...table,
        [MAIN_AGENT_ID]: {
          id: MAIN_AGENT_ID, kind: 'main', name: '助手',
          color: colorFor(0), active: true,
          targetId: null, zoneId: null, message: null, at: evt.at || null,
        },
      };
    }

    case 'run.task.started': {
      const id = `agent:${evt.toolUseId || evt.blockId || evt.taskId}`;
      if (!id || id === 'agent:undefined') return table;
      const n = Object.keys(table).filter(k => k !== MAIN_AGENT_ID).length;
      return {
        ...table,
        [id]: {
          id, kind: 'sub',
          name: evt.agentType || evt.taskType || '子代理',
          color: colorFor(n + 1), active: true,
          targetId: null, zoneId: null,
          message: evt.summary || null, at: evt.at || null,
        },
      };
    }

    case 'run.task.notification':
    case 'run.subagent.stop': {
      const id = `agent:${evt.toolUseId || evt.blockId || evt.taskId}`;
      if (!table[id]) return table;
      // 下场不是删除：留一小会儿让用户看清"它刚在这儿做完了"
      return { ...table, [id]: { ...table[id], active: false, message: null } };
    }

    case 'run.file_changed': {
      const cur = table[who];
      if (!cur) return table;
      const hit = resolve?.(evt.path || evt.file);
      if (!hit) return table;
      if (cur.targetId === hit.objectId && cur.zoneId === hit.zoneId) return table;
      return { ...table, [who]: { ...cur, targetId: hit.objectId, zoneId: hit.zoneId, at: evt.at || cur.at } };
    }

    case 'run.tool_use': {
      const cur = table[who];
      if (!cur) return table;
      const msg = evt.summary || evt.name || null;
      if (cur.message === msg) return table;
      return { ...table, [who]: { ...cur, message: msg } };
    }

    case 'run.done':
    case 'run.error': {
      // 整轮结束：全体下场（子代理的 stop 事件不保证都到齐）
      let touched = false;
      const next = {};
      for (const [id, p] of Object.entries(table)) {
        if (p.active) { touched = true; next[id] = { ...p, active: false, message: null }; }
        else next[id] = p;
      }
      return touched ? next : table;
    }

    default:
      return table;
  }
}

/** 当前真正在场的那些（渲染和跟随都只看这个） */
export function activePresences(table) {
  return Object.values(table || {}).filter(p => p.active);
}

/**
 * 镜头该跟谁。
 *
 * 规则：**主 agent 优先**，它不在场才跟第一个有目标的子代理。
 * 不做"跟最近动的那个" —— 那正是以前镜头在子代理之间横跳的原因。
 */
export function followTarget(table) {
  const act = activePresences(table).filter(p => p.targetId);
  if (!act.length) return null;
  return act.find(p => p.kind === 'main') || act[0];
}
