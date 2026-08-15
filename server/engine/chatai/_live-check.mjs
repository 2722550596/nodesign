/**
 * 真跑冒烟（手动，花真钱，几分钱量级）：
 *   node --env-file=.env server/engine/chatai/_live-check.mjs [演出文件夹]
 *
 * 不给文件夹就现场搭一个样例演出，摘要阈值调到最小（触发轮数 4 / 保留 2），
 * 连跑 6 轮验证全链路：编译 → 中转站 → 落盘 → 摘要折叠 → 前情提要回注。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { performTurn } from './perform.js';
import { compileContext } from './orchestrate.js';
import { readSummary } from './chat-log.js';

const YAML_SAMPLE = `# 样例演出 —— 真跑冒烟用
最大输出: 300
上下文预算: 20000

系统层:
  - 名字: 背景
    文件: 设定/背景.md
  - 名字: 文风
    内容: |
      第二人称现在时，每次回复一百五十字以内，只写可感知的事，结尾留一个可以接的动作或问题。

历史:
  保留轮数: 40

摘要:
  保留轮数: 2
  触发轮数: 4
  长度: 200

尾部:
  - 名字: 当前场景
    文件: 状态/场景.md
  - 名字: 交易提醒
    内容: 涉及买卖时，报价要具体到铜币数目。
    触发: [买, 卖, 价钱]
`;

const 背景 = `你扮演夜行集市的守摊人「老芦」：一个只在雾夜出摊的旧货商，卖的都是有来历的小物件。
性格：话少，报价从不还价，对识货的客人会多说一句来历。
集市规矩：不问来路，不收纸币，只收铜币和故事。`;

const 场景 = `雾很重，摊上点着一盏豆油灯。今晚摊面上有：一枚缺口的铜铃、一面裂了纹的小圆镜、一串没人认得的钥匙。`;

const TURNS = [
  '我走近摊子，拿起那枚铜铃看了看。',
  '「这铃是什么来历？」',
  '我摇了摇铃，听听它的声音。',
  '「这铃什么价钱？我想买。」',
  '我掏出铜币付了钱，顺口问起那串钥匙。',
  '「钥匙的故事，下次雾夜我拿一个自己的故事来换。」我转身要走。',
];

async function main() {
  let dir = process.argv[2];
  if (!dir) {
    dir = path.join(process.env.TMPDIR || '/tmp', `rp-live-${Date.now()}`);
    await fs.mkdir(path.join(dir, '设定'), { recursive: true });
    await fs.mkdir(path.join(dir, '状态'), { recursive: true });
    await fs.writeFile(path.join(dir, '编排.yaml'), YAML_SAMPLE);
    await fs.writeFile(path.join(dir, '设定/背景.md'), 背景);
    await fs.writeFile(path.join(dir, '状态/场景.md'), 场景);
    console.log(`样例演出搭在：${dir}`);
  }

  let total = 0;
  for (const [i, input] of TURNS.entries()) {
    const t0 = Date.now();
    const r = await performTurn({ dir, userInput: input });
    total += r.costUsd + (r.摘要?.花费 || 0);
    const tail = r.meta.条目.filter(e => e.区 === '尾部').map(e => `${e.名字}${e.进入 ? '✓' : '✗'}`).join(' ');
    console.log(`\n—— 第${i + 1}轮（${((Date.now() - t0) / 1000).toFixed(1)}s，$${r.costUsd.toFixed(5)}）`);
    console.log(`   历史:进${r.meta.历史.进入轮数}/${r.meta.历史.总轮数}轮 折叠:${r.meta.历史.摘要已折叠} 尾部:[${tail}] 估算:${r.meta.估算.合计}tok`);
    console.log(`   ${r.text.replace(/\n/g, ' ').slice(0, 100)}…`);
    if (r.摘要?.内容) console.log(`   ⭐ 摘要折叠发生：至seq=${r.摘要.至}，$${r.摘要.花费.toFixed(5)}\n   提要：${r.摘要.内容.replace(/\n/g, ' ').slice(0, 120)}…`);
    if (r.摘要?.失败) console.log(`   ⚠️ 摘要失败：${r.摘要.失败}`);
  }

  // 终局验证：摘要文件在、且下一轮编译真的回注前情提要
  const s = await readSummary(dir);
  if (!s) throw new Error('跑完 6 轮摘要没触发（阈值 4）——链路有病');
  const c = await compileContext({ dir, userInput: '（验证轮，不发送）' });
  const injected = c.messages[0].content.startsWith('<前情提要>');
  console.log(`\n验证：摘要.json 在（至=${s.至}）；前情提要回注首条消息=${injected}；下轮将带 ${c.messages.length} 条消息、约 ${c.meta.估算.合计} tok`);
  if (!injected) throw new Error('前情提要没有注进首条 user 消息');
  console.log(`全链路 ✓  六轮总花费 $${total.toFixed(4)}`);
}

main().catch(e => { console.error('真跑失败：', e.message); process.exit(1); });
