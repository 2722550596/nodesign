/**
 * 演出.js —— 演出页的管线（NoDesign RP，2026-08-15）
 *
 * ⭐ **照抄进演出文件夹，一个字都别改。** 这里面全是协议和踩过的坑，不是设计。
 * 页面负责长什么样（`画` 里那几个函数随便写），这个文件负责让它能玩：
 *
 *   URL 自省 · 铺场 · SSE 跨分片解析 · 错误话术 · 中断 · 输入法回车 ·
 *   滚动锚定 · 摘要折叠提示 · 隐私声明 · 探针模式
 *
 * ⚠️ **必须用 classic script 引**：`<script src="演出.js"></script>`，
 * **不能写 type="module"** —— agent 自检截图走 `file://` 打开页面，ES module
 * 在 file: 下被当跨源拦掉（origin 是 null），整页脚本会一起死。
 *
 * ## 怎么用
 *
 *   const 场 = ND演出.挂载({
 *     台: document.getElementById('台'),        // 滚动容器
 *     输入: document.getElementById('输入'),     // 可选，给了就接管回车
 *     发送钮: document.getElementById('发送'),   // 可选，给了就接管点击与禁用态
 *     画: {
 *       用户: (文) => {…; return 节点},          // 画一条用户消息
 *       演出: () => ({ 写(全文), 完成(全文), 撤() }),  // 画一条演出气泡，返回把手
 *       提示: (文) => {…},                       // 灰字提示（摘要折叠、探针说明）
 *       出错: (文) => {…},                       // 错误条
 *     },
 *   });
 *   // 想自己接管发送按钮就调 场.发送(文本)；想中断当前这轮调 场.中断()
 *
 * `画.演出()` 返回的把手：`写(全文)` 每来一片调一次（给的是**到目前为止的全文**，
 * 不是增量，页面直接 textContent = 全文 最省事）；`完成(全文)` 收尾调一次；
 * `撤()` 出错时把这条气泡拿掉。
 */
