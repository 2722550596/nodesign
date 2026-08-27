/**
 * server/engine/pi/rpc-client.js — pi --mode rpc 子进程客户端（M1）
 *
 * 包住一个 pi RPC 子进程：spawn/attach、JSONL 分帧、命令/响应关联、事件分流、
 * turn 活跃态跟踪、kill 链。上层（session-loop，G2）拿它发 prompt/abort，
 * 事件流经 onEvent 交给 event-bridge。
 *
 * 帧纪律（rpc.md "Framing" + 设计 doc 附录 D，M0 探针验证过）：
 *  - stdout 用 Buffer 累积，只按字节 0x0A（'\n'）切帧（indexOf）；
 *  - 绝不把 U+2028/U+2029 当分隔符——它们在 JSON 字符串里合法（Node readline
 *    会误切，所以禁用 readline 类逻辑）；
 *  - 行内 '\n' 已被 JSON.stringify 转义成两字符 \n，原始 0x0A 字节只可能是分隔符；
 *  - Buffer（而非字符串）累积：多字节 UTF-8 字符被 chunk 边界切开也不会坏；
 *  - 每帧 JSON.parse；坏帧 log 后丢弃，不炸进程。
 *
 * 事件分流：
 *  - type === 'response' → 按 id resolve 对应 pending Promise（未匹配的 log 后丢弃）；
 *  - 其余 → opts.onEvent(line)（event-bridge.handleLine 消费）；
 *  - agent_start/agent_settled 同时维护 isTurnActive()（event-bridge abort 空闲门控，C6）。
 *
 * 单飞行：不在 client 层拒 prompt——pi 是排队语义（busy 也受理缓冲）；
 * turn 门控由上层做（isTurnActive + turn-relay 认领，C4）。
 *
 * 用法：
 *   const rpc = new PiRpcClient({ binary, args, cwd, env, onEvent, onExit });
 *   await rpc.start();                              // get_state 往返即 ready（pi 无 hello）
 *   const res = await rpc.prompt('hi', { id: runId }); // success:false 不抛，调用方判（C4 认领）
 *   await rpc.kill();                               // abort → 5s → SIGTERM → 2s → SIGKILL
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** stderr 默认处理：console.warn 带 [pi] 前缀（pi 的 stderr 是诊断第一信号）。 */
const defaultStderr = (line) => console.warn(`[pi] ${line}`);
/** log 默认处理：坏帧/未匹配 response 这类异常值得暴露。 */
const defaultLog = (msg) => console.warn(`[pi-rpc] ${msg}`);

export class PiRpcClient {
  /**
   * @param {object} opts
   * @param {object} [opts.child]    已 spawn 的子进程（lifecycle.createSessionProcess 产物）；
   *                                 提供则 start() 只附着不 spawn。测试可注入假 child。
   * @param {string} [opts.binary]   可执行文件（默认 'pi'，PATH 解析）
   * @param {string[]} [opts.args]   spawn 参数
   * @param {object} [opts.env]      子进程 env（lifecycle.sessionLaunch 产物）
   * @param {string} [opts.cwd]      子进程 cwd（<pid>/shared）
   * @param {(line: object) => void} [opts.onEvent]  事件回调（response 不到这里）
   * @param {(code, signal, err?) => void} [opts.onExit] 退出回调（spawn error 也走这里）
   * @param {(line: string) => void} [opts.stderr]   stderr 逐行回调
   * @param {(msg: string) => void} [opts.log]      诊断日志（坏帧等）
   * @param {Function} [opts.spawn]  spawn 工厂（测试注入 mock 用）
   */
  constructor(opts = {}) {
    this.binary = opts.binary ?? 'pi';
    this.args = opts.args ?? [];
    this.env = opts.env;
    this.cwd = opts.cwd;
    this.onEvent = opts.onEvent ?? null;
    this.onExit = opts.onExit ?? null;
    this._stderr = opts.stderr ?? defaultStderr;
    this._log = opts.log ?? defaultLog;
    this._spawn = opts.spawn ?? nodeSpawn;
    this.child = opts.child ?? null;

    this._started = false;
    this._disposed = false;
    this._exited = false;
    this._exitInfo = null;
    this._pending = new Map();      // id(string) -> { resolve, reject }
    this._reqSeq = 0;
    this._buf = Buffer.alloc(0);    // stdout 字节缓冲（只按 0x0A 切帧）
    this._stderrBuf = '';           // stderr 行缓冲
    this._turnActive = false;       // agent_start → true，agent_settled → false
    this._readySettled = false;
    this._readyResolve = null;
    this._readyReject = null;
    this._killPromise = null;
    this._timers = new Set();
    this._exitPromise = new Promise((resolve) => { this._exitResolve = resolve; });
  }

