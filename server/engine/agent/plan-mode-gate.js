/**
 * Plan mode 的工具闸（2026-08-17 从 session-loop.js 拆出 —— 行数棘轮）。
 *
 * 这里是一份**纯策略**：哪些工具在 plan mode 下不许用、哪些 Bash 命令算只读。
 * 它跟会话循环没有任何耦合（不碰 SDK、不碰事件、不碰 run），留在那个文件里只是
 * 让人每次读 runSession 都先翻过一百多行白名单。
 *
 * 消费方只有一个：session-loop 的 canUseTool 钩子。
 */

/**
 * Plan-mode 硬 deny 列表（canUseTool 钩子拦）。Allowlist 反过来推：
 *   ✅ allow: Read / Grep / Glob / WebFetch / Task / AskUserQuestion / TodoWrite
 *            / mcp__nodesign__web_search / mcp__nodesign__generate_image
 *            （+ ExitPlanMode 是 SDK 内置 plan-mode 提交工具，必允许）
 *   🔶 conditional: Bash —— 见 isReadonlyBashCommand：只读探索类命令放开
 *      （ls / find / cat / grep / wc / diff / jq + git 只读子命令），
 *      拒绝写命令 + 重定向 + 后台。SDK Glob 默认不跟 symlink 让 plan 探不到
 *      assets/ 这类内容，必须给 agent 兜底用 ls / find 实地确认。
 *   ❌ deny: 动主产物 + 决策档案 + 打包 + 改 canvas 状态的工具
 *
 * 设计意图：plan mode 是 brainstorm + 探索阶段，**generate_image 故意放开**让
 * agent 在 brainstorm 时能给用户出小样视觉对齐（详见 SKILL.md § Plan mode），
 * 但 SKILL.md prompt 软约束规定"方向对齐了再生图"，避免一上来就画的浪费。
 */
export const PLAN_MODE_DENY = new Set([
  // 写入主产物（canvas.html 等）—— MultiEdit 是 Code CLI 工具不在 SDK 里，
  // DEFAULT_TOOL_ALLOWLIST 也不含；这里 deny 只是冗余防御，删了
  'Write', 'Edit',
  // NoDesign MCP 工具：动 canvas 渲染状态 / 决策档案 / 成品打包
  'mcp__nodesign__screenshot_canvas',
  'mcp__nodesign__expose_tweaks',
  'mcp__nodesign__record_decision',
  'mcp__nodesign__export_handoff',
  'mcp__nodesign__navigate_to_page',
  'mcp__nodesign__highlight',
  'mcp__nodesign__clear_pending_changes',
]);

/**
 * Plan-mode Bash 只读命令白名单（首 token）。命令链 (`;` `|` `&&` `||`)
 * 的每段都要过这个白名单。sed / git 走二级子检查（sed 拒绝 -i，git 限
 * READONLY_GIT_SUBS）。
 */
const READONLY_BASH_FIRSTS = new Set([
  // 列目录 / 文件元信息
  'ls', 'll', 'la', 'dir', 'find', 'tree', 'stat', 'file', 'du', 'df', 'pwd',
  'realpath', 'readlink', 'basename', 'dirname', 'which', 'whereis',
  // 系统只读
  'whoami', 'id', 'date', 'uptime', 'uname', 'hostname',
  // 读文件
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'wc', 'tac', 'rev',
  'xxd', 'od', 'hexdump', 'strings',
  // 文本处理
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'cut', 'tr', 'sort', 'uniq',
  'column', 'comm', 'paste', 'join', 'expand', 'unexpand', 'fold', 'fmt',
  // 比较 / 哈希
  'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'shasum',
  // 结构化文本
  'jq', 'yq', 'xq',
  // 简单输出
  'env', 'printenv', 'echo', 'printf', 'true', 'false', 'test', '[',
  // 二级子检查
  'sed', 'git',
]);

const READONLY_GIT_SUBS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'ls-tree',
  'remote', 'tag', 'describe', 'blame', 'grep', 'help', 'version', 'config',
  'reflog', 'cat-file', 'symbolic-ref', 'for-each-ref', 'rev-list', 'shortlog',
  'name-rev', 'count-objects', 'fsck',
]);

/**
 * Plan-mode 下检查 Bash command 是否纯只读。串联段（;/|/&&/||）每段第一 token
 * 必须在 READONLY_BASH_FIRSTS；sed 不能带 -i；git 子命令必须在 READONLY_GIT_SUBS；
 * 任何输出重定向 (>/>>) 或后台 (&) 直接拒。
 *
 * 设计 best-effort 不是 bullet-proof：模型已被 prelude 软约束"plan 期间别动状态"，
 * 这里硬 gate 拦掉常见误操作就够，sandbox 里跑也无法越界。
 */
export function isReadonlyBashCommand(rawCmd) {
  if (typeof rawCmd !== 'string' || !rawCmd.trim()) {
    return { ok: false, reason: '空命令' };
  }
  // mask 引号串里的内容防 split 时被分错段
  const placeholders = [];
  let masked = rawCmd.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => {
    placeholders.push(m);
    return `__Q${placeholders.length - 1}__`;
  });
  if (/\s&\s*$/.test(masked)) {
    return { ok: false, reason: '后台 (&) 不允许' };
  }
  const segments = masked.split(/\s*(?:;|\|\||&&|\|)\s*/);
  for (let seg of segments) {
    seg = seg.trim();
    if (!seg) continue;
    seg = seg.replace(/__Q(\d+)__/g, (_, i) => placeholders[Number(i)]);
    // 输出重定向 > / >>（2>&1 / 2>&3 这种 fd 复制不算，用 lookahead 排除 &）
    if (/(?:^|[^&\d])>>?(?!&)/.test(seg)) {
      return { ok: false, reason: '不允许输出重定向 (>/>>)，会写文件' };
    }
    const tokens = seg.split(/\s+/).filter(Boolean);
    let first = '';
    for (const t of tokens) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;  // env 赋值前缀，跳过
      first = t;
      break;
    }
    if (!first) return { ok: false, reason: '无法解析命令' };
    first = first.split('/').pop();  // /usr/bin/ls → ls
    if (!READONLY_BASH_FIRSTS.has(first)) {
      return { ok: false, reason: `命令 \`${first}\` 不在只读白名单` };
    }
    if (first === 'sed' && /(?:^|\s)-[a-zA-Z]*i/.test(seg)) {
      return { ok: false, reason: '`sed -i` 会原地改文件' };
    }
    if (first === 'git') {
      const argsAfter = tokens.slice(tokens.indexOf(first) + 1);
      let sub = '';
      for (let i = 0; i < argsAfter.length; i++) {
        const a = argsAfter[i];
        if (a.startsWith('-')) {
          if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(a)) i++;
          continue;
        }
        sub = a; break;
      }
      if (!sub || !READONLY_GIT_SUBS.has(sub)) {
        return { ok: false, reason: `\`git ${sub || '?'}\` 不在只读 git 子命令白名单` };
      }
    }
  }
  return { ok: true };
}
