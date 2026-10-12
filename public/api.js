// ============================================================
// API 层：只负责发请求，不含任何业务规则
// ============================================================

const BASE = '/api';

async function request(method, path, body) {
  const opt = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opt.body = JSON.stringify(body);

  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

  if (!res.ok) {
    const msg = data?.error?.message || `请求失败（${res.status}）`;
    const err = new Error(msg);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  list() {
    return request('GET', '/items');
  },

  /** 回收站：只看已软删除的任务 */
  listTrash() {
    return request('GET', '/items?only_deleted=1');
  },

  create({ title, note = '', quadrant }) {
    return request('POST', '/items', { title, note, quadrant });
  },

  update(id, patch) {
    return request('PATCH', `/items/${id}`, patch);
  },

  /** 拖拽落点：before/after 为落点前后邻居的 id，可为 null */
  move(id, { toQuadrant, beforeId = null, afterId = null }) {
    return request('PATCH', `/items/${id}/move`, {
      to_quadrant: toQuadrant,
      before_id: beforeId,
      after_id: afterId,
    });
  },

  remove(id) {
    return request('DELETE', `/items/${id}`);
  },

  restore(id) {
    return request('POST', `/items/${id}/restore`);
  },

  getSettings() {
    return request('GET', '/settings');
  },

  patchSettings(patch) {
    return request('PATCH', '/settings', patch);
  },
};
