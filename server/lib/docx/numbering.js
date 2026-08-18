/**
 * server/lib/docx/numbering.js — 自动编号（word/numbering.xml，2026-08-18）
 *
 * ## 为什么值得单独一个 part
 *
 * 「列表必须是真编号定义，不是手打 1. 2.」是 docx-craft 的结构真实性军规之一，
 * 判据是**用户在 Word 里插一条会不会散架**：手打的编号插一条要全手改，删一条
 * 就断号。但 2026-08-17 上线时引擎只有注释里提过 numbering，实际不产这个 part
 * —— `para.list` 写上去会产出一个指向空处的 numId，比手打还糟。
 * 所以军规当时被改成了诚实边界。这个模块把它变回真的。
 *
 * ## agent 面对的是名字不是数字
 *
 * OOXML 里 numId 是整数，而且 `w:num`（实例）和 `w:abstractNum`（定义）是两层。
 * 这层间接对 agent 毫无价值，所以 token 里**按名字引用**：
 *
 *   tokens.numbering = { "条款": "公文条款" }          // 用内置梯队
 *   tokens.numbering = { "自定义": { levels: [...] } }  // 自己写
 *   块上：{ t:'p', style:'Normal', list: { name:'条款', ilvl:0 }, text:'…' }
 *
 * 名字→numId 的映射在 build 时算，agent 不碰。
 *
 * ## 内置梯队面向中文文档
 *
 * 中文正式文档的层级传统是 `一、`→`（一）`→`1.`→`（1）`（公文那一套），
 * 跟英文的 `1.`→`a.`→`i.` 不是一回事。⭐ 这是「面向中文用户」这条定位在
 * 编号这一层的具体兑现 —— 默认给对的那套，而不是给一套再让人改。
 */

import { elem, textNode, serializeNode } from './xml.js';
import { sortChildren } from './order.js';

const W = 'xmlns:w';
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const val = (name, v) => elem(name, [['w:val', v]]);

/**
 * 合法的 `w:numFmt`。闭合，跟 token schema 其他地方一个口径。
 * 只收中文文档真会用到的那些 —— ISO 29500 里有六十多个，全放开只会让人写出
 * Word 显示不出来的东西。
 */
export const NUM_FMTS = new Set([
  'decimal',                    // 1 2 3
  'chineseCounting',            // 一 二 三
  'chineseCountingThousand',    // 一 二 三（万进位）
  'ideographDigital',           // 一 二 三
  'ideographTraditional',       // 甲 乙 丙
  'decimalEnclosedCircle',      // ① ② ③  —— 中文文档极常用
  'decimalEnclosedParen',       // ⑴ ⑵ ⑶
  'decimalEnclosedFullstop',    // ⒈ ⒉ ⒊
  'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman',
  'bullet', 'none',
]);

/** 一个字的宽度（小四 12pt 下约 240 twip）—— 缩进梯度按字算，不按英寸 */
const CHAR = 240;

/**
 * 内置编号梯队。
 * `text` 里的 `%N` 是「第 N 级的当前值」，所以 `%1.%2` 出的是 `1.1`。
 */
export const NUM_PRESETS = {
  // 公文/正式报告的中文层级传统：一、→（一）→ 1. →（1）。
  // 形态是**首行缩进两字 + 文字紧跟编号**（「　　一、总体要求」，续行顶格），
  // 跟英文列表的悬挂缩进块是两种东西。
  公文条款: [
    { fmt: 'chineseCounting', text: '%1、', firstLine: 2, suff: 'nothing' },
    { fmt: 'chineseCounting', text: '（%2）', firstLine: 2, suff: 'nothing' },
    { fmt: 'decimal', text: '%3.', firstLine: 2, suff: 'space' },
    { fmt: 'decimal', text: '（%4）', firstLine: 2, suff: 'nothing' },
  ],
  // 技术文档那一路：1. / 1.1 / 1.1.1。这个要悬挂缩进 —— 折行对齐到文字起点，
  // 编号那一列空着，整块看起来是对齐的。
  数字条款: [
    { fmt: 'decimal', text: '%1.', indent: 1.5, hanging: 1.5 },
    { fmt: 'decimal', text: '%1.%2', indent: 3, hanging: 2 },
    { fmt: 'decimal', text: '%1.%2.%3', indent: 4.5, hanging: 2.5 },
  ],
  // 圈码：中文文档里"并列要点"最常见的一种。圈码本身占一个全角宽，
  // 后面不需要间隔（suff:nothing），但要悬挂让折行对齐。
  圈码: [
    { fmt: 'decimalEnclosedCircle', text: '%1', indent: 1, hanging: 1, suff: 'nothing' },
  ],
  // 项目符号。⚠️ 故意用真实汉字区符号而不是 Symbol/Wingdings 字体的私用码位 ——
  // 后者在没装那两个字体的机器上（我们的渲染服务器就没有）会变成豆腐块。
  项目符号: [
    { fmt: 'bullet', text: '●', indent: 1.5, hanging: 1.5 },
    { fmt: 'bullet', text: '○', indent: 2.5, hanging: 1.5 },
    { fmt: 'bullet', text: '▪', indent: 3.5, hanging: 1.5 },
  ],
};

/** 一条 numbering 定义 → levels 数组（内置名 or 自定义都归一到这里） */
export function resolveLevels(defn) {
  if (typeof defn === 'string') {
    const preset = NUM_PRESETS[defn];
    if (!preset) {
      throw new Error(`unknown numbering preset '${defn}'，可选：${Object.keys(NUM_PRESETS).join(' / ')}`);
    }
    return preset;
  }
  if (defn && Array.isArray(defn.levels)) return defn.levels;
  throw new Error('numbering 定义要么是内置梯队名，要么是 { levels: [...] }');
}

