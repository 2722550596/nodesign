import { FileCode, FileText, Presentation, Globe, Hammer } from 'lucide-react';

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
  handoff: { icon: Hammer,       label: '源码包',               desc: 'ZIP: HTML + spec + assets + README',
             siteDesc: 'ZIP: 整站 + spec + assets + README' },
};

// 服务端没给格式表时的兜底（旧数据 / 聚焦的不是任务）
const FALLBACK_FORMATS = {
  deck: ['html', 'pdf', 'pptx', 'handoff'],
  site: ['site', 'html', 'handoff'],
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