  /**
   * spawn（或附着注入的 child）→ 立即发 get_state{id:req_init} 探活 →
   * 收到该 response 即 ready。pi 无 hello 事件；prompt 是排队语义，
   * 但探活用 get_state 足够且无副作用。spawn 错误 / 未 ready 就 exit → reject。
   */
  async start() {
    if (this._started) throw new Error('PiRpcClient 已 start（一个实例对应一个进程）');
    this._started = true;

    if (!this.child) {
      try {
        this.child = this._spawn(this.binary, this.args, {
          cwd: this.cwd,
          env: this.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        throw new Error(`spawn ${this.binary} 失败: ${err.message}`);
      }
    }
    const child = this.child;
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.on('data', (chunk) => this._onStderr(chunk));
    child.on('error', (err) => this._onChildError(err));
    child.on('exit', (code, signal) => this._onChildExit(code, signal));

    const ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // 进程先退出时，req_init 会在 pending 清扫里被 reject → ready 随之 reject。
    this.send({ type: 'get_state', id: 'req_init' }).then(
      (res) => {
        if (this._readySettled) return;
        this._readySettled = true;
        this._readyResolve(res);
      },
      (err) => {
        if (this._readySettled) return;
        this._readySettled = true;
        this._readyReject(err);
      },
    );
    return ready;
  }

  /**
   * 发 prompt。返回 response（success:false 不抛——pi 拒绝语义由调用方判，C4）。
   * @param {string} message
   * @param {{ id?: string, images?: Array<{type:'image',data:string,mimeType:string}> }} [opts]
   *        id 缺省自动分配 req_N；turn 认领场景传 runId（C4：prompt id = runId）。
   */
  prompt(message, { id, images } = {}) {
    const cmd = { type: 'prompt', message };
    if (id != null) cmd.id = id;
    if (images != null) cmd.images = images;
    return this.send(cmd);
  }

  /** 发 abort。返回 response（空闲 abort pi 也回 success:true，门控在上层，C6）。 */
  abort() {
    return this.send({ type: 'abort' });
  }

  /** get_state → response.data（失败抛错：这是状态查询，失败即异常）。 */
  async getState() {
    const res = await this.send({ type: 'get_state' });
    if (!res.success) throw new Error(`get_state 失败: ${res.error ?? 'unknown error'}`);
    return res.data;
  }

  /** set_preset（pi-rp 波次1 已实现）。返回 response，调用方判 success。 */
  setPreset(presetId) {
    return this.send({ type: 'set_preset', presetId });
  }

  /** set_thinking_level。返回 response。
   *  persistSettings 默认 false：Nodesign 的 agent-dir 是所有会话共享的模板目录，
   *  pi 写全局 settings.json 会让一个会话的档位污染共享默认。会话级持久化靠 pi
   *  自己写的 session JSONL（thinking_level_change 条目，resume 恢复的事实源），
   *  不受此参数影响。pi-rp 侧该参数默认 true（既有行为不变），这里显式 opt-out。 */
  setThinkingLevel(level, persistSettings = false) {
    return this.send({ type: 'set_thinking_level', level, persistSettings });
  }

  /** set_model（M1.5）。provider + modelId 是 pi wire 名（piProviderModelFor 反查）。
   *  返回 response。persistSettings 默认 false，理由同 setThinkingLevel；Nodesign 侧
   *  的模型持久化走 writeSessionModelOverride（.nd/<sid> 配置），不依赖 pi settings。 */
  setModel(provider, modelId, persistSettings = false) {
    return this.send({ type: 'set_model', provider, modelId, persistSettings });
  }

  /** get_session_stats → response.data（SessionStats，含 contextUsage）。失败抛错。 */
  async getSessionStats() {
    const res = await this.send({ type: 'get_session_stats' });
    if (!res.success) throw new Error(`get_session_stats 失败: ${res.error ?? 'unknown error'}`);
    return res.data;
  }

  /** get_available_models → response.data（模型快照数组）。失败抛错。 */
  async getAvailableModels() {
    const res = await this.send({ type: 'get_available_models' });
    if (!res.success) throw new Error(`get_available_models 失败: ${res.error ?? 'unknown error'}`);
    return res.data;
  }

  /**
   * 内部发送：无 id 自动分配 req_N；写 stdin（JSON + '\n'）；
   * 返回 Promise<response>，按 id 关联。进程未运行/已退出 → reject。
   */
  send(command) {
    if (!command || typeof command !== 'object' || !command.type) {
      return Promise.reject(new Error('send: command 必须是带 type 的对象'));
    }
    const cmd = { ...command };
    if (cmd.id == null) cmd.id = `req_${++this._reqSeq}`;
    const key = String(cmd.id);
    if (this._pending.has(key)) {
      return Promise.reject(new Error(`send: 重复的请求 id ${key}（上一个同名请求未决）`));
    }
    if (!this.child || this._exited || this._disposed) {
      return Promise.reject(new Error(`pi 进程未运行，无法发送 ${cmd.type}（id=${key}）`));
    }
    const promise = new Promise((resolve, reject) => {
      this._pending.set(key, { resolve, reject });
    });
    const payload = JSON.stringify(cmd) + '\n';
    let writeErr = null;
    try {
      this.child.stdin.write(payload, 'utf8', (err) => {
        if (err) this._settlePending(key, null, err);
      });
    } catch (err) {
      writeErr = err;
    }
    if (writeErr) this._settlePending(key, null, writeErr);
    return promise;
  }

  /** turn 是否活跃：agent_start → true，agent_settled → false（event-bridge 门控用）。 */
  isTurnActive() {
    return this._turnActive;
  }

  /**
   * kill 链（对齐 M0 探针超时链）：abort RPC（fire-and-forget）→ 等 5s 优雅退出
   * → SIGTERM → 2s → SIGKILL。幂等：并发/重复调用返回同一个 Promise。
   */
  kill() {
    if (!this._killPromise) this._killPromise = this._killChain();
    return this._killPromise;
  }

  async _killChain() {
    if (!this.child || this._exited) return this._exitInfo;
    // 1) abort 不等响应——进程可能已不响应命令，但信号链必须推进。
    this.send({ type: 'abort' }).catch(() => {});
    // 2) 5s 优雅退出窗口
    if (await this._waitExit(5000)) return this._exitInfo;
    // 3) SIGTERM + 2s
    this._safeKill('SIGTERM');
    if (await this._waitExit(2000)) return this._exitInfo;
    // 4) SIGKILL（必达；再等 exit 事件落账，兜底 5s 防 hang）
    this._safeKill('SIGKILL');
    await this._waitExit(5000);
    return this._exitInfo;
  }

  /** 清 listener/timer/未决请求。终态操作；不杀进程（杀进程用 kill()）。 */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this._failAllPending(new Error('PiRpcClient disposed'));
    if (!this._exited) {
      // 解除 kill 链里 _waitExit 的等待（exitPromise 不会再有真实 exit 事件了）
      this._exited = true;
      this._exitInfo = { code: null, signal: null, disposed: true };
      this._exitResolve(this._exitInfo);
    }
    const child = this.child;
    if (child) {
      try { child.stdout?.removeAllListeners('data'); } catch { /* noop */ }
      try { child.stderr?.removeAllListeners('data'); } catch { /* noop */ }
      try { child.removeAllListeners('error'); child.removeAllListeners('exit'); } catch { /* noop */ }
      try { child.stdin?.destroy(); } catch { /* noop */ }
    }
    this.onEvent = null;
    this.onExit = null;
  }

  // ── 内部：stdout 分帧 ──────────────────────────────────────────────────────

  _onStdout(chunk) {
    // Buffer 累积：多字节字符跨 chunk 不坏；只认字节 0x0A。
    this._buf = this._buf.length > 0 ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      const idx = this._buf.indexOf(0x0a);
      if (idx < 0) break;
      const frame = this._buf.subarray(0, idx);
      this._buf = this._buf.subarray(idx + 1);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frameBuf) {
    let text = frameBuf.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1); // 容忍 CRLF（rpc.md framing 允许）
    if (text.trim() === '') return;                    // 空帧（keep-alive 类）静默跳过
    let line;
    try {
      line = JSON.parse(text);
    } catch (err) {
      this._log(`坏帧丢弃（${err.message}）: ${text.slice(0, 200)}`);
      return;
    }
    this._dispatch(line);
  }

