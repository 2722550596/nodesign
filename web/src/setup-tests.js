/**
 * vitest 全局 setup —— 测试环境补丁（2026-08-27）。
 *
 * 补丁一：localStorage。Node 22+ 自带**实验性** localStorage 全局（要
 * `--localstorage-file` 才可用，否则 getter 返回 undefined）。vitest 的
 * populateGlobal 里有这么一条：`if (k in global) return keysArray.includes(k)` ——
 * key 已存在于 Node 全局、又不在 vitest 的 KEYS 白名单里，就**跳过桥接**
 * happy-dom 的真 localStorage。结果 happy-dom 测试里裸 `localStorage` 解析到
 * Node 的坏桩上，`.clear()` / `.getItem()` 当场炸（ChatDock.test.jsx 六条
 * 全灭于此；其余 happy-dom 测试只是没碰 localStorage 才幸免）。
 *
 * 全局 localStorage 不可用就装一个内存版 Storage（happy-dom / node 环境通吃）。
 * 不引 happy-dom 的 Storage 类：零依赖，且 happy-dom 的 Window 实例并不暴露
 * 给 setup 文件，够不着它那份。
 *
 * 补丁二：IS_REACT_ACT_ENVIRONMENT。vitest 的 happy-dom 环境不设这个，React 19
 * 的 act() 每条都喷 "not configured to support act(...)"。测试环境里设 true 是
 * React 官方口径。
 */

class MemoryStorage {
  #map = new Map();
  get length() { return this.#map.size; }
  clear() { this.#map.clear(); }
  getItem(key) { return this.#map.has(String(key)) ? this.#map.get(String(key)) : null; }
  key(i) { return [...this.#map.keys()][i] ?? null; }
  removeItem(key) { this.#map.delete(String(key)); }
  setItem(key, value) { this.#map.set(String(key), String(value)); }
}

function isUsable(storage) {
  try {
    storage.setItem('__vitest_probe__', '1');
    const ok = storage.getItem('__vitest_probe__') === '1';
    storage.removeItem('__vitest_probe__');
    return ok;
  } catch {
    return false;
  }
}

if (!isUsable(globalThis.localStorage)) {
  const store = new MemoryStorage();
  // Node 的实验性 localStorage 描述符是 configurable 的，可覆盖（已验证）。
  Object.defineProperty(globalThis, 'localStorage', {
    get: () => store,
    configurable: true,
  });
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
