// ============================================================
// 拖拽模块
// 用 Pointer Events 自实现，不用 HTML5 原生拖拽：
//   - 跟手的浮起效果
//   - 精确的落点占位槽
//   - 触屏与鼠标一套逻辑
// ============================================================

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.board        四象限容器
 * @param {Function} opts.getItems        () => items[]，取当前内存数据
 * @param {Function} opts.onMove          async ({id, toQuadrant, beforeId, afterId}) => void
 * @param {Function} opts.onDropStart     () => void，拖拽开始（用于锁 UI）
 * @param {Function} opts.onDropEnd       () => void，拖拽结束
 */
export function initDrag(opts) {
  const { board, getItems, onMove, onDropStart, onDropEnd } = opts;

  let drag = null;   // 拖拽会话
  let placeholder = null;

  const THRESHOLD = 4;   // 位移超过 4px 才算拖拽，避免误触

  /** 找出指针所在的 list */
  function listAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.list') : null;
  }

  /** 根据指针 Y 坐标，算出应插入到哪张卡片之前 */
  function calcInsert(list, y) {
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      if (y < r.top + r.height / 2) return card;
    }
    return null;   // 落在末尾
  }

  /** 把占位槽挪到目标卡片之前 */
  function placePlaceholder(list, beforeCard) {
    if (!placeholder) return;
    if (beforeCard) list.insertBefore(placeholder, beforeCard);
    else list.appendChild(placeholder);
  }

  function onPointerDown(e) {
    const handle = e.target.closest('.handle');
    if (!handle) return;

    const card = handle.closest('.card');
    if (!card) return;

    // 只响应主键 / 触摸
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const rect = card.getBoundingClientRect();
    drag = {
      card,
      id: Number(card.dataset.id),
      fromQuadrant: Number(card.closest('.list').dataset.q),
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      started: false,
      list: null,
      beforeCard: null,
    };

    // 记下原始位置，取消时还原
    drag.homeList = card.parentElement;
    drag.homeNext = card.nextElementSibling;

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e) {
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    // 超过阈值才真正开始拖
    if (!drag.started) {
      if (Math.hypot(dx, dy) < THRESHOLD) return;
      beginDrag();
    }

    // 卡片跟手
    drag.card.style.position = 'fixed';
    drag.card.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.card.style.top = (e.clientY - drag.offsetY) + 'px';
    drag.card.style.width = drag.width + 'px';
    drag.card.style.pointerEvents = 'none';

    // 找落点
    const list = listAt(e.clientX, e.clientY);
    if (list) {
      const before = calcInsert(list, e.clientY);

      // 位置没变就不动，减少重排
      if (list !== drag.list || before !== drag.beforeCard) {
        drag.list = list;
        drag.beforeCard = before;
        placePlaceholder(list, before);
      }

      // 高亮当前象限
      document.querySelectorAll('.panel.drag-over').forEach((p) => {
        if (p !== list.closest('.panel')) p.classList.remove('drag-over');
      });
      list.closest('.panel')?.classList.add('drag-over');
    }
  }

  function beginDrag() {
    drag.started = true;
    onDropStart?.();

    const card = drag.card;
    card.classList.add('dragging');

    // 占位槽先顶替卡片留在原位，再把卡片摘到 body 上跟手
    placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.style.height = drag.height + 'px';

    drag.homeList.replaceChild(placeholder, card);
    document.body.appendChild(card);

    drag.list = drag.homeList;
    drag.beforeCard = placeholder.nextElementSibling;

    document.body.classList.add('dragging-active');
  }

  async function onPointerUp(e) {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);

    if (!drag) return;

    const session = drag;
    drag = null;

    if (!session.started) { cleanupLight(session); return; }

    // 收尾：算最终落点
    const list = session.list || session.homeList;
    const toQuadrant = Number(list.dataset.q);

    // 占位槽的前后邻居（排除被拖的卡片与 ghost）
    const neighbors = placeholder ? siblingsAround(placeholder) : { beforeId: null, afterId: null };

    cleanupHeavy(session);

    try {
      await onMove({
        id: session.id,
        toQuadrant,
        beforeId: neighbors.beforeId,
        afterId: neighbors.afterId,
        item: getItems().find((it) => it.id === session.id),
      });
    } catch (err) {
      console.error('[drag] move failed', err);
      throw err;
    } finally {
      onDropEnd?.();
    }
  }

  /** 取占位槽前后的卡片 id */
  function siblingsAround(el) {
    let prev = el.previousElementSibling;
    while (prev && !prev.classList.contains('card')) prev = prev.previousElementSibling;

    let next = el.nextElementSibling;
    while (next && !next.classList.contains('card')) next = next.nextElementSibling;

    return {
      beforeId: prev ? Number(prev.dataset.id) : null,
      afterId: next ? Number(next.dataset.id) : null,
    };
  }

  /** 只清样式，未真正开始拖拽 */
  function cleanupLight(session) {
    session.card.style.cssText = '';
  }

  /** 彻底还原拖拽态 */
  function cleanupHeavy(session) {
    const card = session.card;

    // 把卡片塞回占位槽的位置
    if (placeholder && placeholder.parentElement) {
      placeholder.parentElement.replaceChild(card, placeholder);
    } else if (session.homeList) {
      session.homeList.appendChild(card);
    }

    card.style.cssText = '';
    card.classList.remove('dragging');

    placeholder?.remove();
    placeholder = null;

    document.querySelectorAll('.panel.drag-over').forEach((p) => p.classList.remove('drag-over'));
    document.body.classList.remove('dragging-active');
  }

  board.addEventListener('pointerdown', onPointerDown);

  return {
    destroy() {
      board.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    },
  };
}
