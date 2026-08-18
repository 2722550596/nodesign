/**
 * ecosystem.exp.config.cjs — 实验实例（2026-08-07）
 *
 * 跟线上（ecosystem.config.cjs）并排跑在同一台机器上：
 *   线上   pm2 nodesign      :4001  ←  nginx 443   ← 主仓 ~/projects/Nodesign（永远停 main）
 *   实验   pm2 nodesign-exp  :4002  ←  nginx 8443  ← 本 worktree（feat/canvas-upgrade）
 *
 * 8443 是 Cloudflare 对已代理域名默认也代理的 HTTPS 端口，所以不用另加 DNS 记录。
 *
 * 数据是**独立的**：.env 里 PROJECTS_DATA_DIR / DB_PATH 指向 ~/nodesign-exp-data，
 * 那份数据是从线上 VACUUM INTO + 目录拷贝出来的冻结快照，并且把 112 条指回线上
 * 的绝对软链全部重定向进了快照内部 —— 08-02 那次「实验实例的 agent 写穿线上」
 * 就是漏了这一步（当时修了 105 条）。改数据源之前先把这段读完。
 *
 * 内存：这台是 3.9G 的 Spot，线上实例还在跑，所以实验实例把并发压到 1。
 * 本 worktree 没有 rembg 的 venv，抠图服务不会常驻（省 380MB），
 * remove_background 会退化成按次 spawn。
 */
module.exports = {
  apps: [
    {
      name: 'nodesign-exp',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1200M',
      node_args: '--env-file-if-exists=.env --max-old-space-size=1024',
      // ⛔ **隔离/权限那几个开关已经从这里挪进 exp 的 `.env`**（2026-08-18）。
      //    为什么：pm2 只在**用配置文件启动**时注入 env 段，之后一次普通
      //    `pm2 restart` 就把它们丢掉，而且一声不响。实测账：08-15 13:16 开起来、
      //    14:36 还在，**08-16 05:13 起全没了**，一直到 08-18 12:22 才被发现 ——
      //    也就是"先在 exp 观察一段再上生产"的那个观察，实际只跑了 3 小时 20 分。
      //    唯一的痕迹是启动日志里 platform dump 的 `sandboxEnabled` 从 true 变 false。
      //    （同一个坑这仓库吃过第二次：下面 HOME 那段注释写的也是它。）
      //    `.env` 由 node 自己每次启动用 `--env-file-if-exists` 读，跟 pm2 怎么被
      //    调用无关 —— 开关放那儿才活得住。**别再往这个 env 段里加开关。**
      env: {
        NODE_ENV: 'production',
        HOME: '/home/wangang-dev',
        CLAUDE_CONFIG_DIR: '/home/wangang-dev/.claude',
        // 进程级沙盒（2026-08-15 在 exp 先开）：Bash 进 bwrap，写只落工作区、
        // 凭据读不到、env 里的 key 被抹掉。生产还没开，观察 exp 一段再说。
        // 结构化工具（Read/Grep/Write）不归它管，那半边在 runtime/platform.js。
        NODESIGN_SANDBOX: 'on',
        // 权限模式：auto = 每次要审批的工具调用交给一个**模型分类器**判，
        // 规则从 agent/auto-mode-rules.js 注进它的系统提示。
        // ⚠️ 会话模型是 haiku 时 SDK 会把 auto 静默降级成 default（实测），
        // 分类器一次都不跑 —— session-loop 的 init 自检会在日志里喊。
        NODESIGN_PERMISSION_MODE: 'auto',
        // 判"越不越界"是需要判断力的活，用 opus，别在这儿省。
        NODESIGN_AUTO_MODE_MODEL: 'opus',
        // 分类器判不了、升级到我们这儿的：先只记账放行（allow），
        // 看清真实用量里都有谁会升上来再决定拦不拦（deny）。
        NODESIGN_AUTO_MODE_ESCALATION: 'allow',
        // 两个实例同机同用户：不拦的话 exp 的会话读得到生产的用户数据和库。
        // （.env 那类凭据由 platform.js 的兄弟仓扫描自动盖住，这里只补数据。）
        NODESIGN_DENY_READ_EXTRA: [
          '/home/wangang-dev/projects/Nodesign/server/projects-data',
          '/home/wangang-dev/projects/Nodesign/server/db',
        ].join(':'),
      },
      error_file: 'logs/nodesign-exp-error.log',
      out_file: 'logs/nodesign-exp-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      kill_timeout: 5000,
      restart_delay: 4000,
      max_restarts: 10,
    },
  ],
};
