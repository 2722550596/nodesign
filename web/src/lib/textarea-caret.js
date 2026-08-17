/**
 * 量出 textarea 里插入点的坐标（2026-08-17）。
 *
 * ## 为什么要自己量
 *
 * 原生 caret 是一根 1px 的线，落在首页那张米色纸上根本找不着 —— 这不是猜的，
 * 08-15 加空框红光标时代码注释里就写着这句。当时只解决了**空框**那一半（画一根
 * 2px 红竖线蹲在起笔位），一敲字就交回原生 caret，于是"一输入内容光标就没了"。
 * 要让打字时也是那根红线，就得知道插入点在哪 —— CSS 给不了，只能量。
 *
 * ## 怎么量：镜像层
 *
 * 造一个隐形的 div，把 textarea 的**盒模型与排版相关的每一条 computed style**
 * 抄过去（字体、行高、宽度、padding、换行规则…），填进「光标之前的那段文字」，
 * 末尾插一个零宽字符的 span，读它的 offsetLeft/offsetTop。因为两边排版规则逐条
 * 一致，那个 span 落在哪，真正的插入点就在哪。
 *
 * ⚠️ 三个坑，都在下面代码里对付了：
 *   1. **末尾是换行时行盒会塌**：`"abc\n"` 直接量的话，量到的还是第一行的末尾。
 *      所以零宽字符必须**真的插进去**（它撑出第二行的行盒），不能只读文本宽度。
 *   2. **滚动**：这个框有 max-height + overflow:auto，滚起来之后视觉位置要减掉
 *      scrollTop / scrollLeft。
 *   3. **镜像必须自己 `white-space: pre-wrap`**：textarea 的默认换行行为跟普通
 *      div 不一样，不显式写死，长句子在两边会断在不同的地方，光标就飘了。
 *
 * 中文输入法组字期间**不要用它**（value 和 selectionStart 都在跳），调用方应该在
 * composition 期间把原生 caret 放回来 —— 见 home-quick-entry.jsx。
 */

/**
 * 影响文字落点的每一条属性。少抄一条就是"平时对、某种情况下偏几像素"，
 * 而那种偏差没人会联想到这份清单。
 */
const MIRRORED = [
  'boxSizing', 'width',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'letterSpacing', 'lineHeight', 'textIndent', 'textTransform', 'textAlign',
  'wordSpacing', 'tabSize', 'wordBreak', 'overflowWrap',
];

let mirrorEl = null;

function mirror() {
  if (mirrorEl && mirrorEl.isConnected) return mirrorEl;
  mirrorEl = document.createElement('div');
  mirrorEl.setAttribute('aria-hidden', 'true');
  mirrorEl.dataset.textareaMirror = '';
  document.body.appendChild(mirrorEl);
  return mirrorEl;
}

/**
 * @param {HTMLTextAreaElement} ta
 * @param {number} [at] 插入点下标，默认取 selectionStart
 * @returns {{x:number, y:number, lineHeight:number}} 相对 textarea **左上角**的坐标
 *          （已经减掉滚动量）。x/y 是那一行的**左上角**，不是基线。
 */
export function measureCaret(ta, at) {
  const pos = Number.isInteger(at) ? at : (ta.selectionStart ?? 0);
  const cs = getComputedStyle(ta);
  const m = mirror();

  for (const k of MIRRORED) m.style[k] = cs[k];
  // 镜像自己的定位与可见性（这几条不能从 textarea 抄）
  m.style.position = 'absolute';
  m.style.top = '0';
  m.style.left = '-9999px';
  m.style.visibility = 'hidden';
  m.style.height = 'auto';
  m.style.overflow = 'hidden';
  // 见文件头坑 3：必须显式写死，别指望从 textarea 抄到对的值
  m.style.whiteSpace = 'pre-wrap';
  m.style.overflowWrap = cs.overflowWrap === 'normal' ? 'break-word' : cs.overflowWrap;

  m.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  // 零宽字符：既撑得出行盒（末尾是 \n 时全靠它），又不占宽度
  mark.textContent = '​';
  m.appendChild(mark);

  const x = mark.offsetLeft;
  const y = mark.offsetTop;
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;

  m.textContent = '';   // 量完就清空，别把一屏文字挂在 body 上

  return { x: x - ta.scrollLeft, y: y - ta.scrollTop, lineHeight };
}
