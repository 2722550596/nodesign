/**
 * ecosystem.gcp.cjs — GCP c4a-standard-1 (1 vCPU / 3.8G) 单机部署配置
 *
 * 跟 ecosystem.config.cjs（16G 生产机）的差异：
 *   - HOME / CLAUDE_CONFIG_DIR 指本机用户 —— 订阅 OAuth 凭据在 ~/.claude，指错认证直接失效
 *   - 内存上限按 3.8G 机器缩：heap 2G，超 1.5G RSS 自动重启兜底
 *
 * 用法：pm2 start ecosystem.gcp.cjs && pm2 save
 */

module.exports = {
  apps: [
    {
      name: 'nodesign',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1500M',
      node_args: '--env-file-if-exists=.env --max-old-space-size=2048',
      env: {
        NODE_ENV: 'production',
        HOME: '/home/wangang-dev',
        CLAUDE_CONFIG_DIR: '/home/wangang-dev/.claude',
      },
      error_file: 'logs/nodesign-error.log',
      out_file: 'logs/nodesign-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      kill_timeout: 5000,
      restart_delay: 4000,
      max_restarts: 10,
    },
  ],
};
