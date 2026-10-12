// ============================================================
// pm2 进程配置
// 用法：pm2 start ecosystem.config.cjs
// ============================================================

// 本机可用的 Node（必须 22.5+，项目依赖 node:sqlite）。
// 如需换成其它版本，直接改这一行即可。
const NODE = '/Users/tal/.nvm/versions/node/v22.16.0/bin/node';

module.exports = {
  apps: [
    {
      name: 'four-quadrants',
      script: 'server/index.js',
      cwd: __dirname,

      interpreter: NODE,
      node_args: '--no-warnings',

      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        // 用 7788 而非 5173：5173 是 Vite 默认端口，最容易被别的前端项目占用
        PORT: 7788,
      },

      // 单实例：SQLite 是单文件，多实例会争抢写锁
      instances: 1,
      exec_mode: 'fork',

      // 崩溃自动重启
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,

      // 内存超 300MB 自动重启（正常远低于此值，仅作兜底）
      max_memory_restart: '300M',

      // 日志
      output: 'logs/out.log',
      error: 'logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
