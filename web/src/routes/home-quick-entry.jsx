/**
 * QuickEntry —— 首页板子上那本便签：一句话（或者一张图）开工。
 *
 * 2026-08-17 从 Home.jsx 拆出来（行数棘轮）。上一次拆走的是样式表
 * （home-styles.js）—— 这一次拆走的是整个"开工"入口：它自己有输入、附件托盘、
 * 模型选择、建项目和上传三步串联，跟首页剩下那些**只是把数据摆出来**的卡片
 * 不是一个量级的东西。
 *
 * 皮全在 home-styles.js 的 .ndd-pad 那一段，这里只有行为。
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import ComposerTray from '../components/chat/ComposerTray.jsx';
import ModelPicker from '../components/chat/ModelPicker.jsx';
import { isImeEnter } from '../lib/helpers.js';
import { Clip } from '../components/PaperBits.jsx';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Assets } from '../lib/api.js';


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

export default function QuickEntry({ prefill }) {
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
    // 只传附件不打字也能开工（2026-08-17，issue #1 第 8 条）
    if ((!v && attachments.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      // 1. 直接建**真项目**（2026-07-28：首页不再有"闪聊"这个二等公民）。
      //    名字先用用户这句话垫着，标 autoNamed —— 第一轮跑完服务端会用 SDK helper
      //    写的会话摘要正名一次，用户之后随时可以在项目里「⋯ → 重命名」改。
      //    一个字没写时拿第一个附件的名字垫，比"新项目"认得出来。
      const seed = v || attachments[0]?.name || '';
      const projName = seed.slice(0, 24) + (seed.length > 24 ? '…' : '');
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
      // 一个字没写、附件又全传失败：项目已经建出来了，照旧进去，但得说一声
      // 为什么进去之后什么都没发生
      if (!v && ready.length === 0) {
        showToast('附件都没传上去，进项目后可以重新上传再说', 'error');
      }
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

  const empty = !text.trim() && attachments.length === 0;

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
          {/* 空框时的邀请光标：一根闪的红竖线蹲在起笔位（原生 caret 这时让位，
              见 .ndd-pad textarea.empty）。placeholder 前面的 en space 是给它
              腾的位，所以第一个字落下来不会横跳 */}
          {!text && <span className="caret" aria-hidden="true" />}
          <textarea
            ref={ref}
            className={text ? undefined : 'empty'}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKey}
            placeholder={`\u2002${placeholder}`}
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
          {/* 模型选择（2026-08-17，issue #1 第 7 条）：以前只长在会话里的 composer 上，
              首页这一步反而没有 —— 而首页恰恰是**唯一**能决定新会话用哪个模型的地方
              （进了会话之后模型的真相在服务端，这颗按钮改的是本地偏好）。
              往下开：这张纸贴着页顶，往上开会顶出视口。 */}
          <ModelPicker className="model" menuPlacement="down" disabled={submitting} />
          <span className="tip">Enter 发送 · Shift + Enter 换行</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.pptx,.docx,.html,.htm,.png,.jpg,.jpeg,.svg,.webp,.md,.txt,.json"
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
