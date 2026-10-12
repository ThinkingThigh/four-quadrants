// ============================================================
// pm2 进程配置
// 用法：pm2 start ecosystem.config.cjs
// ============================================================

const { existsSync } = require('node:fs');
const { execSync } = require('node:child_process');

/**
 * 解析要用的 node 解释器。
 * 本项目依赖 node:sqlite（需 Node 22.5+），所以优先使用当前 PATH 里的 node，
 * 若版本不够则尝试 nvm 里已安装的较高版本，最后回退到当前 node。
 *
 * 如需固定某个版本，可直接把 interpreter 写死成绝对路径。
 */
function resolveNode() {
  const candidates = [];

  // 1) 当前 PATH 里的 node
  try {
    const p = execSync('command -v node', { encoding: 'utf8' }).trim();
    if (p) candidates.push(p);
  } catch { /* ignore */ }

  // 2) nvm 目录下 22.x 的版本
  const nvmDir = `${process.env.HOME}/.nvm/versions/node`;
  if (existsSync(nvmDir)) {
    try {
      const { readdirSync } = require('node:fs');
      readdirSync(nvmDir)
        .filter((v) => /^v22\.(2[2-9]|[3-9]\d)/.test(v))   // 22.22+
        .sort()
        .reverse()
        .forEach((v) => candidates.push(`${nvmDir}/${v}/bin/node`));
    } catch { /* ignore */ }
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return 'node';
}

module.exports = {
  apps: [
    {
      name: 'four-quadrants',
      script: 'server/index.js',
      cwd: __dirname,

      interpreter: resolveNode(),
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
