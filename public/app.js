// ============================================================
// 四象限待办工作台 · 主程序
// 职责：内存状态 + 渲染 + 事件绑定 + 乐观更新
// 业务规则（象限反推 / 排序）全在后端，这里只做呈现与提交意图
// ============================================================

import { api } from './api.js';
import { initDrag } from './drag.js';

/* ═════════ 状态 ═════════ */

const state = {
  items: [],          // 当前全部任务（未软删除）
  trash: [],          // 回收站
  stats: null,        // 后端返回的统计
  visibility: 'hide_done',
  lastQuadrant: 4,    // 新建任务默认落位象限
};

const QUADRANTS = [
  { q: 1, name: '重要 · 紧急' },
  { q: 2, name: '重要 · 不紧急' },
  { q: 3, name: '不重要 · 紧急' },
  { q: 4, name: '不重要 · 不紧急' },
];

/* ═════════ DOM ═════════ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const board = $('#board');
const fabWrap = $('#fabWrap');
const fabBtn = $('#fabBtn');
const fabPanel = $('#fabPanel');
const newTitle = $('#newTitle');
const newSubmit = $('#newSubmit');
const qpick = $('#qpick');
const visSeg = $('#visSeg');
const trashList = $('#trashList');
const toastWrap = $('#toastWrap');

/* ═════════ 工具 ═════════ */

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function quadrantToFlags(q) {
  return {
    important: (q === 1 || q === 2) ? 1 : 0,
    urgent: (q === 1 || q === 3) ? 1 : 0,
  };
}

/** 按显示控制过滤 */
function visibleItems() {
  const v = state.visibility;
  if (v === 'only_done') return state.items.filter((it) => it.status === 'done');
  if (v === 'hide_done') return state.items.filter((it) => it.status !== 'done');
  return state.items;
}

/** 取某象限的可见任务，按 position 升序 */
function itemsOf(q) {
  return visibleItems()
    .filter((it) => it.quadrant === q)
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

/* ═════════ 提示 ═════════ */

function toast(msg, { undo = false, onUndo, error = false, ms = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.innerHTML = `<span>${esc(msg)}</span>`;

  if (undo) {
    const btn = document.createElement('span');
    btn.className = 'undo';
    btn.textContent = '撤销';
    btn.addEventListener('click', () => { onUndo?.(); remove(); });
    el.appendChild(btn);
  }

  toastWrap.appendChild(el);

  const timer = setTimeout(remove, ms);
  function remove() {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 180);
  }
}

/* ═════════ 渲染 ═════════ */

function render() {
  for (const { q } of QUADRANTS) {
    const list = $(`.list[data-q="${q}"]`);
    const items = itemsOf(q);

    // 计数：未完成数 / 已完成数（口径恒定为「该象限全部任务」）
    const all = state.items.filter((it) => it.quadrant === q);
    const todoN = all.filter((it) => it.status !== 'done').length;
    const doneN = all.filter((it) => it.status === 'done').length;

    const countEl = $(`.panel[data-q="${q}"] .pcount`);
    countEl.innerHTML = `<b class="n">${todoN}</b><i class="d"> / ${doneN}</i>`;

    renderList(list, items);
  }
}

function renderList(list, items) {
  list.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<span>把任务拖到这里</span><small>松手即完成归类</small>';
    list.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(cardEl(it));
  list.appendChild(frag);
}

function cardEl(it) {
  const card = document.createElement('div');
  card.className = 'card' + (it.status === 'done' ? ' is-done' : '');
  card.dataset.id = it.id;
  card.dataset.q = it.quadrant;

  card.innerHTML = `
    <span class="handle" title="拖动以移动">⠿</span>
    <span class="check ${it.status === 'done' ? 'done' : ''}" role="checkbox"
          aria-checked="${it.status === 'done'}" tabindex="0" title="标记完成"></span>
    <span class="ctitle" title="${esc(it.title)}">${esc(it.title)}</span>
    <span class="dots"></span>
    <span class="actions">
      <span class="edit">编辑</span>
      <span class="del">删除</span>
    </span>
  `;

  // 勾选完成
  const check = card.querySelector('.check');
  check.addEventListener('click', () => toggleDone(it.id));
  check.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleDone(it.id); }
  });

  // 删除
  card.querySelector('.del').addEventListener('click', () => removeItem(it.id));

  // 就地编辑标题
  card.querySelector('.edit').addEventListener('click', () => startEdit(card, it));
  card.querySelector('.ctitle').addEventListener('dblclick', () => startEdit(card, it));

  return card;
}

