import { describe, it, expect } from 'vitest';
import {
  KINDS, kindOf, traitsOf, sizeOf, actionsOf, primaryOf, readerOf,
  chromeOf, cardOf, isFileBacked, legacyBucketOf, isMarkdown, SIZES, ARTIFACT_CARD,
} from './board-kinds.js';

/**
 * 形态能力表的回归锁。
 *
 * 手法跟 2026-08-01 那次「旧版 import 成影子模块，真实数据上逐字节 diff」
 * 一样，只是降到单测层：**把重构前散在 BoardCanvas 里的分支原样抄进这里当
 * 预言机**，再拿新表跟它对账。这样断言的不是「我觉得表该长什么样」，而是
 * 「表和被它替换掉的那堆 if 行为完全一致」。
 *
 * 下面三个 legacy* 函数是 2026-08-07 重构前 BoardCanvas.jsx 的原文，
 * 抄自 sizeOf(board-geometry.js:70)、actions(BoardObject:1766-1773)、
 * primaryOpen(BoardCanvas:1027-1036)。**改表时不要顺手改它们** —— 它们
 * 就是那条基线；真要改行为，先在这里改断言并说明为什么。
 *
 * ## 2026-08-13：产物三兄弟的尺寸与双击动作**有意改了**，理由如下
 *
 * 按上面立的规矩，在这里说明白：
 *
 * 1. **展开态整个退役。** deck / 站点 / 世界原来各有"收起条"和"在画布上展开成
 *    内嵌渲染"两态，卡体在 BoardCanvas 里抄了六遍（约 180 行，骨架逐字节相同）。
 *    现在只有一种样子：方卡 + 实时缩略图，双击直接开那扇窗。
 *    换来的是**尺寸恒定** —— 一个会自己变大两倍半的卡片是所有落点/防遮盖逻辑
 *    的噪声源，而"并排看两份 deck"本来就该由窗来做。
 *    → `sizeExpanded` 从表里删除，`isExpandable` 随之删除，`SAMPLES` 里那三个
 *      "展开"样本改成**验证展开态存量数据被忽略**（见下）。
 * 2. **收起态 240×56 → 方卡 200×200。** 一条只有一行字的窄条上看不出这是什么
 *    东西；三种产物在桌面上长得一模一样。方卡上面那块是实时缩略图。
 *    宽度取 200 跟图片卡对齐 —— 一排卡宽窄不一的话 packRow 的列宽只能取最宽
 *    那个，剩下的全在自己格子里晃。
 * 3. **双击 `'expand'` → `'open'`。** 老的是两段式（先展开、再双击才开窗），
 *    展开态没了之后第一段没有落点。
 */

const LEGACY_SIZES = {
  doc: { w: 200, h: 96 },
  deck: { w: 240, h: 88 },
  deckExpanded: { w: 640, h: 28 + 360 },
  image: { w: 200, h: 176 },
  note: { w: 200, h: 148 },
  file: { w: 224, h: 40 },
  site: { w: 240, h: 88 },
  siteExpanded: { w: 640, h: 28 + 400 },
  world: { w: 240, h: 88 },
  worldExpanded: { w: 640, h: 28 + 420 },
};

/**
 * 收起态高度的**有意改动**（2026-08-07 晚）。
 *
 * 上面那张基线是重构前 BoardCanvas 里的原样口径，而那个口径本身就跟卡体
 * 实际渲染对不上：产物卡收起态声明 88 高、实渲只有 54；文件卡声明 40、
 * 实渲 29。卡体是 height:auto，声明值只用来给布局占位 —— 于是每一行产物卡
 * 白留 34px，每一行文件卡白留 11px，而且是那种"看着就是不太对但说不出哪儿
 * 不对"的白留。
 *
 * 新值在浏览器里逐个量 offsetHeight 校准，各留 2~3px 呼吸。改卡体高度时
 * 要回来一起改。
 */
const CALIBRATED = {
  deck: { w: 240, h: 56 },
  site: { w: 240, h: 56 },
  world: { w: 240, h: 56 },
  file: { w: 224, h: 32 },
};
const expectedSize = (k) => CALIBRATED[k] || LEGACY_SIZES[k];

