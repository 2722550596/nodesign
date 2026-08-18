/**
 * server/lib/reference-assets.js — 参考素材清单（2026-08-18）
 *
 * `assets/references/**` 里的东西：web-search 下载的参考图、`browser_capture` 从
 * 参照站带回来的截图与调色板/字体/结构 json。
 *
 * ## 它们此前完全看不见，原因不是"kinds 不认图片"
 *
 * 图片有自己的 file-kind（`kinds/file-kinds.js`，IMAGE_EXTS 六种齐全）。真正的断点
 * 是**扫描根**：`api/assets.js` 的 `/assets` 端点只 readdir 顶层文件，而产物清单那遍
 * `scanDir` 用的是默认 `depth = 0`（`depth <= 0` 就不进子目录）——
 * `assets/generated` 和 `assets/notes` 能上墙只因为它们被**单独列了一行**，
 * `assets/references/` 没被列。所以修法是加一个扫描口，不是改形态注册表。
 *
 * ## 走抽屉不走画布（用户 2026-08-18 拍板）
 *
 * 每逛一站甩十几张卡到画布上是噪音，而 web-search 下载的参考图还会成倍冒出来
 * （它按 `count*2` 下载但只上报 `count` 张，磁盘上本来就有 agent 不知道的孤儿）。
 * 收进「参考素材」抽屉杂波小得多。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * 最多下探几层：`references/`(0) → `web/`(1) → `<站名>/`(2) → 文件。
 *
 * ⭐ 2026-08-18 下午 +1：`browser_capture` 改成**一站一文件夹**（按站点产物那条
 * 范式：目录 = 单位）。深度不够的话整棵采集树在清单里凭空消失 —— 而"扫描根/深度
 * 不够"正是当初参考素材完全看不见的真因（见文件头），同一个坑别踩第二次。
 */
const MAX_DEPTH = 3;

/** 这份素材属于哪个参照站（`assets/references/web/<站名>/…` 的那一段） */
function siteOf(rel) {
  const m = /^assets\/references\/web\/([^/]+)\//.exec(rel);
  return m ? m[1] : null;
}

/**
 * @param {string} assetsDir  `<工作区>/assets` 的绝对路径
 * @returns {Promise<Array<{rel,name,size,mtime,source?,lookingFor?,capturedAt?}>>}
 *   按 mtime 倒序。读不到就返回空数组 —— 素材列不出来不该让整份 /assets 响应失败。
 */
export async function listReferences(assetsDir) {
  const out = [];

  const walk = async (dir, relPrefix, depth) => {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.meta') continue;                     // sidecar 目录本身不列
      if (e.isDirectory()) {
        if (depth > 0) await walk(path.join(dir, e.name), `${relPrefix}/${e.name}`, depth - 1);
        continue;
      }
      if (!e.isFile() || e.name.startsWith('.')) continue;
      let st;
      try { st = await fs.stat(path.join(dir, e.name)); } catch { continue; }

      // 出处：照 generate-image 的 `.meta/<主干>.json` 约定读（不另发明一套）。
      // 没有出处很正常 —— web-search 下载的那些本来就没写 sidecar。
      let meta = null;
      try {
        const stem = e.name.replace(/\.[^.]+$/, '');
        meta = JSON.parse(await fs.readFile(path.join(dir, '.meta', `${stem}.json`), 'utf8'));
      } catch { /* 无出处 */ }

      const rel = `${relPrefix}/${e.name}`;
      out.push({
        rel,
        name: e.name,
        site: siteOf(rel),
        // 类别写在文件名里（`.screenshot.webp` / `.palette.json` / `.css` …），
        // sidecar 里也记着一份 —— 文件名优先，它是用户和 agent 直接看到的那个
        category: /\.(screenshot)\.\w+$/.test(e.name) ? 'screenshot'
          : (/\.(palette|fonts|skeleton)\.json$/.exec(e.name)?.[1] || (e.name.endsWith('.css') ? 'css' : null)),
        size: st.size,
        mtime: st.mtime.toISOString(),
        ...(meta ? {
          source: meta.sourceUrl || null,
          lookingFor: meta.lookingFor || null,
          capturedAt: meta.capturedAt || null,
        } : {}),
      });
    }
  };

  await walk(path.join(assetsDir, 'references'), 'assets/references', MAX_DEPTH);
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}
