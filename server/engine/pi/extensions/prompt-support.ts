/**
 * Nodesign prompt-support for pi（M2：{{ndPolicy}} 宏注册）。
 *
 * preset nodesign.json 的 prelude block 里政策节是单行 `{{ndPolicy}}`（migrate-prelude.mjs
 * 把两个 nd:policy 标记块换成了它）；本扩展把宏展开成「底线」全文或 min 版 + 成人档替换。
 * 档位来自 env（lifecycle spawn 时注入，主进程算好）：
 * - NODESIGN_ADULT_LEVEL：off|loose|strict，缺省/未知落 loose
 * - NODESIGN_UNCENSORED："1" → min 版，其余一律 full（拿不到信息绝不落 min）
 *
 * 渲染逻辑全在 ../policy-render.js（纯函数，vitest 直接测）；本文件是薄壳，
 * 只负责 registerMacro。宏 render 是同步的，policy-render.js 模块级 readFileSync
 * 缓存 prelude 块（同 system-prompts.js 模式）。
 *
 * 本文件是 pi extension（-e <绝对路径> 显式挂载，挂载归 lifecycle.js 统一做）：
 * jiti 加载，default export 即工厂。
 */

import { renderNdPolicy } from "../policy-render.js";

/**
 * pi extension 工厂。注册 ndPolicy 宏。
 *
 * 失败兜底在 renderNdPolicy 内部：md 读不到 / 标记块缺失 → 返回 full 版保守替代，
 * 绝不返回空串（政策节消失是安全事故）。宏 render 抛错会打断整个系统提示词编译，
 * 所以这里不额外 throw。
 */
export default function setup(pi) {
	pi.registerMacro({
		name: "ndPolicy",
		description: "Nodesign policy section (bottom line + adult policy)",
		render: () => renderNdPolicy(),
	});
}