/** 产物三兄弟改用方卡（2026-08-13，理由见文件头第 2 条） */
const SQUARE = { deck: ARTIFACT_CARD, site: ARTIFACT_CARD, world: ARTIFACT_CARD };

function legacySizeOf(o) {
  // 展开态存量数据**必须被忽略**：还读 `pos.expanded` 的话，老卡会带着
  // 640×388 的隐形脚印参与命中判定，渲染出来却只有 200 宽
  if (SQUARE[o.type]) return SQUARE[o.type];
  return expectedSize(o.type) || expectedSize('file');
}

function legacyActions(o) {
  const md = /\.(md|markdown)$/i.test(o?.ext || o?.name || o?.path || '');
  const a = [];
  if (o.type !== 'deck') a.push('add');
  if (o.type === 'doc' || o.type === 'note') a.push('read');
  if (o.type === 'image') a.push('detail');
  if (o.type === 'file' && md) a.push('read');
  if (o.type === 'file') a.push('open');
  if (o.type === 'note') a.push('delete');
  return a;
}

function legacyPrimary(o) {
  const md = /\.(md|markdown)$/i.test(o?.ext || o?.name || o?.path || '');
  if (o.type === 'doc' || o.type === 'note') return 'read';
  if (o.type === 'image') return 'detail';
  if (o.type === 'file') return md ? 'read' : 'openFile';
  if (o.type === 'deck' || o.type === 'site' || o.type === 'world') return 'open';
  return undefined;
}

/** 覆盖全部 type × 展开态 × markdown 变体的样本。 */
const SAMPLES = [
  { label: 'doc', o: { type: 'doc', title: '记忆' } },
  { label: 'deck', o: { type: 'deck', pos: {} } },
  // 存量 expanded:true —— 断言它跟没有这个字段的完全一样（不再有隐形脚印）
  { label: 'deck 带存量 expanded', o: { type: 'deck', pos: { expanded: true } } },
  { label: 'site', o: { type: 'site', pos: {} } },
  { label: 'site 带存量 expanded', o: { type: 'site', pos: { expanded: true } } },
  { label: 'world', o: { type: 'world', pos: {} } },
  { label: 'world 带存量 expanded', o: { type: 'world', pos: { expanded: true } } },
  { label: 'image', o: { type: 'image', name: 'a.webp', ext: '.webp' } },
  { label: 'note', o: { type: 'note', name: '灵感.md', ext: '.md' } },
  { label: 'file 普通', o: { type: 'file', name: 'a.zip', ext: '.zip' } },
  { label: 'file markdown', o: { type: 'file', name: '世界.md', ext: '.md' } },
  { label: 'file MARKDOWN 大写', o: { type: 'file', name: 'README.MARKDOWN', ext: '.MARKDOWN' } },
];

describe('board-kinds 与重构前的行为一致', () => {
  it.each(SAMPLES)('$label 的尺寸不变', ({ o }) => {
    expect(sizeOf(o)).toEqual(legacySizeOf(o));
  });

  it.each(SAMPLES)('$label 的工具条按钮与顺序不变', ({ o }) => {
    expect(actionsOf(o)).toEqual(legacyActions(o));
  });

  it.each(SAMPLES)('$label 的双击动作不变', ({ o }) => {
    expect(primaryOf(o)).toBe(legacyPrimary(o));
  });
});

/**
 * 唯一一处有意的行为变化，单独拎出来说清楚。
 *
 * 老代码对未知 type 是自相矛盾的：尺寸走 `SIZES[o.type] || SIZES.file` 拿到
 * file 的 224×40，但渲染分支写的是 `{o.type === 'file' && …}` 匹配不上 ——
 * 于是它渲染成一张**空白的 file 尺寸卡**，工具条只有「+」，双击是死的。
 * 新表把未知 type 整体兜底到 file，卡体、按钮、双击三者第一次一致。
 *
 * 当前构造不出未知 type（objects useMemo 里七种全写死），所以这是纯粹的
 * 防御路径整形，线上零影响。往后加形态时它是安全网：新 type 忘了登记，
 * 表现是「退化成文件卡」而不是「空白卡 + 点不开」。
 */
