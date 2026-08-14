import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Wrench, LayoutTemplate, MoreHorizontal, Copy, Trash2, Edit2 } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import CreateProjectModal from '../components/project/CreateProjectModal.jsx';
import ComposerTray from '../components/chat/ComposerTray.jsx';
import { COLOR, CHROME, GAP, RADIUS, FONT_SIZE } from '../lib/theme.js';
import { PAPER_VARS, PAPER_SHADOW } from '../lib/paper.js';
import { isImeEnter } from '../lib/helpers.js';
import { Clip, Underline } from '../components/PaperBits.jsx';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Sessions, Assets, Projects } from '../lib/api.js';
import { timeAgo } from '../lib/helpers.js';
import dTangle from '../assets/login-wall/doodles/tangle.webp';

/**
 * Home 页 —— 进门之后的那面板子（2026-08-03 改版）
 *
 * 跟登录墙同一套物料（lib/paper.js）：楷体、纸、颗粒、一个光向的三档影子、
 * 图钉和长尾夹。**同一块板**（连织纹和旧钉眼都照搬）—— 门外那面墙讲的是别人
 * 做完的一件事，进门之后同一块板上钉的是你自己的东西。
 *
 * 但不套墙那套构图规则：墙是 1500x800 的固定设计稿，内容写死所以能讲一个从①
 * 到⑥的故事；这里是真实数据，条数不定、要滚动、每张卡都能点。同风格不等于同
 * 版式，能共用的是材质，不是坐标。
 *
 * 两块内容：
 *   [便签本]   一句话开工。红边线 + 横线周期跟 line-height 对死，字真写在线上。
 *   [项目卡]   钉在板上的纸，封面是贴上去的印样，钉子在纸外面（纸被拿起来的
 *              时候钉子不动）。最近动过的那张挂「接着做」小签 —— 回访第一动作。
 *
 * 卡片那行元信息以前印的是 skill_id（全站同一个值），换成真读磁盘的产物清单
 * （GET /api/projects/stats）；拿不到就只留时间，不编。
 */

/** 纸的倾角按 id 定死：每次渲染都一样，不会因为 re-render 抖一下 */
function tilt(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `${((h % 220) - 110) / 100}deg`;
}

/** 形态的中文说法沿用产品里已有的叫法：deck 保持英文（用户自己就这么说） */
const KIND_WORD = { deck: ['份', 'deck'], site: ['个', '站点'] };

/** 「这个项目里躺着什么」。stats 还没回来时返回 null —— 宁可空着也不填假话 */
function inventory(st) {
  if (!st) return null;
  const parts = Object.entries(st.kinds || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => {
      const [unit, word] = KIND_WORD[k] || ['个', k];
      return `${n} ${unit}${word}`;
    });
  if (parts.length) return parts.join(' · ');
  return st.tasks ? `${st.tasks} 件开了头` : '还没出东西';
}

