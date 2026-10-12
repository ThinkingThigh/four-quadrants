// ============================================================
// 任务相关 API
// 业务规则（象限反推、position 计算、计数）全部在这一层完成，
// 前端不持有任何业务规则。
// ============================================================

import { db, rowToItem } from '../db.js';

const MAX_TITLE = 200;
const STEP = 1024;        // position 递进步长
const MIN_GAP = 1e-6;     // 精度下限，低于此值触发整体重排

/* ---------- 工具 ---------- */

function nowLocal() {
  // 与 SQLite datetime('now','localtime') 保持同一格式
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 象限编号 → important / urgent */
function quadrantToFlags(q) {
  return {
    important: (q === 1 || q === 2) ? 1 : 0,
    urgent: (q === 1 || q === 3) ? 1 : 0,
  };
}

/** important / urgent → 象限编号 */
function flagsToQuadrant(important, urgent) {
  if (important && urgent) return 1;
  if (important && !urgent) return 2;
  if (!important && urgent) return 3;
  return 4;
}

function fail(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function ok(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('BODY_TOO_LARGE'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('BAD_JSON')); }
    });
    req.on('error', reject);
  });
}

function getItemById(id) {
  return db.prepare('SELECT * FROM v_items WHERE id = ?').get(id);
}

/** 某象限当前的 position 最大值 */
function maxPositionIn(important, urgent) {
  const r = db.prepare(
    `SELECT MAX(position) AS m FROM items
     WHERE important = ? AND urgent = ? AND is_deleted = 0`
  ).get(important, urgent);
  return r && r.m != null ? r.m : 0;
}

/** 整体重排：把某象限内所有任务的 position 拉回 1024 的整数倍 */
function resequence(important, urgent) {
  const rows = db.prepare(
    `SELECT id FROM items
     WHERE important = ? AND urgent = ? AND is_deleted = 0
     ORDER BY position ASC, id ASC`
  ).all(important, urgent);

  const upd = db.prepare('UPDATE items SET position = ? WHERE id = ?');
  rows.forEach((row, i) => upd.run((i + 1) * STEP, row.id));
  return rows.map((row, i) => ({ id: row.id, position: (i + 1) * STEP }));
}

function logActivity({ itemId, action, fromQ, toQ, fromStatus, toStatus }) {
  db.prepare(
    `INSERT INTO activity_log
       (item_id, action, from_quadrant, to_quadrant, from_status, to_status)
     VALUES (?,?,?,?,?,?)`
  ).run(itemId ?? null, action, fromQ ?? null, toQ ?? null, fromStatus ?? null, toStatus ?? null);
}

/** 统计（口径与界面一致：byQuadrant 统计未完成数） */
function buildStats() {
  const rows = db.prepare('SELECT important, urgent, status FROM items WHERE is_deleted = 0').all();

  const byQuadrant = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const doneByQuadrant = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let todo = 0, done = 0;

  for (const r of rows) {
    const q = flagsToQuadrant(r.important, r.urgent);
    if (r.status === 'done') { done++; doneByQuadrant[q]++; }
    else { todo++; byQuadrant[q]++; }
  }

  const total = rows.length;
  return {
    total,
    todo,
    done,
    rate: total ? Math.round((done / total) * 100) : 0,
    byQuadrant,
    doneByQuadrant,
  };
}

/* ---------- 路由处理 ---------- */

/** GET /api/items */
function listItems(req, res, url) {
  const status = url.searchParams.get('status') || 'all';
  const quadrant = url.searchParams.get('quadrant');
  const includeDeleted = url.searchParams.get('include_deleted') === '1';
  const onlyDeleted = url.searchParams.get('only_deleted') === '1';

  const where = [];
  const args = [];

  // 删除态过滤
  if (onlyDeleted) {
    where.push('is_deleted = 1');
  } else if (!includeDeleted) {
    where.push('is_deleted = 0');
  }
  // includeDeleted 为真且无 onlyDeleted：两者都要

  if (status === 'todo') where.push("status = 'todo'");
  else if (status === 'done') where.push("status = 'done'");

  if (quadrant) {
    const f = quadrantToFlags(Number(quadrant));
    where.push('important = ? AND urgent = ?');
    args.push(f.important, f.urgent);
  }

  // 直接用 items 表，象限在 JS 里折算，避免视图与软删除条件打架
  const sql = 'SELECT * FROM items' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY is_deleted ASC, important DESC, urgent DESC, position ASC, id ASC';

  const rows = db.prepare(sql).all(...args);

  const items = rows.map((r) => rowToItem({
    ...r,
    quadrant: flagsToQuadrant(r.important, r.urgent),
  }));

  ok(res, 200, { items, stats: buildStats() });
}