describe('未知 type 兜底（有意与老代码不同）', () => {
  const unknown = { type: 'wat', name: 'x.bin' };

  it('尺寸沿用老口径 = file', () => {
    expect(sizeOf(unknown)).toEqual(legacySizeOf(unknown));
  });

  it('工具条补齐了「打开」（老代码只有 +）', () => {
    expect(legacyActions(unknown)).toEqual(['add']);
    expect(actionsOf(unknown)).toEqual(['add', 'open']);
  });

  it('双击从死的变成打开原始文件（老代码 undefined）', () => {
    expect(legacyPrimary(unknown)).toBeUndefined();
    expect(primaryOf(unknown)).toBe('openFile');
  });
});

describe('两条轴', () => {
  /**
   * 这条不是"记录现状"，是**闸门**：canvas-backed 意味着 agent 读不到它
   * （它没有文件）。往这个集合里加东西是产品决定，不能顺手加。
   *
   * - `doc`   记忆/品牌/指引三张卡的画布分身，正文在服务端不在磁盘产物里
   * - `scribble` 涂鸦，2026-08-07 加，用户给自己做的记号
   * - `text`  画布手写文字，2026-08-08 加。**这是一次产品决定的翻转**：
   *   在那之前画布上打的字一律落成 .md 便签，理由正是"agent 读得到"。
   *   翻转的理由是用户要的是白板 —— 在工程文件旁边随手写一句，那是记号不是
   *   指令。给 agent 看的那条路没删，挪到了右键「新建便利贴」。
   */
  it('canvas-backed 是白名单，加成员要过这一关', () => {
    const canvasBacked = Object.entries(KINDS)
      .filter(([, v]) => v.backing === 'canvas').map(([k]) => k);
    expect(canvasBacked.sort()).toEqual(['doc', 'scribble', 'text']);
  });

  it('canvas-backed 一律不能加入上下文（没有 path 可给）', () => {
    for (const [name, k] of Object.entries(KINDS)) {
      if (k.backing !== 'canvas') continue;
      if (name === 'doc') continue;   // doc 有 readKey，是特例
      expect(actionsOf({ type: name }), `${name} 不该有 add`).not.toContain('add');
    }
  });

  it('每种形态都得声明 backing，不能漏', () => {
    for (const [name, k] of Object.entries(KINDS)) {
      expect(['file', 'canvas'], `${name} 的 backing`).toContain(k.backing);
    }
  });

  it('markdown 变体只改 file，不影响别的形态', () => {
    const md = { type: 'file', name: 'a.md', ext: '.md' };
    expect(traitsOf(md).reader).toBe('file');
    expect(traitsOf(md).primary).toBe('read');
    // 便签也是 .md，但它有自己的阅读器（要剥 frontmatter），不能被变体污染
    expect(readerOf({ type: 'note', name: 'x.md', ext: '.md' })).toBe('note');
  });

  it('isMarkdown 认扩展名也认路径，三个字段任一命中即可', () => {
    expect(isMarkdown({ ext: '.md' })).toBe(true);
    expect(isMarkdown({ name: '正文.markdown' })).toBe(true);
    expect(isMarkdown({ path: 'tasks/x/世界.md' })).toBe(true);
    expect(isMarkdown({ name: 'a.mdx' })).toBe(false);
    expect(isMarkdown({ name: 'md' })).toBe(false);
    expect(isMarkdown(null)).toBe(false);
  });
});