  _dispatch(line) {
    if (line && typeof line === 'object' && line.type === 'response') {
      const key = line.id != null ? String(line.id) : null;
      const pending = key != null ? this._pending.get(key) : undefined;
      if (!pending) {
        this._log(`未匹配的 response 丢弃: id=${JSON.stringify(line.id)} command=${line.command}`);
        return;
      }
      this._pending.delete(key);
      pending.resolve(line);
      return;
    }
    // 事件：维护 turn 活跃态，再交给 onEvent（event-bridge）
    if (line && typeof line === 'object') {
      if (line.type === 'agent_start') this._turnActive = true;
      else if (line.type === 'agent_settled') this._turnActive = false;
    }
    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent(line);
      } catch (err) {
        this._log(`onEvent 回调抛错: ${err.message}`);
      }
    }
  }

  // ── 内部：stderr / 退出 ────────────────────────────────────────────────────

  _onStderr(chunk) {
    this._stderrBuf += chunk.toString('utf8');
    let idx;
    while ((idx = this._stderrBuf.indexOf('\n')) >= 0) {
      const line = this._stderrBuf.slice(0, idx);
      this._stderrBuf = this._stderrBuf.slice(idx + 1);
      if (line.trim() !== '') {
        try { this._stderr(line); } catch { /* 回调抛错不炸流 */ }
      }
    }
  }

  _onChildError(err) {
    // spawn 失败（ENOENT 等）只发 'error' 不发 'exit'，这里兜底收尾。
    if (this._exited) return;
    this._exited = true;
    this._exitInfo = { code: null, signal: null, error: err };
    this._failAllPending(new Error(`pi 子进程错误: ${err.message}`));
    this._exitResolve(this._exitInfo);
    this._callOnExit(null, null, err);
  }

  _onChildExit(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this._exitInfo = { code, signal };
    // stderr 尾巴先冲出去（诊断信息不丢）
    const tail = this._stderrBuf;
    this._stderrBuf = '';
    if (tail.trim() !== '') {
      try { this._stderr(tail); } catch { /* noop */ }
    }
    // 先 reject 所有 pending（含 req_init → start() reject），再 onExit。
    this._failAllPending(new Error(`pi 进程退出（code=${code} signal=${signal}）`));
    this._exitResolve(this._exitInfo);
    this._callOnExit(code, signal);
  }

  _callOnExit(code, signal, err) {
    if (typeof this.onExit === 'function') {
      try {
        this.onExit(code, signal, err);
      } catch (e) {
        this._log(`onExit 回调抛错: ${e.message}`);
      }
    }
  }

  // ── 内部：pending / timer 工具 ─────────────────────────────────────────────

  _settlePending(key, value, err) {
    const pending = this._pending.get(key);
    if (!pending) return;
    this._pending.delete(key);
    if (err) pending.reject(err);
    else pending.resolve(value);
  }

  _failAllPending(err) {
    const entries = [...this._pending.entries()];
    this._pending.clear();
    for (const [, p] of entries) p.reject(err);
  }

  /** 等退出事件，超时返回 false。timer 登记进 _timers（dispose 可清）。 */
  _waitExit(ms) {
    if (this._exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._timers.delete(timer);
        resolve(false);
      }, ms);
      this._timers.add(timer);
      this._exitPromise.then(() => {
        clearTimeout(timer);
        this._timers.delete(timer);
        resolve(true);
      });
    });
  }

  _safeKill(signal) {
    if (!this.child || this._exited) return;
    try {
      this.child.kill(signal);
    } catch { /* 进程可能已死，kill 抛 ESRCH 之类——忽略 */ }
  }
}
