/**
 * stage.js — 舞台投影层的事件翻译（纯函数，无 React 依赖）
 *
 * 工作台画布 = agent 实时动作的展示区。这里把被动监听到的 run.* 事件翻译成
 * 舞台语义（哪个工具、什么形态、锚到哪个画布物件），BoardCanvas 的舞台层消费；
 * 将来的子代理时间轴走同一份翻译 —— 一个事件流，两个投影。
 */

// 工具 → 舞台呈现形态
//   code     代码直播卡（Edit diff / Write 全文，真流式打字）
//   terminal 终端卡（命令 + 输出尾巴，dock 展示）
//   image    生图 shimmer 占位（真图由 board.updated / 产物重拉带进来）
//   chip     不抢戏的状态胶囊（检索 / 读文件 / 装技能这类）
const TOOL_STAGE_KIND = {
  Edit: 'code',
  Write: 'code',
  Bash: 'terminal',
  mcp__nodesign__generate_image: 'image',
  AskUserQuestion: 'question',   // 交互卡直接上画布（dock），聊天栏那张照旧
};

// 不上舞台的工具：聊天栏已有完整交互卡，舞台重复出现只会抢镜头
const SILENT_TOOLS = new Set(['TodoWrite', 'ExitPlanMode', 'EnterPlanMode']);

export function stageKindOf(toolName) {
  if (!toolName || typeof toolName !== 'string') return null;
  if (TOOL_STAGE_KIND[toolName]) return TOOL_STAGE_KIND[toolName];
  if (SILENT_TOOLS.has(toolName)) return null;
  return 'chip';
}

// deck 主文件候选 —— 与 server agent-shared.js ARTIFACT_CANDIDATES 保持一致
const DECK_FILES = new Set(['canvas.html', 'deck.html', 'index.html', 'output.html']);

/**
 * agent 的 file_path（绝对或相对 cwd）→ 画布物件 id。
 * 归一化规则与 server/engine/mcp/tools/pin-to-board.js 一致：
 *   agent-memory/memory.md → doc:_root；agent-memory/brand/memory.md → doc:brand
 *   …/assets/(generated|notes|…)/x → 'assets/…'；deck 主文件 → deck:<当前会话>
 * 认不出的返回 null（舞台卡落 dock，不锚物件）。
 */
export function resolveObjectId(filePath, currentSessionId) {
  if (!filePath || typeof filePath !== 'string') return null;
  const p = filePath.replace(/\\/g, '/');
  if (p.endsWith('agent-memory/brand/memory.md')) return 'doc:brand';
  if (p.endsWith('agent-memory/memory.md')) return 'doc:_root';
  // 任务模型：tasks/<任务>/canvas.html = 任务 deck；其余任务文件用完整相对路径当 id
  const mt = p.match(/(?:^|\/)tasks\/([^/]+)\/(.+)$/);
  if (mt) {
    if (mt[2] === 'canvas.html') return `deck:task/${mt[1]}`;
    // 任务下的其他 .html = 试作 deck（同样是 deck 物件，不是普通文件卡）
    if (/\.html$/i.test(mt[2]) && !mt[2].includes('/')) return `deck:task/${mt[1]}/${mt[2]}`;
    return `tasks/${mt[1]}/${mt[2]}`;
  }
  if (DECK_FILES.has(fileNameOf(p)) && currentSessionId) return `deck:${currentSessionId}`;
  const m = p.match(/(?:^|\/)assets\/(.+)$/);
  if (m) return `assets/${m[1]}`;
  return null;
}

/**
 * 物件 id → 它天然属于哪块工作区（与 BoardCanvas 的 naturalZoneOf 同一套规则）。
 *
 * 舞台卡的落点用它兜底：物件还没上墙（新文件正在写，产物列表下一次重拉才知道
 * 它存在）时，卡至少能贴到正确的工作区，而不是掉进屏幕底部的 dock。
 */
export function zoneOfObjectId(objectId, currentSessionId) {
  if (!objectId || typeof objectId !== 'string') return null;
  if (objectId.startsWith('deck:task/')) {
    // deck:task/<任务> 或 deck:task/<任务>/<试作文件>
    const rest = objectId.slice(10);
    return `task/${rest.split('/')[0]}`;
  }
  if (objectId.startsWith('deck:')) return objectId.slice(5);
  if (objectId.startsWith('doc:')) return null;
  if (objectId.startsWith('tasks/')) {
    const parts = objectId.split('/');
    return parts.length >= 3 ? `task/${parts[1]}` : null;
  }
  return currentSessionId || null;
}

export function fileNameOf(filePath) {
  if (!filePath) return '';
  const p = String(filePath).replace(/\\/g, '/');
  return p.slice(p.lastIndexOf('/') + 1);
}

/** chip 上跟在工具名后面的一小截提示（文件名 / 技能名 / 检索词…） */
export function chipHintOf(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const take = (v) => (typeof v === 'string' && v ? v : null);
  const hint =
    take(input.file_path && fileNameOf(input.file_path)) ||
    take(input.skill) ||
    take(input.query) ||
    take(input.pattern) ||
    take(input.url) ||
    take(input.path) ||
    take(input.object_path) ||
    '';
  return hint.length > 40 ? `${hint.slice(0, 38)}…` : hint;
}

/** 工具名的展示标签（mcp__nodesign__pin_to_board → pin_to_board） */
export function toolLabelOf(toolName) {
  if (!toolName) return '';
  return toolName.startsWith('mcp__') ? toolName.split('__').slice(2).join('__') : toolName;
}
