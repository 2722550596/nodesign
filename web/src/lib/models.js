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

/** 服务端拿不到时的兜底清单（离线 / 接口挂了也别让按钮变成死的） */
export const FALLBACK_MODELS = [
  { id: DEFAULT_MODEL_ID, label: 'Sonnet 5', desc: '快 · 日常改稿和铺页够用' },
  { id: 'claude-opus-5[1m]', label: 'Opus 5', desc: '前端与审美更强 · 烧订阅额度快得多，重活再开' },
];