const CSS = `
/* 板面跟登录墙是同一块板：卡片是拿钉子钉上去的，那底下就不能是一片平涂的色。
   纤维板的织纹和旧钉眼照搬，只把网格线压淡 —— 墙是一屏定死的构图撑得住那个密度，
   首页要滚很长，同样密度会吵。 */
.ndd {
  ${PAPER_VARS}
  position: relative;
  min-height: 100%;
  padding: 32px 40px 90px;
  font-family: var(--kai);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(ellipse 80% 40% at 50% -6%, rgba(255,247,225,0.55), transparent 62%),
    radial-gradient(ellipse 44% 22% at 10% 16%, rgba(122,96,56,0.05), transparent 72%),
    radial-gradient(ellipse 40% 20% at 90% 42%, rgba(122,96,56,0.045), transparent 74%),
    radial-gradient(ellipse 34% 18% at 26% 70%, rgba(93,74,44,0.04), transparent 72%),
    radial-gradient(ellipse 30% 16% at 78% 92%, rgba(255,246,218,0.4), transparent 72%),
    var(--grain),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.02) 0 1px, transparent 1px 28px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.02) 0 1px, transparent 1px 28px),
    var(--wall);
}
/* 织纹 + 旧钉眼：三种周期错开，滚多远都看不出重复 */
.ndd::before {
  content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background:
    radial-gradient(circle at 37px 51px, rgba(72,55,32,0.15) 0 1.1px, transparent 1.7px),
    radial-gradient(circle at 119px 23px, rgba(72,55,32,0.12) 0 1px, transparent 1.6px),
    radial-gradient(circle at 61px 137px, rgba(72,55,32,0.1) 0 1.2px, transparent 1.8px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.017) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.013) 0 1px, transparent 1px 3px);
  background-size: 163px 211px, 271px 149px, 197px 313px, auto, auto;
}
.ndd *, .ndd *::before, .ndd *::after { box-sizing: border-box; }
.ndd-in { position: relative; z-index: 1; max-width: 1400px; margin: 0 auto; }

/* 顶区三栏：左边把这周的账写在板子上，中间便签本，右边一个涂鸦。
   便签本原来一个人吊在一大片空板中间，两侧各三百多像素什么都没有。 */
.ndd-top { display: flex; align-items: flex-start; gap: 28px; }
.ndd-mid { flex: 1 1 auto; min-width: 0; }
.ndd-side { flex: 0 0 292px; padding-top: 30px; }
.ndd-side.r { text-align: center; }
/* 两侧各 292 —— 视口不够宽时先把它们收掉，别把便签本挤成一条缝 */
@media (max-width: 1320px) { .ndd-side { display: none; } }

/* 直接写在板上的字：不带纸，是记在板子上的账 */
.ndd-note { color: rgba(122,111,92,0.92); transform: rotate(-0.9deg);
  padding-left: 6px; }
.ndd-note .t { display: block; font: 700 21px var(--kai); letter-spacing: 0.1em;
  line-height: 1.3; color: rgba(104,93,76,0.95); }
.ndd-note .rule { display: block; width: 112px; height: 7px; margin: 5px 0 7px; }
.ndd-note .l { display: block; font: 12.5px var(--kai); line-height: 2.05; }
.ndd-note .n { font-size: 15px; color: rgba(140,127,104,0.95); }

.ndd-side .doodle { display: block; width: 138px; margin: 0 auto; opacity: 0.5; }
.ndd-side .aside { margin-top: 12px; font: 12.5px var(--kai); line-height: 1.95;
  color: rgba(130,119,99,0.9); transform: rotate(0.7deg); }

/* ===== 便签本：一句话开工 ===== */
.ndd-greet { text-align: center; font: 700 25px var(--kai); letter-spacing: 0.05em;
  margin-bottom: 20px; }
.ndd-pad { position: relative; max-width: 720px; margin: 0 auto;
  padding: 26px 24px 16px 58px;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.mid};
  transform: rotate(-0.35deg);
  transition: box-shadow 0.2s; }
/* 笔记本红边线：字写在线右边，跟随便贴一张白纸区分开 */
.ndd-pad::before { content: ''; position: absolute; left: 40px; top: 0; bottom: 0; width: 1px;
  background: rgba(168,54,43,0.34); }
.ndd-pad .clip { position: absolute; top: -14px; left: var(--cx, 18%); width: 18px; z-index: 4;
  filter: drop-shadow(-1px 2px 2px rgba(43,33,23,0.3)); }
/* 横线画在紧贴 textarea 的这一层上，不画在纸上：
   纸的高度是内容加起来的，横线铺满纸就必然在上下两头各切出半格。
   这一层的高度恒等于 textarea 的高度，而 textarea 去掉了 padding、行高锁死
   29px，高度永远是 29 的整数倍 —— 于是每一格都是完整的，最后一格的线正好
   落在这一层的下边缘。 */
.ndd-pad .lines {
  background-image: linear-gradient(180deg, transparent 0 28px, rgba(43,33,23,0.08) 28px 29px);
  background-size: 100% 29px; background-position: 0 0; }
.ndd-pad textarea { width: 100%; background: transparent; border: none; outline: none;
  resize: none; display: block;
  font: 16.5px var(--kai); line-height: 29px; color: var(--ink);
  /* 红笔光标：墨色光标是一根 1px 的线，落在米色纸上根本找不着。
     红色跟板上所有「自己写的」标记同一支笔（红钉、红批注、接着做） */
  caret-color: var(--red);
  padding: 0; max-height: 290px; min-height: 116px; overflow: auto; }
.ndd-pad textarea::placeholder { color: var(--pencil); }
/* 光标之外还得有个状态信号：整张纸没有边框，光靠一根闪的竖线判断"进没进输入态"
   太吃力。聚焦时纸抬起来一档、横线加深、红边线变实 —— 三样一起动，看不错。 */
.ndd-pad:focus-within { box-shadow: ${PAPER_SHADOW.near}; }
.ndd-pad:focus-within::before { background: rgba(168,54,43,0.6); }
.ndd-pad:focus-within .lines {
  background-image: linear-gradient(180deg, transparent 0 28px, rgba(43,33,23,0.13) 28px 29px); }
.ndd-pad .bar { display: flex; align-items: center; gap: 10px; padding-top: 14px; }
.ndd-pad .tip { font: 11px var(--kai); color: var(--pencil); letter-spacing: 0.02em; }
.ndd-pad .att { width: 27px; height: 27px; border-radius: 50%; flex-shrink: 0;
  background: transparent; border: 1px solid rgba(43,33,23,0.2); color: var(--ink-2);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  transition: border-color 0.15s, color 0.15s; }
.ndd-pad .att:hover { border-color: var(--ink); color: var(--ink); }
.ndd-pad .att:disabled { opacity: 0.45; cursor: default; }
/* 没写字的时候是个空框，写了字才变成实心墨块 —— 淡一档的实心块看着像坏了 */
.ndd-pad .go { padding: 8px 22px; font: 700 14px var(--kai);
  letter-spacing: 0.3em; text-indent: 0.3em;
  background: var(--ink); color: #F5F0E4;
  border: 1px solid var(--ink); border-radius: 2px; cursor: pointer;
  transition: background 0.18s, color 0.18s, border-color 0.18s; }
.ndd-pad .go:disabled { background: transparent; color: var(--pencil);
  border-color: rgba(43,33,23,0.22); cursor: default; }

/* ===== 分区标题 ===== */
.ndd-head { display: flex; justify-content: space-between; align-items: baseline;
  margin: 44px 0 24px; }
.ndd-head h2 { position: relative; margin: 0;
  font: 700 20px var(--kai); letter-spacing: 0.08em; }
.ndd-head h2 svg { position: absolute; left: -2%; bottom: -8px; width: 104%; height: 8px; }
.ndd-head .n { font: 12.5px var(--kai); color: var(--pencil); letter-spacing: 0.06em; }

/* ===== 项目卡：钉在板上的纸 ===== */
.ndd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 36px 28px; }
.ndd-card { position: relative; }
/* 钉子不在纸里 —— 纸被拿起来的时候钉子不该跟着动 */
.ndd-card .pin { position: absolute; top: 3px; left: 50%; width: 9px; height: 9px;
  border-radius: 50%; margin-left: -4.5px; z-index: 6; pointer-events: none;
  background: radial-gradient(circle at 35% 30%, #8a7a62, #453a2c 65%);
  box-shadow: -1px 2px 3px rgba(43,33,23,0.45); }
.ndd-card .pin.r { background: radial-gradient(circle at 35% 30%, #b4544a, #7d241c 65%); }
.ndd-card > a { display: block; position: relative; padding: 15px 14px 12px;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.mid};
  text-decoration: none; color: inherit;
  transform: rotate(var(--rot, 0deg)); transform-origin: 50% 7px;
  transition: transform 0.28s cubic-bezier(0.25,1,0.5,1), box-shadow 0.28s; }
/* 挂在最上面那张贴得没那么平 */
.ndd-card.top > a { box-shadow: ${PAPER_SHADOW.near}; }
/* hover = 从桌上拿起来看：转正、抬起、影子摊开。
   触发点挂在整张卡上而不是 <a> 上 —— ⋯ 按钮是 <a> 的兄弟节点，鼠标移到它上面
   就不在 <a> 里了，纸会当场掉回去 */
.ndd-card:hover > a { transform: rotate(0deg) translateY(-5px);
  box-shadow: ${PAPER_SHADOW.near}; }

/* 封面 = 贴在纸上的印样，自己有一层薄影 */
.ndd-shot { position: relative; width: 100%; overflow: hidden; background: #EFEAE0;
  box-shadow: 0 1px 2px rgba(93,74,44,0.22), inset 0 0 0 1px rgba(43,33,23,0.07); }
.ndd-shot img { width: 100%; height: 100%; object-fit: cover; object-position: top;
  display: block; border: 0; }
/* 还没出东西：一张空白的横线纸，不是坏掉的灰块。
   不写字 —— 空白本身就说明了，「还没出东西」那句话由下面那行元信息说一次就够。 */
.ndd-shot.empty {
  background-color: #FBF7EC;
  background-image: repeating-linear-gradient(180deg, transparent 0 21px, rgba(43,33,23,0.05) 21px 22px);
  box-shadow: inset 0 0 0 1px rgba(43,33,23,0.06); }

.ndd-card .t { margin-top: 12px; font: 700 15.5px var(--kai); letter-spacing: 0.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ndd-card .m { margin-top: 5px; display: flex; justify-content: space-between;
  align-items: baseline; gap: 10px; font: 11.5px var(--kai); color: var(--pencil); }
.ndd-card .m span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 上次停在这：回访第一动作 */
.ndd-card .last { position: absolute; top: -10px; right: -7px; z-index: 7;
  padding: 2px 9px; font: 11.5px var(--kai); color: var(--red);
  background-color: var(--sticky); background-image: var(--grain);
  box-shadow: -1px 2px 3px rgba(93,74,44,0.22);
  transform: rotate(4deg); pointer-events: none; }
.ndd-card .more { position: absolute; top: 9px; right: 9px; z-index: 8;
  width: 26px; height: 26px; border-radius: 50%;
  background: rgba(255,254,246,0.94); border: 1px solid rgba(43,33,23,0.16);
  color: var(--ink-2); display: flex; align-items: center; justify-content: center;
  cursor: pointer; box-shadow: -1px 2px 4px rgba(93,74,44,0.2); }
.ndd-menu { position: absolute; top: 40px; right: 8px; z-index: 9; min-width: 132px;
  padding: 5px;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.near}; }
.ndd-menu button { width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; font: 13px var(--kai); color: var(--ink-2);
  background: transparent; border: none; text-align: left; cursor: pointer; }
.ndd-menu button:hover { background: rgba(43,33,23,0.055); color: var(--ink); }
.ndd-menu button.danger { color: var(--red); }
.ndd-menu button.danger:hover { background: rgba(168,54,43,0.08); }

/* ===== 最近对话（老式闪聊会话，没有就整块不出现）===== */
.ndd-rows { background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.far}; }
.ndd-rows a { display: flex; align-items: center; gap: 14px; padding: 12px 18px;
  text-decoration: none; color: inherit; transition: background 0.15s; }
.ndd-rows a:hover { background: rgba(43,33,23,0.03); }
.ndd-rows .sep { border-top: 1px solid rgba(43,33,23,0.08); }
.ndd-rows .t { font: 14px var(--kai); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.ndd-rows .w { margin-top: 2px; font: 11px var(--kai); color: var(--pencil); }
.ndd-rows .del { position: absolute; top: 50%; right: 14px; transform: translateY(-50%);
  width: 25px; height: 25px; border-radius: 50%; z-index: 3;
  background: rgba(255,254,246,0.95); border: 1px solid rgba(43,33,23,0.16);
  color: var(--ink-2); display: flex; align-items: center; justify-content: center;
  cursor: pointer; }
.ndd-rows .del:hover { color: var(--red); border-color: var(--red); }

/* ===== 空 / 出错：都是钉上去的一张纸 ===== */
.ndd-sheet { position: relative; max-width: 620px; margin: 0 auto;
  padding: 42px 40px 34px; text-align: center;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.mid};
  transform: rotate(0.4deg); transform-origin: 50% 8px; }
.ndd-sheet .pin { position: absolute; top: 8px; left: 50%; width: 9px; height: 9px;
  border-radius: 50%; margin-left: -4.5px;
  background: radial-gradient(circle at 35% 30%, #8a7a62, #453a2c 65%);
  box-shadow: -1px 2px 3px rgba(43,33,23,0.45); }
.ndd-sheet .h { font: 700 17px var(--kai); letter-spacing: 0.05em; }
.ndd-sheet .d { margin-top: 10px; font: 13.5px var(--kai); line-height: 1.85; color: var(--ink-2); }
.ndd-sheet .chips { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
  margin-top: 22px; }
.ndd-sheet .chips button { padding: 7px 16px; font: 13px var(--kai); color: var(--ink-2);
  background: transparent; border: 1px solid rgba(43,33,23,0.2); border-radius: 999px;
  cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.ndd-sheet .chips button:hover { border-color: var(--ink); color: var(--ink); }
.ndd-sheet .foot { margin-top: 22px; font: 12.5px var(--kai); color: var(--pencil);
  background: transparent; border: none; text-decoration: underline;
  text-underline-offset: 3px; cursor: pointer; }
.ndd-sheet .retry { margin-top: 20px; padding: 9px 26px; font: 700 14px var(--kai);
  letter-spacing: 0.24em; text-indent: 0.24em;
  background: var(--ink); color: #F5F0E4; border: none; border-radius: 2px; cursor: pointer; }
.ndd-quiet { padding: 60px 0; text-align: center; font: 13.5px var(--kai); color: var(--pencil); }
`;

