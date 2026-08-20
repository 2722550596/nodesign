/**
 * 前端这边关于「哪些模型可选、没选过时是哪个」的唯一一份常量。
 *
 * ## 为什么单开一个文件
 *
 * 这两个值有两个消费者，而且它们不该互相依赖：`globalStore` 要知道**没选过时
 * 是哪个**（它决定第一条消息带什么 `body.model`），`ModelPicker` 要知道
 * **接口挂了时清单长什么样**。让 store 反过来 import 组件是倒着的依赖，
 * 两边各抄一份就是第三、第四个真相源 —— 这个仓库为「同一件东西有多个实例」
 * 付过最贵的学费。
 *
 * ## 权威仍在服务端
 *
 * 真清单是 `server/engine/agent/model-context.js` 的 `SELECTABLE_MODELS`，
 * picker 正常情况下用接口拿回来的那份。下面这份**只在拿不到时兜底**，
 * 别拿它当准。改服务端清单时顺手核一眼这里。
 */

/**
 * 没有会话、也没选过时用哪个（2026-08-17 用户拍板：就指定 Sonnet）。
 *
 * 这不是"跟随服务端默认"—— 它是**明写下去**的。以前这里是 null，意思是
 * 第一条消息不带 model 字段、由 `NODESIGN_MODEL` 决定；那样按钮上写的和实际
 * 跑的是两条独立的链，环境变量一改按钮就开始说谎（这个文件的老毛病，见
 * ModelPicker 顶上那段）。现在按钮显示什么、消息里带什么，是同一个常量。
 */
export const DEFAULT_MODEL_ID = 'claude-sonnet-5[1m]';

/**
 * 本地偏好过期了吗 —— 它指向的模型**已经不在服务端清单里**（模型下架了）。
 *
 * 为什么需要：偏好存在 localStorage，而下架是服务端单方面发生的事。08-20 摘掉
 * 本地 Qwen 时踩到：浏览器里还存着 `qwen3.8-27b`，**开新会话是直接把 store 里的
 * modelPref 发出去的**（ProjectWorkspace 两处 Turn.send），服务端 selectableModelsFor
 * 校验不过 → 400，用户只看到一句 `unknown model: qwen3.8-27b`，而且自己不知道该怎么办。
 *
 * ⚠️ 判据必须是**服务端真清单**。拿 FALLBACK_MODELS 判会把带闸门的模型
 * （本地/中转那几个，兜底清单里根本没有）全部误伤成"过期"，接口抖一下就把
 * 获批用户的选择悄悄改回 Sonnet —— 所以拿不到真清单时一律当"没过期"。
 *
 * @param {string|null} pref
 * @param {Array<{id:string}>|null|undefined} serverOptions  只传服务端回的那份，别传兜底
 * @returns {boolean}
 */
export function isModelPrefStale(pref, serverOptions) {
  if (!pref || !serverOptions?.length) return false;
  return !serverOptions.some((o) => o?.id === pref);
}

/** 服务端拿不到时的兜底清单（离线 / 接口挂了也别让按钮变成死的） */
export const FALLBACK_MODELS = [
  { id: DEFAULT_MODEL_ID, label: 'Sonnet 5', desc: '快 · 日常改稿和铺页够用' },
  { id: 'claude-opus-5[1m]', label: 'Opus 5', desc: '前端与审美更强 · 烧订阅额度快得多，重活再开' },
];
