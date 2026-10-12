// ============================================================
// 四象限待办工作台 · 服务入口
// 零依赖：只用 Node 内置模块（http / fs / path / node:sqlite）
// 仅监听 127.0.0.1，不对外暴露
// ============================================================

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { db, ROOT, DB_PATH } from './db.js';
import { handleItems } from './routes/items.js';

// 默认 7788：避开 5173(Vite) / 3000(React) / 4200(Angular) / 8000(Django) 等常见开发端口
const PORT = Number(process.env.PORT) || 7788;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
};

/** 托管 public/ 下的静态文件 */
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 防目录穿越
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error('DIR');

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS：本机开发方便，仅放行本机来源
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleItems(req, res, url);
    }
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[error]', url.pathname, e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: String(e.message || e) } }));
  }
});

server.listen(PORT, HOST, () => {
  const rows = db.prepare('SELECT COUNT(*) AS n FROM items WHERE is_deleted = 0').get();
  console.log('');
  console.log('  四象限待办工作台已启动');
  console.log(`  → http://${HOST}:${PORT}`);
  console.log(`  数据库：${DB_PATH}（当前 ${rows.n} 条任务）`);
  console.log('');
});

process.on('SIGINT', () => { server.close(); db.close(); process.exit(0); });
