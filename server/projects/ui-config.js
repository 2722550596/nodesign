/**
 * 项目级 UI 配置 —— `<工作区根>/ui-config.json`（#25，2026-08-13）。
 *
 * 前身叫 session-config.json。扁平化（2026-08-07）之前一个会话一个沙盒，
 * "会话配置"和"工作区配置"是同一件事；之后工作区全项目共用，这份文件
 * 实际上早就是**项目级**的了，名字却还挂着 session —— 跟
 * `.nd/<sid>/session-config.json`（真·会话级，存模型覆盖，session-model.js
 * 专管，那份**不改名**）同名不同域。两份同名文件各自内部一致，但每个新
 * 读者都要重新分辨一次"这是哪个 session-config"—— 评审点名的那种暗病。
 *
 * 迁移策略：读取认旧名回落（老项目的 tweaks 开关不丢），写入只写新名。
 * 旧文件留在原地不动 —— 它同时是回滚的退路。
 *
 * 字段：
 *   - tweaks_mode_enabled: bool  是否启用 Tweaks 模式（默认启用）
 */
import path from 'path';
import { promises as fs } from 'fs';

export const UI_CONFIG_NAME = 'ui-config.json';
const LEGACY_NAME = 'session-config.json';

export const DEFAULT_UI_CONFIG = Object.freeze({
  tweaks_mode_enabled: true,
  /**
   * 黑板模式（2026-08-23）：用户专注头脑风暴时，画布取代侧栏成为主交互窗口 ——
   * agent 每轮的主体内容落画布（sketch_on_board / edit_sketch），聊天里只留一两句；
   * 草图落定时服务端广播 board.focus，前端把镜头带过去。
   */
  blackboard_mode: false,
});

/**
 * 读原始文件（新名 → 旧名回落）。**没有文件返回 null** —— hooks.js 靠
 * "文件存在与否"决定注不注入提示（没碰过 toggle = 沉默），不能用默认值糊掉。
 */
export async function readUiConfigFile(workspaceRoot) {
  for (const name of [UI_CONFIG_NAME, LEGACY_NAME]) {
    try {
      const raw = await fs.readFile(path.join(workspaceRoot, name), 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return cfg;
    } catch { /* 试下一个名字 */ }
  }
  return null;
}

/** 补齐默认字段（API 返回用） */
export function withUiDefaults(cfg) {
  return { ...DEFAULT_UI_CONFIG, ...(cfg || {}) };
}

/** 整份写入。只写新名；旧文件留着当回落/退路，不删不改 */
export async function writeUiConfig(workspaceRoot, cfg) {
  await fs.writeFile(
    path.join(workspaceRoot, UI_CONFIG_NAME),
    JSON.stringify(cfg, null, 2),
    'utf8',
  );
}