export default function Home() {
  const navigate = useNavigate();
  const projects = useProjectStore(s => s.projects);
  const hydrated = useProjectStore(s => s.hydrated);
  const hydrating = useProjectStore(s => s.hydrating);
  const error = useProjectStore(s => s.error);
  const hydrate = useProjectStore(s => s.hydrate);
  const [createOpen, setCreateOpen] = useState(false);
  // 空状态示例 chip → 预填顶部输入框（不直接发 turn：让用户看到内容、可改可删）
  const [prefill, setPrefill] = useState(null);   // { text, ts }
  // 产物清单：读磁盘，跟列表分开拉；拿不到就是 null，卡片那行留空不编
  const [stats, setStats] = useState(null);
  const [summary, setSummary] = useState(null);   // { published, usedToday }

  useEffect(() => {
    if (!hydrated && !hydrating) {
      hydrate({ kind: 'project' }).catch(() => { /* error 由 store 记录 */ });
    }
  }, [hydrated, hydrating, hydrate]);

  useEffect(() => {
    let dead = false;
    Projects.stats()
      .then(({ stats: s, summary: sum }) => {
        if (dead) return;
        setStats(s || {});
        setSummary(sum || null);
      })
      .catch(() => { /* 首页不因为一行元信息报错 */ });
    return () => { dead = true; };
  }, []);

  const openCreate = () => setCreateOpen(true);

  return (
    <AppShell
      actions={
        <>
          <Link to="/gallery" style={iconBtnStyle}><LayoutTemplate size={14} /> 橱窗</Link>
          <Link to="/skills" style={iconBtnStyle}><Wrench size={14} /> Skill</Link>
          <button style={primaryBtnStyle} onClick={openCreate}>
            <Plus size={14} /> 新建项目
          </button>
        </>
      }
    >
      <div className="ndd">
        <style>{CSS}</style>
        <div className="ndd-in">

          <div className="ndd-top">
            <div className="ndd-side">
              <BoardNote projects={projects} summary={summary} />
            </div>
            <div className="ndd-mid">
              <QuickEntry prefill={prefill} />
            </div>
            <div className="ndd-side r">
              <img className="doodle" src={dTangle} alt="" />
              <p className="aside">想到什么先写下来。<br />不用先想清楚，<br />它会问你缺的那部分。</p>
            </div>
          </div>

          <RecentQuickSection />

          <div className="ndd-head">
            <h2>我的项目<Underline w={1.6} /></h2>
            <span className="n">{projects.length} 个项目</span>
          </div>

          {!hydrated && hydrating ? (
            <div className="ndd-quiet">正在打开…</div>
          ) : error ? (
            <ErrorState message={error} onRetry={() => hydrate({ kind: 'project' }).catch(() => {})} />
          ) : projects.length === 0 ? (
            <EmptyState
              onCreate={openCreate}
              onPick={(text) => {
                setPrefill({ text, ts: Date.now() });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          ) : (
            <div className="ndd-grid">
              {projects.map((p, i) => (
                <ProjectCard key={p.id} project={p} stat={stats?.[p.id]} newest={i === 0} />
              ))}
            </div>
          )}
        </div>
      </div>

      <CreateProjectModal
        show={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(proj) => {
          // 2026-07-27 起工作台是项目主页 —— 新建项目直接进画布
          navigate(`/projects/${proj.id}/work`);
        }}
      />
    </AppShell>
  );
}

// ── BoardNote ── 记在板子上的账（不是纸，是直接写在板面上的字）

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 1~31 的汉字写法。楷体里汉字数字比阿拉伯数字顺眼，跟登录墙上的写法一致 */
function cnNum(n) {
  if (n <= 10) return CN[n];
  if (n < 20) return `十${n % 10 ? CN[n % 10] : ''}`;
  return `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ''}`;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/**
 * 板上的账：全是真数，没有一个是摆设。
 * summary 还没回来就只写前两条（本地就能算的），不留空行也不填占位。
 */
function BoardNote({ projects, summary }) {
  const now = new Date();
  const touched = projects.filter((p) => {
    const t = Date.parse(p.updatedAt);
    return Number.isFinite(t) && now.getTime() - t < WEEK_MS;
  }).length;

  return (
    <div className="ndd-note">
      <span className="t">{cnNum(now.getMonth() + 1)}月{cnNum(now.getDate())}日</span>
      <svg className="rule" viewBox="0 0 104 7" preserveAspectRatio="none" aria-hidden="true">
        <path d="M1 4 Q 26 2, 52 4.2 T 103 3" fill="none"
          stroke="rgba(122,111,92,0.55)" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="l">手上 <span className="n">{projects.length}</span> 件</span>
      <span className="l">这周动过 <span className="n">{touched}</span> 件</span>
      {summary && (
        <>
          <span className="l">已上线 <span className="n">{summary.published}</span> 件</span>
          <span className="l">今天花了 <span className="n">${(summary.usedToday || 0).toFixed(2)}</span></span>
        </>
      )}
    </div>
  );
}

// ── QuickEntry ── 板上那本便签：一句话开工

/**
 * 随机问候语池。mount 时挑一条；按时间段（早/午/晚）+ 通用各占一半。
 * 写得轻松点，不要"AI 助手"那种正经话。整页是手写的语气，不放 emoji。
 */
const GREETINGS_GENERIC = [
  '今天想做点什么？',
  '嗨，想做个什么东西？',
  '说一句，我帮你画出来',
  '灵感来了？敲下来试试',
  '随便聊聊，看能做出什么',
  '把脑子里那张图描述一下',
  '今天想折腾点什么？',
];
const GREETINGS_MORNING = ['早，今天先做哪个？', '早上好，想做什么？'];
const GREETINGS_AFTERNOON = ['下午想做点什么？', '午后小憩，做点什么？'];
const GREETINGS_EVENING = ['晚上有想做的吗？说说看', '深夜灵感最值钱，敲下来'];

function pickGreeting() {
  const h = new Date().getHours();
  let pool = GREETINGS_GENERIC;
  if (h >= 6 && h < 11) pool = pool.concat(GREETINGS_MORNING);
  else if (h >= 13 && h < 18) pool = pool.concat(GREETINGS_AFTERNOON);
  else if (h >= 21 || h < 4) pool = pool.concat(GREETINGS_EVENING);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 输入框 placeholder 例子池——给用户一个具体的起点示例，比"agent 自己判断…"
 * 那种过程描述更直观。mount 时随机挑一条。
 */
const PLACEHOLDER_EXAMPLES = [
  '比如：给我的新歌做一个歌词视觉页',
  '比如：春节活动海报，暖色调',
  '比如：作品集主页，安静一点的',
  '比如：同人本的宣传图，暗色系',
  '比如：一篇长文的阅读页，衬线字',
  '比如：把这半年做的东西整理成一份 deck',
  '想画个什么？说说看',
  '把脑子里的画面写下来…',
];

function pickPlaceholder() {
  return PLACEHOLDER_EXAMPLES[Math.floor(Math.random() * PLACEHOLDER_EXAMPLES.length)];
}

function QuickEntry({ prefill }) {
  const navigate = useNavigate();
  const createProject = useProjectStore(s => s.createProject);
  const showToast = useGlobalStore(s => s.showToast);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [greeting] = useState(pickGreeting);  // mount 时挑一次，刷新换一个
  const [placeholder] = useState(pickPlaceholder);
  // 暂存附件（QuickEntry 阶段还没 project，只能存 File 对象，submit 时再 createProject + 上传）
  // chip 形态：path/error 都 undefined → ComposerTray 显示 "上传中…"（实际是"待上传"，hover 看 title）
  const [attachments, setAttachments] = useState([]);
  // [{ id, type:'asset', name, size, mime, _file: File }]
  const ref = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // 上限取 29 的整数倍（10 行），不然长文本撑到顶时最后一格会被切掉半条线
    el.style.height = Math.min(el.scrollHeight, 290) + 'px';
  }, [text]);

  // 空状态示例 chip 点击 → 填入并聚焦（ts 变化允许重复点同一条）
  useEffect(() => {
    if (!prefill?.text) return;
    setText(prefill.text);
    ref.current?.focus();
  }, [prefill]);

  const handlePickFile = (file) => {
    const tempId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setAttachments(arr => [...arr, {
      id: tempId, type: 'asset',
      name: file.name, size: file.size, mime: file.type,
      _file: file,  // 暂存 File 等 submit 时统一上传
      // 图片给托盘出缩略图；移除 / submit 跳走时 revoke
      previewUrl: (file.type || '').startsWith('image/')
        ? URL.createObjectURL(file) : undefined,
    }]);
  };
  const handleRemoveAtt = (id) => setAttachments(arr => {
    const it = arr.find(a => a.id === id);
    if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
    return arr.filter(a => a.id !== id);
  });

  const submit = async () => {
    const v = text.trim();
    if (!v || submitting) return;
    setSubmitting(true);
    try {
      // 1. 直接建**真项目**（2026-07-28：首页不再有"闪聊"这个二等公民）。
      //    名字先用用户这句话垫着，标 autoNamed —— 第一轮跑完服务端会用 SDK helper
      //    写的会话摘要正名一次，用户之后随时可以在项目里「⋯ → 重命名」改。
      const projName = v.slice(0, 24) + (v.length > 24 ? '…' : '');
      const proj = await createProject({
        name: projName || '新项目',
        autoNamed: true,
      });
      // 2. 上传暂存的附件到新 project（单文件失败不阻塞其他，让用户看到 toast 自决）
      const ready = [];
      for (const a of attachments) {
        if (!a._file) continue;
        try {
          const { asset } = await Assets.upload(proj.id, a._file);
          ready.push({ type: 'asset', path: asset.path, name: asset.name, size: asset.size, mime: asset.mime });
        } catch (err) {
          showToast(`${a.name} 上传失败：${err.message}`, 'error');
        }
      }
      // 3. 跳 Workspace 把首条消息 + attachments 塞 location.state；ProjectWorkspace 的
      //    initialMessage useEffect（mount 后 250ms 等 WS 上线）单点负责发首条 turn。
      //    旧实现这里也调 Turn.send 预发一条 → 后端 isNewSession=true 起 session A，
      //    Workspace 上线后又发一条 → 起 session B，导致每次闪聊创 2 个 session。
      // 附件已消费（上传完/失败都算），objectURL 在跳走前回收 —— SPA 跳转
      // 不卸载页面，不收会一直挂到刷新
      attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      navigate(`/projects/${proj.id}/work`, {
        state: { initialMessage: v, attachments: ready },
      });
    } catch (err) {
      showToast(`创建失败：${err.message}`, 'error');
      setSubmitting(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isImeEnter(e)) return;
      e.preventDefault();
      submit();
    }
  };

  const empty = !text.trim();

  return (
    <>
      <div className="ndd-greet">{greeting}</div>
      {/* 点纸上任何空白都算点进输入框 —— 左边那条页边、上下留白、横线下面那片
          都是纸的一部分，点了没反应会让人以为"这纸不能写" */}
      <div
        className="ndd-pad"
        onMouseDown={(e) => {
          if (e.target.closest('button, textarea, input, a')) return;
          e.preventDefault();
          ref.current?.focus();
        }}
      >
        <Clip cx="14%" />
        {/* 横线跟 textarea 严丝合缝地同高，见 .ndd-pad .lines 的注释 */}
        <div className="lines">
          <textarea
            ref={ref}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder}
            rows={1}
            disabled={submitting}
            style={{ opacity: submitting ? 0.5 : 1 }}
          />
        </div>
        <ComposerTray items={attachments} onRemove={handleRemoveAtt} />
        <div className="bar">
          <button
            className="att"
            title="上传附件（图片 / PDF / HTML / 等）"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
          >
            <Plus size={14} />
          </button>
          <span className="tip">Enter 发送 · Shift + Enter 换行</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.pptx,.docx,.html,.htm,.png,.jpg,.jpeg,.svg,.webp,.md,.txt"
            onChange={(e) => {
              Array.from(e.target.files || []).forEach(handlePickFile);
              e.target.value = '';
            }}
            style={{ display: 'none' }}
          />
          <span style={{ flex: 1 }} />
          <button
            className="go"
            onClick={submit}
            disabled={empty || submitting}
            title={submitting ? '创建中…' : '发送（Enter）'}
          >
            {submitting ? '开 工 中' : '开 工'}
          </button>
        </div>
      </div>
    </>
  );
}

// ── RecentQuickSection ── 老式闪聊会话（2026-07-28 前建的），没有就整块不出现

function RecentQuickSection() {
  const [sessions, setSessions] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Sessions.recent({ limit: 5, kind: 'quick' })
      .then(({ sessions: list = [] }) => {
        if (!cancelled) {
          setSessions(list);
          setLoaded(true);
        }
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);

  const handleDelete = async (s) => {
    const title = s.customTitle || s.summary || s.firstPrompt || s.projectName || '未命名对话';
    if (!(await confirm({
      title: '删除对话',
      message: `删除对话「${title}」？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await Sessions.remove(s.projectId, s.sessionId);
      setSessions(prev => prev.filter(x => x.sessionId !== s.sessionId));
      showToast('已删除', 'info');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  if (!loaded || sessions.length === 0) return null;

  return (
    <>
      <div className="ndd-head">
        <h2>最近对话<Underline w={1.6} /></h2>
      </div>
      <div className="ndd-rows">
        {sessions.map((s, i) => (
          <RecentQuickRow
            key={`${s.projectId}/${s.sessionId}`}
            session={s}
            isFirst={i === 0}
            onDelete={() => handleDelete(s)}
          />
        ))}
      </div>
    </>
  );
}

function RecentQuickRow({ session: s, isFirst, onDelete }) {
  const [hover, setHover] = useState(false);
  const handleDeleteClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    onDelete?.();
  };
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative' }}
    >
      <Link
        to={`/projects/${s.projectId}/sessions/${s.sessionId}`}
        className={isFirst ? '' : 'sep'}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">
            {s.customTitle || s.summary || s.firstPrompt || s.projectName || '未命名对话'}
          </div>
          <div className="w">
            最后消息 {s.lastModified ? timeAgo(new Date(s.lastModified).toISOString()) : ''}
          </div>
        </div>
        <span style={{ color: 'var(--pencil)', fontSize: 15, width: 26, textAlign: 'right',
          opacity: hover ? 0 : 1, transition: 'opacity 0.15s' }}>›</span>
      </Link>
      {hover && (
        <button className="del" onClick={handleDeleteClick} title="删除对话">
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

// ── ProjectCard ── 钉在板上的一张纸

function ProjectCard({ project, stat, newest }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const prompt = useGlobalStore(s => s.prompt);

  const handleRename = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    const next = await prompt({
      title: '重命名项目',
      initialValue: project.name,
      placeholder: '项目名',
      validate: (v) => v.trim() ? null : '不能为空',
    });
    if (!next || !next.trim() || next === project.name) return;
    try {
      await updateProject(project.id, { name: next.trim() });
      showToast(`已重命名为「${next.trim()}」`, 'success');
    } catch (err) {
      showToast(`重命名失败：${err.message}`, 'error');
    }
  };
  const handleDuplicate = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    try {
      const copy = await duplicateProject(project.id);
      if (copy) showToast(`已复制为「${copy.name}」`, 'success');
    } catch (err) {
      showToast(`复制失败：${err.message}`, 'error');
    }
  };
  const handleDelete = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    if (!(await confirm({
      title: '删除项目',
      message: `删除「${project.name}」？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await deleteProject(project.id);
      showToast('项目已删除', 'info');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  const inv = inventory(stat);

  return (
    <div
      className={`ndd-card${newest ? ' top' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setMenuOpen(false); }}
    >
      <Link to={`/projects/${project.id}/work`} style={{ '--rot': tilt(project.id) }}>
        <ThumbnailBox project={project} />
        <div className="t">{project.name}</div>
        <div className="m">
          <span>{inv || ''}</span>
          <span>{timeAgo(project.updatedAt)}</span>
        </div>
      </Link>
      <span className={`pin${newest ? ' r' : ''}`} />
      {newest && <span className="last">接着做</span>}

      {hover && (
        <button
          className="more"
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}

      {menuOpen && (
        <div className="ndd-menu" onMouseDown={e => e.stopPropagation()}>
          <button onClick={handleRename}><Edit2 size={12} /> 重命名</button>
          <button onClick={handleDuplicate}><Copy size={12} /> 复制</button>
          <button className="danger" onClick={handleDelete}><Trash2 size={12} /> 删除</button>
        </div>
      )}
    </div>
  );
}

/**
 * 缩略图：服务端截的封面图（GET /api/projects/:pid/cover）
 *
 * 两版演进（2026-07-30）：
 *   老版 iframe 挂 sessions/<sid>/canvas.html —— 形态注册表落地后产物搬进
 *   tasks/<任务>/，这条路只剩后端占位页，封面于是常年一片灰。
 *   改成 iframe 指向真实产物后又撞第二个坎：sandbox 不给 allow-scripts（一屏
 *   十几张卡不能各跑一遍动画/3D），凡是靠 JS 出画面的产物照样白板。
 *   最终落在服务端截图：脚本在 chromium 里真跑一次，浏览器只收一张 JPEG。
 *
 * 画幅：出图比例由产物形态决定（deck 是画幅本身，site 是 1440×900 首屏），
 * 前端不预设——onLoad 读 naturalWidth/Height 拿真实比例再定容器，加载前用
 * 16:10 占位。204（没产物 / 截图环境不可用）走空白纸。
 */
const DEFAULT_RATIO = 16 / 10;

function ThumbnailBox({ project }) {
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  const [failed, setFailed] = useState(false);

  useEffect(() => { setFailed(false); }, [project.id]);

  if (failed) {
    return <div className="ndd-shot empty" style={{ aspectRatio: String(DEFAULT_RATIO) }} />;
  }

  return (
    <div className="ndd-shot" style={{ aspectRatio: String(ratio) }}>
      <img
        src={Assets.coverUrl(project.id)}
        alt={`${project.name} 预览`}
        loading="lazy"
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          // 空响应（204）在部分浏览器也会触发 load，宽高为 0 → 当没封面
          if (!w || !h) setFailed(true);
          else setRatio(w / h);
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="ndd-sheet">
      <span className="pin" />
      <div className="h" style={{ color: 'var(--red)' }}>项目没加载出来</div>
      <div className="d">{message || '后端可能没启动。检查 server 是否在 :4001 上跑。'}</div>
      <button className="retry" onClick={onRetry}>再 试</button>
    </div>
  );
}

/**
 * 空状态（新号第一眼）：光说「还没有项目」新人不知道这东西能做什么。
 * 给几个可点的示例 prompt —— 点了只预填顶部输入框（可改可删），不直接开跑。
 */
const EMPTY_EXAMPLES = [
  '给我喜欢的歌做一个歌词视觉页',
  '做一个收集我笔下角色设定的档案站',
  '春节活动海报，暖色调',
  '把这半年做的东西整理成一份介绍 deck',
];

function EmptyState({ onCreate, onPick }) {
  return (
    <div className="ndd-sheet">
      <span className="pin" />
      <div className="h">还没有作品</div>
      <div className="d">在上面写一句话就能开工。<br />没想好的话，点一个试试：</div>
      <div className="chips">
        {EMPTY_EXAMPLES.map((text) => (
          <button key={text} onClick={() => onPick?.(text)}>{text}</button>
        ))}
      </div>
      <button className="foot" onClick={onCreate}>或者从「+ 新建项目」开始一件长期的事</button>
    </div>
  );
}

// 顶栏按钮：顶栏是全站共用的外壳，沿用它自己那套 token，不跟着这一页换纸
const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontSize: FONT_SIZE.lg, color: CHROME.ink2,
  padding: `${GAP.sm}px ${GAP.lg}px`,
  borderRadius: RADIUS.lg,
  background: 'transparent',
};

const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontSize: FONT_SIZE.lg, fontWeight: 700,
  color: COLOR.btnText, background: COLOR.btn,
  padding: `${GAP.sm + 1}px ${GAP.xl}px`,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: RADIUS.lg,
};