/** POST /api/items */
async function createItem(req, res) {
  const body = await readBody(req);
  const title = String(body.title ?? '').trim();

  if (!title) return fail(res, 400, 'VALIDATION_ERROR', '标题不能为空');
  if (title.length > MAX_TITLE) return fail(res, 400, 'VALIDATION_ERROR', `标题不能超过 ${MAX_TITLE} 字`);

  // 目标象限：显式传入优先，否则读配置
  let quadrant = Number(body.quadrant);
  if (![1, 2, 3, 4].includes(quadrant)) {
    const cfg = db.prepare("SELECT value FROM settings WHERE key = 'ui.last_quadrant'").get();
    quadrant = cfg ? Number(cfg.value) : 4;
  }

  const { important, urgent } = quadrantToFlags(quadrant);
  const position = maxPositionIn(important, urgent) + STEP;
  const ts = nowLocal();

  const info = db.prepare(
    `INSERT INTO items (title, note, important, urgent, status, position, created_at, updated_at)
     VALUES (?,?,?,?, 'todo', ?, ?, ?)`
  ).run(title, String(body.note ?? ''), important, urgent, position, ts, ts);

  const id = Number(info.lastInsertRowid);

  // 记住落位象限
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('ui.last_quadrant', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(String(quadrant), ts);

  logActivity({ itemId: id, action: 'create', toQ: quadrant, toStatus: 'todo' });

  ok(res, 201, { item: rowToItem(getItemById(id)) });
}

/** PATCH /api/items/:id */
async function patchItem(req, res, id) {
  const existing = getItemById(id);
  if (!existing) return fail(res, 404, 'NOT_FOUND', '任务不存在');

  const body = await readBody(req);
  const sets = [];
  const args = [];

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return fail(res, 400, 'VALIDATION_ERROR', '标题不能为空');
    if (title.length > MAX_TITLE) return fail(res, 400, 'VALIDATION_ERROR', `标题不能超过 ${MAX_TITLE} 字`);
    sets.push('title = ?'); args.push(title);
  }

  if (body.note !== undefined) {
    sets.push('note = ?'); args.push(String(body.note));
  }

  if (body.important !== undefined || body.urgent !== undefined) {
    const important = body.important !== undefined ? (body.important ? 1 : 0) : existing.important;
    const urgent = body.urgent !== undefined ? (body.urgent ? 1 : 0) : existing.urgent;
    sets.push('important = ?', 'urgent = ?');
    args.push(important, urgent);

    // 换了象限：position 放到新象限末尾
    if (important !== existing.important || urgent !== existing.urgent) {
      sets.push('position = ?');
      args.push(maxPositionIn(important, urgent) + STEP);
      logActivity({
        itemId: id, action: 'move',
        fromQ: existing.quadrant,
        toQ: flagsToQuadrant(important, urgent),
      });
    }
  }

  if (body.status !== undefined) {
    const status = body.status === 'done' ? 'done' : 'todo';
    if (status !== existing.status) {
      sets.push('status = ?'); args.push(status);
      if (status === 'done') { sets.push('completed_at = ?'); args.push(nowLocal()); }
      else { sets.push('completed_at = NULL'); }
      logActivity({ itemId: id, action: 'complete', fromStatus: existing.status, toStatus: status });
    }
  }

  if (!sets.length) return ok(res, 200, { item: rowToItem(existing) });

  sets.push('updated_at = ?'); args.push(nowLocal());
  args.push(id);

  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...args);

  ok(res, 200, { item: rowToItem(getItemById(id)) });
}

/**
 * PATCH /api/items/:id/move —— 拖拽落点，原子操作
 * body: { to_quadrant, before_id, after_id }
 * before_id / after_id 为落点的前后邻居（可为 null）
 */