/** levels 校验（闭合，跟 validateTokens 同口径）*/
const LEVEL_KEYS = new Set(['fmt', 'text', 'indent', 'hanging', 'firstLine',
  'indentTwip', 'hangingTwip', 'firstLineTwip', 'start', 'align', 'suff']);
export function validateNumbering(numbering) {
  const errs = [];
  for (const [name, defn] of Object.entries(numbering ?? {})) {
    let levels;
    try { levels = resolveLevels(defn); } catch (err) { errs.push(`numbering.${name}: ${err.message}`); continue; }
    if (!levels.length || levels.length > 9) {
      errs.push(`numbering.${name}: 要 1-9 级，收到 ${levels.length}`);
    }
    levels.forEach((lv, i) => {
      for (const k of Object.keys(lv)) {
        if (!LEVEL_KEYS.has(k)) errs.push(`numbering.${name}.levels[${i}]: unknown key ${k}`);
      }
      if (!NUM_FMTS.has(lv.fmt)) {
        errs.push(`numbering.${name}.levels[${i}].fmt: '${lv.fmt}' 不在支持的编号格式里`
          + `（常用：decimal / chineseCounting / decimalEnclosedCircle / bullet）`);
      }
      if (typeof lv.text !== 'string' || !lv.text) {
        errs.push(`numbering.${name}.levels[${i}].text: 必填，如 '%1、' 或 '%1.%2' 或 '●'`);
      }
      if (lv.fmt !== 'bullet' && lv.fmt !== 'none' && !/%\d/.test(lv.text ?? '')) {
        errs.push(`numbering.${name}.levels[${i}].text: '${lv.text}' 里没有 %N 占位符，`
          + '编号值不会出现在文档里（bullet 才不需要）');
      }
    });
  }
  return errs;
}

/**
 * 名字 → numId 的映射。**顺序稳定**（按 Object.keys 的插入序），
 * 这样同一份 token 每次构建出的 numId 一样 —— 保真自检和 diff 才有意义。
 */
export function numIdMap(numbering) {
  const map = new Map();
  let id = 1;
  for (const name of Object.keys(numbering ?? {})) map.set(name, id++);
  return map;
}

function buildLevel(lv, ilvl) {
  // 两种缩进形态，选哪种决定的是**折行的第二行去哪儿**：
  //   hanging（悬挂）—— 折行对齐到文字起点，编号那一列空出来。技术文档 1.1.1 那种
  //     对齐块要这个。
  //   firstLine（首行缩进）—— 折行回到左边距。中文公文的层级标题是这个形态：
  //     「　　一、总体要求」，续行顶格。
  const indentTwip = lv.indentTwip ?? Math.round((lv.indent ?? 0) * CHAR);
  const kids = [
    val('w:start', lv.start ?? 1),
    val('w:numFmt', lv.fmt),
    val('w:lvlText', lv.text),
    val('w:lvlJc', lv.align ?? 'left'),
  ];
  // ⭐ w:suff 决定编号和文字之间放什么。默认是 tab —— 而 tab 会跳到下一个制表位，
  // 于是「一、」这种两字宽的编号后面会空出一大截（首次真跑就是这么发现的）。
  // 中文编号后面本来就带全角标点（一、 / （一） / ①），不需要再加间隔，
  // 所以这些梯队一律 suff:'nothing'，让文字紧跟着编号。
  if (lv.suff) kids.push(val('w:suff', lv.suff));
  const ind = [['w:left', indentTwip]];
  if (lv.firstLine != null || lv.firstLineTwip != null) {
    ind.push(['w:firstLine', lv.firstLineTwip ?? Math.round(lv.firstLine * CHAR)]);
  } else {
    ind.push(['w:hanging', lv.hangingTwip ?? Math.round((lv.hanging ?? 1.5) * CHAR)]);
  }
  kids.push(elem('w:pPr', [], [elem('w:ind', ind)]));
  return sortChildren(elem('w:lvl', [['w:ilvl', ilvl]], kids));
}

/**
 * 产 word/numbering.xml。
 * @param {object} numbering  tokens.numbering
 * @returns {string|null} null = 没有编号定义，这个 part 不该存在
 */
export function buildNumberingXml(numbering) {
  const names = Object.keys(numbering ?? {});
  if (!names.length) return null;

  const ids = numIdMap(numbering);
  const abstracts = [];
  const nums = [];
  for (const name of names) {
    const numId = ids.get(name);
    const abstractId = numId;           // 一对一，不共享定义（共享只会让排错变难）
    const levels = resolveLevels(numbering[name]);
    abstracts.push(sortChildren(elem('w:abstractNum', [['w:abstractNumId', abstractId]], [
      val('w:multiLevelType', levels.length > 1 ? 'multilevel' : 'singleLevel'),
      val('w:name', name),
      ...levels.slice(0, 9).map((lv, i) => buildLevel(lv, i)),
    ])));
    nums.push(elem('w:num', [['w:numId', numId]], [val('w:abstractNumId', abstractId)]));
  }

  const root = sortChildren(elem('w:numbering', [[W, NS_W]], [...abstracts, ...nums]));
  return DECL + serializeNode(root);
}

/**
 * 按 tokens 对象记忆化的 name→numId 映射。
 * 每个段落都重算一次不贵，但那是"同一件事算很多遍"，而这个仓库最贵的一课就是
 * 同一件东西有多个实例 —— 记一份。
 */
const memo = new WeakMap();
export function numIdsFor(tokens) {
  if (!tokens || typeof tokens !== 'object') return new Map();
  let m = memo.get(tokens);
  if (!m) { m = numIdMap(tokens.numbering); memo.set(tokens, m); }
  return m;
}

export { textNode };