/* ═════════ 操作 ═════════ */

async function load() {
  try {
    const data = await api.list();
    state.items = data.items;
    state.stats = data.stats;
    render();
    await loadTrash();
  } catch (e) {
    toast('加载失败：' + e.message, { error: true });
  }
}

async function loadTrash() {
  try {
    const data = await api.listTrash();
    state.trash = data.items.map((it) => ({ id: it.id, title: it.title }));
  } catch {
    state.trash = [];
  }
  renderTrash();
}

function renderTrash() {
  if (!state.trash.length) {
    trashList.innerHTML = '<div class="trash-empty">暂无已删除任务</div>';
    return;
  }
  trashList.innerHTML = state.trash.map((it) => `
    <div class="trash-row">
      <span class="t">${esc(it.title)}</span>
      <span class="restore" data-id="${it.id}">恢复</span>
    </div>
  `).join('');

  $$('.trash-row .restore', trashList).forEach((el) => {
    el.addEventListener('click', () => restoreItem(Number(el.dataset.id)));
  });
}

/** 切换完成状态（乐观更新） */
async function toggleDone(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;

  const next = it.status === 'done' ? 'todo' : 'done';
  const prev = { status: it.status, completed_at: it.completed_at };

  it.status = next;
  it.completed_at = next === 'done' ? new Date().toISOString() : null;
  render();

  try {
    const res = await api.update(id, { status: next });
    Object.assign(it, res.item);
    render();
  } catch (e) {
    Object.assign(it, prev);
    render();
    toast('操作失败：' + e.message, { error: true });
  }
}