(function (global) {
  'use strict';

  /** 端点上限，跟服务端 MAX_INPUT_CHARS 对齐 */
  var 输入上限 = 8000;

  /** 样例台账：探针模式下渲这个，真台账一个字都不取 */
  var 样例 = [
    { role: 'assistant', text: '〔样例〕雾夜里，摊子上的豆油灯亮着。' },
    { role: 'user', text: '〔样例〕我走近摊子。' },
  ];

  /**
   * 从页面 URL 认出项目和演出文件夹。
   * 线上是 `/api/projects/<pid>/artifact-file/<dir>/index.html`；
   * file:// 打开时认不出来 —— 那是探针模式，不是坏了。
   */
  function 自省() {
    var m = location.pathname.match(/^\/api\/projects\/([^/]+)\/artifact-file\/(.+)$/);
    if (!m) return { pid: null, dir: null };
    // ⚠️ pathname 是**已经百分号编码**的：中文文件夹名在这儿长成 %E6%A8%A1…，
    // 不解码就会在 encodeURIComponent 时二次编码，服务端收到 %25E6… 直接 404。
    // 逐段解码（'/' 是分隔符，不能整串解）。这个产品的文件夹名默认就是中文，
    // 所以这一步不是边角情况，是主路径。
    var dir = m[2].split('/').slice(0, -1).map(decodeURIComponent).join('/');
    return { pid: m[1], dir: dir };
  }

  /**
   * 隐私声明自检：页面上没有 `<meta name="nd-privacy">` 就现补一条。
   *
   * 这道防线不能指望"皮肤作者记得写"—— 平台据它把标注里的文本剥成占位符再发给
   * agent。三张真页面里只有一张带着它（2026-08-15 查实），所以责任内建在管线里。
   */
  function 保证隐私声明() {
    if (document.querySelector('meta[name="nd-privacy"]')) return;
    var meta = document.createElement('meta');
    meta.setAttribute('name', 'nd-privacy');
    meta.setAttribute('content', '演出');
    (document.head || document.documentElement).appendChild(meta);
  }

  /** 用户是不是本来就贴着底：只有贴着底才跟随滚动，不然会把正在往上翻的人拽回来 */
  function 贴底(台) {
    if (!台) return false;
    return 台.scrollHeight - 台.scrollTop - 台.clientHeight < 40;
  }
  function 跟随(台, 要跟) {
    if (台 && 要跟) 台.scrollTop = 台.scrollHeight;
  }

  /** 输入法回车判定：组字中的回车不是发送（10 处踩过的同一个坑） */
  function 是输入法回车(e) {
    return e.isComposing || e.keyCode === 229 || e.which === 229;
  }

  function 话术(status, 服务端说的) {
    if (服务端说的) return 服务端说的;                 // 服务端的话最准，优先用
    if (status === 409) return '这场演出正有一轮在跑，等它回完';
    if (status === 429) return '太快了，或者额度用完了，歇一会儿';
    if (status === 403) return '这个账号还没开通演出通路';
    if (status === 404) return '找不到这场演出的文件夹';
    if (status === 422) return '这一轮没被接受（输入是空的或者太长）';
    return '出错了（' + status + '）';
  }

  function 挂载(选项) {
    var 台 = 选项.台 || null;
    var 输入 = 选项.输入 || null;
    var 发送钮 = 选项.发送钮 || null;
    var 画 = 选项.画 || {};
    var 当摘要 = 选项.当摘要 || function () {};
    var 当状态 = 选项.当状态 || function () {};

    保证隐私声明();

    var 址 = 自省();
    var 探针 = location.protocol === 'file:'
      || new URLSearchParams(location.search).has('nd_probe')
      || !址.pid;
    var 跑着 = false;
    var 控制器 = null;

    function api(路) {
      return '/api/projects/' + 址.pid + '/chatai/' + 路;
    }
    function 忙(值) {
      跑着 = 值;
      if (发送钮) 发送钮.disabled = 值;
      当状态(值 ? '跑着' : '闲着');
    }

    /** 开场铺台账。探针模式渲样例，绝不打网络。 */
    async function 铺场() {
      if (探针) {
        样例.forEach(function (r) {
          if (r.role === 'user') 画.用户(r.text);
          else { var h = 画.演出(); h.完成(r.text); }
        });
        if (画.提示) 画.提示('（探针模式：样例台账，没有读真实记录）');
        跟随(台, true);
        return;
      }
      try {
        var r = await fetch(api('log') + '?dir=' + encodeURIComponent(址.dir));
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) { if (画.出错) 画.出错(话术(r.status, j.error)); return; }
        (j.records || []).forEach(function (rec) {   // 端点给的就叫 records
          if (rec.role === 'user') 画.用户(rec.text);
          else { var h = 画.演出(); h.完成(rec.text); }
        });
        跟随(台, true);
      } catch (e) {
        if (画.出错) 画.出错('读不到台账：' + (e && e.message ? e.message : '网络断了'));
      }
    }

    /** 发一轮。文本从参数来（没给就从输入框取），走 SSE。 */
    async function 发送(文本) {
      var text = String(文本 != null ? 文本 : (输入 ? 输入.value : '')).trim();
      if (!text || 跑着) return;
      if (text.length > 输入上限) {
        if (画.出错) 画.出错('这段太长了（上限 ' + 输入上限 + ' 字）');
        return;
      }
      忙(true);
      var 要跟 = 贴底(台);
      画.用户(text);
      跟随(台, 要跟);
      if (输入) 输入.value = '';

      if (探针) {                                   // 探针模式不打网络，回一句样例
        var 样 = 画.演出();
        样.完成('〔样例〕摊主抬头看了你一眼，没说话。');
        跟随(台, 要跟);
        忙(false);
        return;
      }

      var 手 = 画.演出();
      var 还回去 = function (话) {
        if (手.撤) 手.撤();
        if (画.出错) 画.出错(话);
        if (输入 && !输入.value) 输入.value = text;   // 失败把话还给用户，别让他重打
        忙(false);
      };

      控制器 = new AbortController();
      var res;
      try {
        res = await fetch(api('turn'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: 址.dir, input: text }),
          signal: 控制器.signal,
        });
      } catch (e) {
        return 还回去(e && e.name === 'AbortError' ? '这一轮中断了' : '网络断了，稍后重发');
      }
      if (!res.ok) {
        var j2 = await res.json().catch(function () { return {}; });
        return 还回去(话术(res.status, j2.error));
      }

      // SSE：`data: {...}\n\n`。⚠️ 一个事件会跨 chunk 到（中转站分片很粗），
      // 所以必须按 '\n\n' 切、把最后半截留在缓冲里，不能逐 chunk 解析。
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var 全文 = '';
      var 出过错 = false;
      try {
        while (true) {
          var 步 = await reader.read();
          if (步.done) break;
          buf += dec.decode(步.value, { stream: true });
          var 块 = buf.split('\n\n');
          buf = 块.pop();
          for (var i = 0; i < 块.length; i++) {
            var 行 = 块[i].split('\n').filter(function (l) { return l.indexOf('data:') === 0; })[0];
            if (!行) continue;
            var ev;
            try { ev = JSON.parse(行.slice(5)); } catch (e) { continue; }
            if (ev.delta) { 全文 += ev.delta; 手.写(全文); 跟随(台, 要跟); }
            if (ev.error) { 出过错 = true; 还回去(ev.error); }
            if (ev.done) {
              if (!全文 && ev.text) 全文 = ev.text;
              手.完成(全文);
              跟随(台, 要跟);
              if (ev.摘要 && 画.提示) {
                画.提示(ev.摘要.失败 ? '（前情提要没写成，下一轮再试）' : '（已把旧的对话折进前情提要）');
              }
              当摘要(ev.摘要 || null);
            }
          }
        }
      } catch (e) {
        if (!出过错) return 还回去(e && e.name === 'AbortError' ? '这一轮中断了' : '流断了，刚才那段可能没说完');
      }
      控制器 = null;
      if (!出过错) 忙(false);
      if (输入 && 输入.focus) 输入.focus();
    }

    /** 掐掉正在跑的那一轮（服务端会一起掐上游，不留半条记录） */
    function 中断() {
      if (控制器) { 控制器.abort(); 控制器 = null; }
    }

    if (输入) {
      输入.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !是输入法回车(e)) {
          e.preventDefault();
          发送();
        }
      });
    }
    if (发送钮) 发送钮.addEventListener('click', function () { 发送(); });

    铺场();
    return { 发送: 发送, 中断: 中断, 铺场: 铺场, 探针: 探针, 址: 址 };
  }

  global.ND演出 = { 挂载: 挂载, 版本: '1.0' };
}(window));
