// ============================================================
// 数据库连接与初始化
// 使用 Node 22 内置的 node:sqlite，零第三方依赖
// ============================================================

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'todo.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// 数据目录可能不存在，先建出来
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// 建表（幂等）
db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

/**
 * 把数据库行转成前端要的对象形态：
 * - 0/1 转成布尔语义更明确的字段
 * - 去掉内部字段
 */
export function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    important: row.important,
    urgent: row.urgent,
    quadrant: row.quadrant,
    status: row.status,
    position: row.position,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export { DB_PATH, ROOT };
