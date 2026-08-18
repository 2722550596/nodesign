import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ArrowLeft, RotateCw, Hand, Play, Loader2, Globe } from 'lucide-react';
import { COLOR, CANVAS, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import ArtifactWindow from './ArtifactWindow.jsx';

/**
 * BrowserWindow —— 播放 agent 当前的浏览器画面，必要时你接手（2026-08-18）
 *
 * ## 它跟另外三扇窗的根本区别
 *
 * deck / 站点 / word 都是**产物**：落盘的文件、进 kinds 注册表、上画布当卡片。
 * 这扇窗**不是产物**，是**会话级的临时活物** —— agent 正在看什么。所以它不进
 * board.json、不进 kinds、没有导出、关掉就没了。这条判断省掉了一大票接入改动
 * （artifact-target / export-collect / board-relations / ArtifactCard …），
 * 而且它本来就该是这个性质：你不会想在桌面上永久摆着一张"某次浏览"的卡片。
 *
 * ## 画面怎么来
 *
 * 专用 WS `/ws/projects/:pid/browser`，**二进制帧**（JPEG）直接 `createImageBitmap`
 * 画到 canvas。不走主 WS：那条是纯下行 + EventBus 广播 + 2000 条重放缓冲，
 * 高频帧灌进去会冲爆重放缓冲、混进 hydrate 回放，而且 base64 + zlib 白压一遍。
 *
 * ⭐ **不看就不订阅**：窗关掉、或者浏览器标签切走（`document.hidden`）就发
 * unsubscribe，服务端立刻 `stopScreencast`。这不是省流量，是省那台 1 vCPU 机器的核。
 */

/** 接手时鼠标坐标要转成 0..1 的比例发给服务端 —— 它比我们清楚页面的设备像素 */
function relPos(canvasEl, evt) {
  const r = canvasEl.getBoundingClientRect();
  return {
    rx: Math.min(1, Math.max(0, (evt.clientX - r.left) / r.width)),
    ry: Math.min(1, Math.max(0, (evt.clientY - r.top) / r.height)),
  };
}

export default function BrowserWindow({ projectId, url, help, onClose, onToolbarGroups }) {
  const [status, setStatus] = useState('connecting');   // connecting|live|idle|error|closed
  const [note, setNote] = useState(null);
  const [addr, setAddr] = useState(url || '');
  const [takeover, setTakeover] = useState(false);
  const [gotFrame, setGotFrame] = useState(false);
  // 刷新后 hello 帧补回来的求助文案（prop 那份来自一次性事件，刷新即失传）
  const [liveHelp, setLiveHelp] = useState(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const takeoverRef = useRef(false);
  takeoverRef.current = takeover;

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }, []);

  // ── WS 生命周期 ──
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/projects/${encodeURIComponent(projectId)}/browser`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => { setStatus('connecting'); ws.send(JSON.stringify({ type: 'subscribe' })); };
    ws.onclose = (e) => { setStatus(e.code === 4401 ? 'error' : 'closed'); if (e.code === 4401) setNote('没有权限'); };
    ws.onerror = () => setStatus('error');
    ws.onmessage = async (e) => {
      if (typeof e.data !== 'string') {
        // 二进制 = 一帧 JPEG
        const cv = canvasRef.current;
        if (!cv) return;
        try {
          const bmp = await createImageBitmap(new Blob([e.data], { type: 'image/jpeg' }));
          if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
          cv.getContext('2d')?.drawImage(bmp, 0, 0);
          bmp.close?.();
          setGotFrame(true);
          setStatus('live');
        } catch { /* 坏帧丢掉，下一帧就好 */ }
        return;
      }
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'subscribed') { setStatus('live'); if (msg.url) setAddr(msg.url); }
      // hello 带着「agent 是不是正举着手」—— 刷新后 banner 靠它回来（一次性事件已经过去了）
      if (msg.type === 'hello' && msg.help) setLiveHelp(msg.help);
      if (msg.type === 'released') setLiveHelp(null);
      if (msg.type === 'idle') { setStatus('idle'); setNote(msg.reason); }
      if (msg.type === 'error') { setStatus('error'); setNote(msg.reason); }
      if (msg.type === 'closed') { setStatus('closed'); setNote(msg.reason); }
      if (msg.type === 'url') setAddr(msg.url || '');
    };

    // ⭐ 切走标签页就退订：省的是服务器那颗核，不是流量
    const onVis = () => send({ type: document.hidden ? 'unsubscribe' : 'subscribe' });
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      try { ws.send(JSON.stringify({ type: 'unsubscribe' })); } catch { /* */ }
      ws.close();
      wsRef.current = null;
    };
  }, [projectId, send]);

  useEffect(() => { if (url) setAddr(url); }, [url]);

  // ── 接手：鼠标/键盘 → WS ──
  useEffect(() => {
    if (!takeover) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const onClick = (e) => { e.preventDefault(); send({ type: 'input', kind: 'click', ...relPos(cv, e) }); };
    const onWheel = (e) => { e.preventDefault(); send({ type: 'input', kind: 'wheel', ...relPos(cv, e), dx: e.deltaX, dy: e.deltaY }); };
    const onKey = (e) => {
      // ⚠️ Phase 1 不接输入法：中文输入要按 composer 那套 isIme 判定处理，
      // 现在按下去只会把半成品拼音塞过去。要输中文请在自己浏览器里做。
      if (e.isComposing) return;
      if (e.key.length === 1) { e.preventDefault(); send({ type: 'input', kind: 'key', text: e.key }); return; }
      if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        send({ type: 'input', kind: 'key', key: e.key });
      }
    };
    cv.addEventListener('click', onClick);
    cv.addEventListener('wheel', onWheel, { passive: false });
    // ⚠️ **挂在画面上，不是 window 上**。挂 window 的话接手一开，用户自己的聊天
    // 输入框就打不出字了 —— 每一次击键都被 preventDefault 掉送进第三方页面。
    // canvas 拿得到键盘事件的前提是它可聚焦（tabIndex）+ 真的被聚焦，所以下面
    // 顺手 focus() 一下：接手时焦点本来就该在这块画面上。
    cv.addEventListener('keydown', onKey);
    cv.focus?.();
    return () => {
      cv.removeEventListener('click', onClick);
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('keydown', onKey);
    };
  }, [takeover, send]);

  const groups = useMemo(() => [
    // 地址是**读数不是输入框**：给人一个能敲 URL 的地方等于给一条绕过出网闸的
    // 错觉（闸在网络层照样拦，但不如不提供这个入口）。
    {
      id: 'addr',
      node: (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: `0 ${GAP.sm}px`, maxWidth: 420, fontFamily: FONT_MONO,
          fontSize: FONT_SIZE.xs, color: COLOR.text2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'text',
        }}>
          <Globe size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
          {addr || '（还没打开页面）'}
        </span>
      ),
    },
    {
      id: 'nav',
      items: [
        { id: 'back', icon: ArrowLeft, title: '后退', onClick: () => send({ type: 'nav', action: 'back' }) },
        { id: 'reload', icon: RotateCw, title: '刷新', onClick: () => send({ type: 'nav', action: 'reload' }) },
      ],
    },
    {
      id: 'takeover',
      items: [{
        id: 'hand',
        icon: takeover ? Play : Hand,
        title: takeover
          ? '好了继续 —— 把控制权交回 agent（它正等着）'
          : '我来接手 —— 点击/滚动/打字会直接发到那个浏览器里',
        active: takeover,
        onClick: () => {
          if (takeover) { send({ type: 'release' }); setTakeover(false); }
          else setTakeover(true);
        },
      }],
    },
  ], [addr, takeover, send]);

  const stateLine = {
    connecting: '连接中…',
    live: null,
    idle: note || 'agent 还没开始浏览',
    error: note || '出错了',
    closed: note || '浏览器已经关了',
  }[status];

  return (
    <ArtifactWindow
      kind="browse"
      title="agent 的浏览器"
      subtitle={takeover ? '你在接手' : (status === 'live' ? '实时' : null)}
      onClose={onClose}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
      banner={(help || liveHelp) ? (
        <span>
          <b>agent 需要你帮个手</b>：{help || liveHelp}
          　—— 点工具栏上的<b>手形按钮</b>接手，弄完再点一次（变成 ▶）把控制权交回去。
          它正停在那儿等你。
        </span>
      ) : null}
      contentStyle={{ background: CANVAS.paper }}
    >
      <div style={{
        height: '100%', width: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: GAP.md, boxSizing: 'border-box', position: 'relative',
      }}>
        <canvas
          ref={canvasRef}
          tabIndex={takeover ? 0 : -1}
          title={takeover ? '接手中：点一下这块画面再打字（键盘只在这里生效）' : undefined}
          style={{
            maxWidth: '100%', maxHeight: '100%', display: gotFrame ? 'block' : 'none',
            background: '#fff', borderRadius: 2,
            boxShadow: '0 2px 12px rgba(43,39,35,.18)',
            cursor: takeover ? 'pointer' : 'default',
            outline: takeover ? `2px solid ${COLOR.accent || '#8a4b2d'}` : 'none',
            outlineOffset: 3,
          }}
        />
        {(!gotFrame || stateLine) && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: GAP.sm,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, textAlign: 'center',
          }}>
            {status === 'connecting' && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />}
            <span>{stateLine || '等第一帧…'}</span>
            {status === 'idle' && (
              <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.xs, maxWidth: 360, lineHeight: 1.7 }}>
                让 agent 去看一个站（它有 browser_navigate），这里就会亮起来。
                静止的页面不会一直传帧 —— 画面不动是正常的，不是卡住了。
              </span>
            )}
          </div>
        )}
      </div>
    </ArtifactWindow>
  );
}
