/**
 * mcp/param-sanitizer.js — 工具参数标签泄漏消毒（2026-08-19）
 *
 * 病根（jsonl 实锤，会话 008fe16c，claude-opus-5[1m]，订阅直连非中转站）：
 * 模型把工具调用的闭合标签写错（用参数名当标签），上游解析器抢救时把下一个
 * 参数整个吞进上一个字符串参数 —— tool_use.input 落地已经是：
 *
 *   rationale: "…正文</rationale>\n<parameter name=\"scope\">庄家（对手）"
 *   scope: （缺失）
 *
 * 同会话 record_decision 4/4 全中，泄漏进了用户画布上的决策便利贴。上游改
 * 不了，在自己边界拆回来。record_decision 只是被看见的那个 —— 同样的泄漏
 * 落在别的工具的长文本参数上会静默进产物，所以消毒挂在工具管线出口
 * （buildNodesignTools 的 withParamSanitizer 包所有工具），不是只修一个工具。
 *
 * 判据收得窄，几乎不可能误伤正文里合法讨论 XML 的内容，三个条件全中才动手：
 *   1. 字符串值里出现 `</{本参数名}>` 且其后紧跟 `<parameter name="X">`
 *   2. X 是这个工具 schema 里真实存在的参数
 *   3. X 在这次调用里缺失，且 schema 声明它是字符串型
 * 拆完 recordIssue 记自动层一笔 —— 发生率必须可见，静默修复=永远不知道
 * 上游好没好。消毒本身 fail-soft：它绝不能变成新的故障源。
 */

import { recordIssue, signatureOf } from '../../lib/issues-store.js';

/** zod v4：拆掉 optional/nullable/default 的壳看里面是不是 string */
function unwrapsToString(zodType) {
  let t = zodType;
  for (let i = 0; i < 6 && t; i += 1) {
    const def = t._zod?.def;
    if (!def) return false;
    if (def.type === 'string') return true;
    if (def.type === 'optional' || def.type === 'nullable' || def.type === 'default') {
      t = def.innerType;
      continue;
    }
    return false;
  }
  return false;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 单个字符串值的泄漏拆解。返回 null（没泄漏）或
 * { clean, recovered: { 参数名: 值 } }。
 *
 * 链式泄漏也拆：value 可能连吞多个参数（A</A><parameter name="B">b</B>
 * <parameter name="C">c…），逐段切；段尾多出的 `</当前参数名>` 一并剥掉。
 */
export function splitLeakedParams(paramName, value, { stringKeys, presentKeys }) {
  if (typeof value !== 'string') return null;
  const boundaryOf = (name, s, from) => {
    const re = new RegExp(`</${escapeRe(name)}>\\s*<parameter name="([A-Za-z0-9_-]{1,64})">`, 'g');
    re.lastIndex = from;
    let m;
    while ((m = re.exec(s)) !== null) {
      const next = m[1];
      if (stringKeys.has(next) && !presentKeys.has(next)) return { index: m.index, end: re.lastIndex, next };
      // 命中了形状但下一个名字不合格 —— 不是我们认识的泄漏，继续找不如收手：
      // 这种"半像"的情况宁可不动（判据要窄）。
      return null;
    }
    return null;
  };

  const first = boundaryOf(paramName, value, 0);
  if (!first) return null;

  const recovered = {};
  const clean = value.slice(0, first.index);
  let curKey = first.next;
  let rest = value.slice(first.end);
  for (let hops = 0; hops < 8; hops += 1) {
    const nb = boundaryOf(curKey, rest, 0);
    if (!nb) break;
    recovered[curKey] = rest.slice(0, nb.index);
    curKey = nb.next;
    rest = rest.slice(nb.end);
  }
  // 最后一段：剥掉可能挂在尾巴上的 `</当前参数名>`
  recovered[curKey] = rest.replace(new RegExp(`\\s*</${escapeRe(curKey)}>\\s*$`), '');
  return { clean, recovered };
}

/**
 * 消毒一份 args（不改原对象）。返回 { args, leaks } —— leaks 为空数组表示没动。
 * @param {object} args        SDK 校验后的入参
 * @param {object} rawShape    tool() 的 inputSchema（zod raw shape）
 */
export function desmearArgs(args, rawShape) {
  const leaks = [];
  if (!args || typeof args !== 'object' || !rawShape) return { args, leaks };
  const stringKeys = new Set(Object.keys(rawShape).filter((k) => unwrapsToString(rawShape[k])));
  const presentKeys = new Set(Object.keys(args).filter((k) => args[k] !== undefined));
  let out = args;
  for (const k of Object.keys(args)) {
    if (!stringKeys.has(k)) continue;
    const hit = splitLeakedParams(k, args[k], { stringKeys, presentKeys });
    if (!hit) continue;
    if (out === args) out = { ...args };
    out[k] = hit.clean;
    for (const [rk, rv] of Object.entries(hit.recovered)) {
      out[rk] = rv;
      presentKeys.add(rk);
    }
    leaks.push({ from: k, recovered: Object.keys(hit.recovered) });
  }
  return { args: out, leaks };
}

/**
 * 包一个 tool() 定义：handler 前置消毒。fail-soft —— 消毒抛错就原样放行。
 * @param {object} toolDef   tool() 的返回值（{ name, inputSchema, handler, … }）
 * @param {object} [deps]    { projectId, sessionId } 供 recordIssue 归因
 */
export function withParamSanitizer(toolDef, deps = {}) {
  const inner = toolDef.handler;
  if (typeof inner !== 'function' || !toolDef.inputSchema) return toolDef;
  toolDef.handler = async (args, extra) => {
    let finalArgs = args;
    try {
      const { args: cleaned, leaks } = desmearArgs(args, toolDef.inputSchema);
      if (leaks.length) {
        finalArgs = cleaned;
        try {
          recordIssue({
            source: 'auto',
            toolName: toolDef.name,
            summary: `工具参数标签泄漏（上游解析）：${toolDef.name} 的 ${leaks.map((l) => l.from).join(',')} 吞了 ${leaks.map((l) => l.recovered.join('+')).join(',')}，已在边界拆回`,
            detail: `模型把闭合标签写错、上游解析器把后续参数吞进前一个字符串参数。本层已恢复。leaks=${JSON.stringify(leaks)}`,
            projectId: deps.projectId,
            sessionId: deps.sessionId,
            signature: signatureOf(`param-leak|${toolDef.name}`),
          });
        } catch { /* 记账失败不挡工具 */ }
      }
    } catch { /* 消毒自身故障 → 原样放行 */ }
    return inner(finalArgs, extra);
  };
  return toolDef;
}