async function moveItem(req, res, id) {
  const existing = getItemById(id);
  if (!existing) return fail(res, 404, 'NOT_FOUND', '任务不存在');

  const body = await readBody(req);
  const toQuadrant = Number(body.to_quadrant);
  if (![1, 2, 3, 4].includes(toQuadrant)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'to_quadrant 必须是 1-4');
  }

  const { important, urgent } = quadrantToFlags(toQuadrant);
  const beforeId = body.before_id ?? null;
  const afterId = body.after_id ?? null;

  let reordered = false;
  let affected = [];

  db.exec('BEGIN');
  try {
    const getPos = db.prepare('SELECT position FROM items WHERE id = ?');

    // 前邻居：落点上方那一条；没有则视作 0
    let posBefore = 0;
    if (beforeId) {
      const r = getPos.get(beforeId);
      if (r) posBefore = r.position;
    }

    // 后邻居：落点下方那一条；没有则视作「前面留一大段」
    let posAfter;
    if (afterId) {
      const r = getPos.get(afterId);
      if (r) posAfter = r.position;
    }
    if (posAfter === undefined) posAfter = posBefore + STEP * 2;

    // 精度耗尽 → 先整体重排，再重算
    if (posAfter - posBefore < MIN_GAP) {
      affected = resequence(important, urgent);
      reordered = true;

      let pb = 0;
      if (beforeId) { const r = getPos.get(beforeId); if (r) pb = r.position; }
      let pa;
      if (afterId) { const r = getPos.get(afterId); if (r) pa = r.position; }
      if (pa === undefined) pa = pb + STEP * 2;
      posBefore = pb; posAfter = pa;

      if (posAfter - posBefore < MIN_GAP) posAfter = posBefore + STEP;
    }

    const newPosition = (posBefore + posAfter) / 2;
    const quadChanged = (existing.important !== important || existing.urgent !== urgent);

    db.prepare(
      `UPDATE items SET important = ?, urgent = ?, position = ?, updated_at = ? WHERE id = ?`
    ).run(important, urgent, newPosition, nowLocal(), id);

    if (quadChanged) {
      logActivity({
        itemId: id, action: 'move',
        fromQ: existing.quadrant, toQ: toQuadrant,
      });
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  ok(res, 200, {
    item: rowToItem(getItemById(id)),
    reordered,
    affected,
  });
}

/** DELETE /api/items/:id —— 软删除 */
function deleteItem(req, res, id) {
  const existing = getItemById(id);
  if (!existing) return fail(res, 404, 'NOT_FOUND', '任务不存在');

  const ts = nowLocal();
  db.prepare('UPDATE items SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(ts, ts, id);

  logActivity({ itemId: id, action: 'delete', fromQ: existing.quadrant });

  ok(res, 200, { ok: true, id });
}

/** POST /api/items/:id/restore */
function restoreItem(req, res, id) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'NOT_FOUND', '任务不存在');

  db.prepare('UPDATE items SET is_deleted = 0, deleted_at = NULL, updated_at = ? WHERE id = ?')
    .run(nowLocal(), id);

  logActivity({ itemId: id, action: 'restore' });

  ok(res, 200, { ok: true, id });
}

/** GET /api/settings */
function getSettings(req, res) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  ok(res, 200, out);
}

/** PATCH /api/settings */
async function patchSettings(req, res) {
  const body = await readBody(req);
  const ts = nowLocal();
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  for (const [k, v] of Object.entries(body)) stmt.run(k, String(v), ts);

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  ok(res, 200, out);
}

/* ---------- 分发 ---------- */

export async function handleItems(req, res, url) {
  const { pathname } = url;
  const method = req.method.toUpperCase();

  // /api/items
  if (pathname === '/api/items') {
    if (method === 'GET') return listItems(req, res, url);
    if (method === 'POST') return createItem(req, res);
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '方法不支持');
  }

  // /api/items/:id/...
  const m = pathname.match(/^\/api\/items\/(\d+)(\/move|\/restore)?$/);
  if (m) {
    const id = Number(m[1]);
    const sub = m[2];

    if (sub === '/move' && method === 'PATCH') return moveItem(req, res, id);
    if (sub === '/restore' && method === 'POST') return restoreItem(req, res, id);
    if (!sub && method === 'PATCH') return patchItem(req, res, id);
    if (!sub && method === 'DELETE') return deleteItem(req, res, id);

    return fail(res, 405, 'METHOD_NOT_ALLOWED', '方法不支持');
  }

  // /api/settings
  if (pathname === '/api/settings') {
    if (method === 'GET') return getSettings(req, res);
    if (method === 'PATCH') return patchSettings(req, res);
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '方法不支持');
  }

  return fail(res, 404, 'NOT_FOUND', '接口不存在');
}
