/**
 * 「现在这个会话跑在谁家的模型上」—— 画布精灵换身份用的一句话（2026-08-21）。
 *
 * 为什么不直接读模型名去猜：brand 由服务端在 model-context.js 里逐行声明，前端不许按
 * id 前缀推断（下一个模型名一变就全错）。也**不能读 SDK 的 usage.model** —— spoofing 之后
 * 那是 alias（DeepSeek 行报 claude-opus-4-7[1m]），照它认牌子会把鲸画成星芒。
 *
 * 取值顺序，两个来源都来自同一份服务端清单，只是快慢不同：
 *   1. `sessionBrand`：picker 问 `GET /sessions/:sid/model` 拿到的**这个会话的**生效模型，
 *      写进 globalStore。它最准 —— 连"还没跑过任何一轮"的新会话都算得对。
 *   2. `contextUsage.brand`：上一轮真跑过的模型（run.context_usage 事件带下来的）。
 *      picker 没挂载 / 还没问到时用它兜。
 *   3. 都没有 → DEFAULT_BRAND（跟 DEFAULT_MODEL_ID 配对的那家）。
 *
 * pid 从路由拿：精灵只活在项目页里，让画布再传一层 prop 只是把同一件事搬了个地方。
 */
import { useParams } from 'react-router-dom';
import { useGlobalStore } from '../stores/globalStore.js';
import { useProjectStore } from '../stores/projectStore.js';
import { DEFAULT_BRAND } from './models.js';

export function useCurrentModelBrand() {
  const { id } = useParams();
  const fromPicker = useGlobalStore((s) => s.sessionBrand);
  const fromRun = useProjectStore((s) => (id ? s.contextByProject[id]?.contextUsage?.brand : null));
  return fromPicker || fromRun || DEFAULT_BRAND;
}
