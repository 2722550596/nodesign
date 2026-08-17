import { FileCode, FileText, Presentation, Globe, Hammer, FileDown, Package } from 'lucide-react';

/**
 * 导出格式的词汇表 —— **一份**，给两个消费者用：
 *   - 顶栏的导出下拉（ExportMenu）：带描述的一行行菜单
 *   - 产物窗工具栏的导出组（2026-08-13）：只要图标和一句 title
 *
 * 能导出哪几种由**服务端**说了算（kinds/ 注册表 → tasks[].exports），这里只管
 * 每个格式长什么样。抄成两份的话，加一种格式就会出现"菜单里有、工具栏里没有"。
 */
const FORMAT_META = {
  html:    { icon: FileCode,     label: 'Standalone HTML',    desc: '单文件，可双击打开',
             siteLabel: '单页自包含 HTML',  siteDesc: '只当前入口页，图片内联' },
  pdf:     { icon: FileText,     label: 'PDF',                desc: 'playwright print 1920×1080（矢量文字 + 4K-ready）' },
  pptx:    { icon: Presentation, label: 'PowerPoint (.pptx)', desc: '每页截图嵌 PPTX（位图，文字不可编辑）' },
  site:    { icon: Globe,        label: '整站打包 (.zip)',     desc: '全部页面 + 样式 + 图，解压双击就能看' },
  handoff: { icon: Hammer,       label: '工程包',               desc: 'ZIP: 源码 + 用到的素材 + README（含后端接口清单）',
             siteDesc: 'ZIP: 整站源码 + 用到的素材 + README（含后端接口清单）' },
  // 按产物卡导出的三种（2026-08-17 重做）。跟上面那几种的区别：上面是「烘焙」
  // （PDF / PPTX / 单页 HTML 要跑 playwright / esbuild），下面是「原样打包」。
  raw:     { icon: FileDown,      label: '原件',                 desc: '就下这一个文件，不打包' },
  zip:     { icon: Package,       label: '打包 (.zip)',          desc: '产物 + 它真正引用到的素材，目录结构原样保留' },
  md:      { icon: FileText,      label: '合并成一份 .md',        desc: '多张便签接成一篇，带来源标注' },
};

/** 一张卡默认导出成什么：文件类给原件，目录/页面类给打包 */
export function defaultFormatFor(cardKind) {
  return ['image', 'video', 'note', 'file'].includes(cardKind) ? 'raw' : 'zip';
}

// 服务端没给格式表时的兜底（旧数据 / 聚焦的不是任务）
const FALLBACK_FORMATS = {
  deck: ['html', 'pdf', 'pptx', 'handoff'],
  site: ['site', 'html', 'handoff'],
  image: ['raw', 'zip'],
  video: ['raw', 'zip'],
  note: ['raw', 'zip', 'md'],
  file: ['raw', 'zip'],
};

function itemsFor(artifactKind, artifactExports) {
  const isSite = artifactKind === 'site';
  const ids = (Array.isArray(artifactExports) && artifactExports.length)
    ? artifactExports
    : (FALLBACK_FORMATS[artifactKind] || FALLBACK_FORMATS.deck);
  return ids
    .filter(id => FORMAT_META[id])
    .map(id => {
      const m = FORMAT_META[id];
      return {
        id,
        icon: m.icon,
        label: (isSite && m.siteLabel) || m.label,
        desc: (isSite && m.siteDesc) || m.desc,
      };
    });
}

export { itemsFor as exportItemsFor };