describe('派生判定', () => {
  it('走统一方卡的就是那三种产物', () => {
    const artifacts = Object.keys(KINDS).filter(k => cardOf({ type: k }) === 'artifact');
    expect(artifacts.sort()).toEqual(['deck', 'site', 'world']);
  });

  /**
   * `chrome` 是**闸门**，不是记录现状：`'bare'` = 这东西不是一张纸，是画布上
   * 的一笔墨（不给底色/描边/影子/圆角）。加成员是产品决定。
   *
   * 这条轴 2026-08-13 才立起来，起因是它漏过一次：判据原本硬编码在 BoardObject
   * 里写 `o.type === 'scribble'`，`text` 加进来时没人想起改那一行，于是画布上
   * 手写的字外面套着一张白卡 —— 而它自己的注释写着"没有卡片外观"。
   * **不能用 backing 代替**：`doc` 也是 canvas backing，但它要卡片外观。
   */
  it('bare（一笔墨）是白名单', () => {
    const bare = Object.entries(KINDS).filter(([, v]) => v.chrome === 'bare').map(([k]) => k);
    expect(bare.sort()).toEqual(['scribble', 'text']);
  });

  it('每种形态都得声明 chrome，不能漏', () => {
    for (const [name, k] of Object.entries(KINDS)) {
      expect(['card', 'bare'], `${name} 的 chrome`).toContain(k.chrome);
    }
    expect(chromeOf({ type: 'nope' })).toBe('card');   // 未知兜底成卡片
  });

  it('deck 不给外挂工具条（整张方卡就是打开的按钮）', () => {
    expect(actionsOf({ type: 'deck' })).toEqual([]);
  });

  it('doc 不是磁盘产物，其余都是', () => {
    expect(isFileBacked({ type: 'doc' })).toBe(false);
    expect(isFileBacked({ type: 'note' })).toBe(true);
    expect(isFileBacked({ type: 'deck' })).toBe(true);
  });

  it('收纳带分摞与重构前一致', () => {
    // 老代码：doc→doc、deck→deck、file→file、其余→art
    for (const t of ['doc', 'deck', 'file']) expect(legacyBucketOf({ type: t })).toBe(t);
    for (const t of ['note', 'image', 'site', 'world']) expect(legacyBucketOf({ type: t })).toBe('art');
    expect(legacyBucketOf({ type: 'wat' })).toBe('file');   // 未知按 file
  });

  it('kindOf 对未知 type 兜底到 file', () => {
    expect(kindOf({ type: 'nope' })).toBe(KINDS.file);
    expect(kindOf(null)).toBe(KINDS.file);
  });
});

describe('SIZES 兼容出口', () => {
  /**
   * 断言的是「**老的每一项一个字节都没变**」，不是「两张表完全相等」——
   * 后者会在每次加新形态时红一次，红久了就没人当真了。新增项另测。
   */
  it('老的尺寸逐项未变（校准见 CALIBRATED，方卡见 SQUARE）', () => {
    for (const [k, v0] of Object.entries(LEGACY_SIZES)) {
      if (k.endsWith('Expanded')) continue;            // 展开态整档退役
      const v = SQUARE[k] || CALIBRATED[k] || v0;
      expect(SIZES[k], `SIZES.${k}`).toEqual(v);
    }
  });

  it('新形态也进了铺平表', () => {
    expect(SIZES.scribble).toEqual(KINDS.scribble.size);
  });

  it('展开态退役后不再铺 xxxExpanded 这一档', () => {
    expect(Object.keys(SIZES).filter(k => k.endsWith('Expanded'))).toEqual([]);
  });
});

/**
 * 涂鸦墨色的两端一致性。
 *
 * 前端渲染表（BoardCanvas 的 SCRIBBLE_INK）和服务端白名单
 * （board-store.js 的 sanitizeCanvasData）是两份手写的字符串列表。
 * 两边不一致的表现很隐蔽：**"我选了红色，存下来变黑"** —— 不报错、
 * 不失败，只是颜色悄悄回落成 ink。所以钉一条。
 */
describe('涂鸦墨色词汇表两端一致', () => {
  it('前端渲染的颜色键 = 服务端接受的颜色键', async () => {
    const fe = await import('fs').then(fs =>
      fs.readFileSync(new URL('../components/canvas/BoardCanvas.jsx', import.meta.url), 'utf8'));
    const be = await import('fs').then(fs =>
      fs.readFileSync(new URL('../../../server/projects/board-store.js', import.meta.url), 'utf8'));

    const feKeys = fe.match(/const SCRIBBLE_INK = \{([\s\S]*?)\};/)[1]
      .match(/^\s*(\w+):/gm).map(x => x.trim().replace(':', '')).sort();
    const beKeys = JSON.parse(
      be.match(/\['ink'[^\]]*\]/)[0].replace(/'/g, '"')).sort();

    expect(feKeys).toEqual(beKeys);
  });
});