/** 就地编辑标题 */
function startEdit(card, it) {
  const titleEl = card.querySelector('.ctitle');
  if (!titleEl) return;

  const input = document.createElement('input');
  input.className = 'ctitle-input';
  input.value = it.title;
  input.maxLength = 200;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;

    const val = input.value.trim();
    if (!save || !val || val === it.title) { render(); return; }

    const old = it.title;
    it.title = val;
    render();

    try {
      const res = await api.update(it.id, { title: val });
      Object.assign(it, res.item);
    } catch (e) {
      it.title = old;
      toast('保存失败：' + e.message, { error: true });
    }
    render();
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

/** 删除（带撤销） */
async function removeItem(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;

  const idx = state.items.indexOf(it);

  // 乐观移除
  state.items.splice(idx, 1);
  render();

  try {
    await api.remove(id);
    // 记进回收站列表
    state.trash.unshift({ id: it.id, title: it.title });
    renderTrash();

    toast(`已删除「${it.title}」`, {
      undo: true,
      ms: 5000,
      onUndo: () => restoreItem(id, idx),
    });
  } catch (e) {
    state.items.splice(idx, 0, it);
    render();
    toast('删除失败：' + e.message, { error: true });
  }
}

async function restoreItem(id, atIndex) {
  try {
    await api.restore(id);
    state.trash = state.trash.filter((x) => x.id !== id);
    renderTrash();
    await load();
    toast('已恢复');
  } catch (e) {
    toast('恢复失败：' + e.message, { error: true });
  }
}

/** 新建任务 */
async function createItem() {
  const title = newTitle.value.trim();
  if (!title) { newTitle.focus(); return; }

  const quadrant = state.lastQuadrant;
  newTitle.value = '';

  try {
    const res = await api.create({ title, quadrant });
    state.items.push(res.item);
    render();
    scrollToQuadrant(quadrant, res.item.id);
  } catch (e) {
    newTitle.value = title;
    toast('添加失败：' + e.message, { error: true });
  }
}

function scrollToQuadrant(q, id) {
  const card = $(`.list[data-q="${q}"] .card[data-id="${id}"]`);
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** 拖拽落点提交 */
async function handleMove({ id, toQuadrant, beforeId, afterId }) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;

  // 乐观更新：先改内存
  const snapshot = { ...it };
  const f = quadrantToFlags(toQuadrant);
  it.important = f.important;
  it.urgent = f.urgent;
  it.quadrant = toQuadrant;

  // 估算新 position，让排序立刻正确
  const list = itemsOf(toQuadrant).filter((x) => x.id !== id);
  const posOf = (nid) => list.find((x) => x.id === nid)?.position;
  let pb = beforeId != null && posOf(beforeId) != null ? posOf(beforeId) : 0;
  let pa = afterId != null && posOf(afterId) != null ? posOf(afterId) : pb + 2048;
  it.position = (pb + pa) / 2;

  render();

  try {
    const res = await api.move(id, { toQuadrant, beforeId, afterId });
    Object.assign(it, res.item);

    // 若后端发生整体重排，用返回的 affected 校准其它条目
    if (res.reordered && Array.isArray(res.affected)) {
      for (const a of res.affected) {
        const t = state.items.find((x) => x.id === a.id);
        if (t) t.position = a.position;
      }
    }
    render();
  } catch (e) {
    Object.assign(it, snapshot);
    render();
    toast('移动失败：' + e.message, { error: true });
  }
}

/* ═════════ 浮层控制台 ═════════ */

function openFab(open) {
  fabWrap.classList.toggle('open', open);
  fabBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) setTimeout(() => newTitle.focus(), 60);
}

fabBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openFab(!fabWrap.classList.contains('open'));
});

document.addEventListener('click', (e) => {
  if (!fabWrap.contains(e.target)) openFab(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (fabWrap.classList.contains('open')) openFab(false);
  }
});

fabPanel.addEventListener('click', (e) => e.stopPropagation());

/* 新建 */
newSubmit.addEventListener('click', createItem);
newTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createItem();
});

/* 象限选择 */
qpick.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-q]');
  if (!btn) return;
  $$('button', qpick).forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  state.lastQuadrant = Number(btn.dataset.q);
  api.patchSettings({ 'ui.last_quadrant': state.lastQuadrant }).catch(() => {});
  newTitle.focus();
});

/* 显示控制 */
visSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-v]');
  if (!btn) return;
  syncVisButtons(btn.dataset.v);
  state.visibility = btn.dataset.v;
  render();
  api.patchSettings({ 'filter.visibility': state.visibility }).catch(() => {});
});

function syncVisButtons(v) {
  $$('button', visSeg).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $$('button', qpick).forEach((b) => b.classList.toggle('on', Number(b.dataset.q) === state.lastQuadrant));
}

/* ═════════ 拖拽 ═════════ */

initDrag({
  board,
  getItems: () => state.items,
  onMove: handleMove,
  onDropStart: () => {
    // 拖拽中若浮层开着，收起以免遮挡
    if (fabWrap.classList.contains('open')) openFab(false);
  },
  onDropEnd: () => {},
});

/* ═════════ 启动 ═════════ */

async function boot() {
  try {
    const s = await api.getSettings();
    state.visibility = s['filter.visibility'] || 'hide_done';
    state.lastQuadrant = Number(s['ui.last_quadrant'] || 4);
    syncVisButtons(state.visibility);
    $$('button', qpick).forEach((b) => b.classList.toggle('on', Number(b.dataset.q) === state.lastQuadrant));
  } catch {
    state.visibility = 'hide_done';
  }
  await load();
}

boot();
