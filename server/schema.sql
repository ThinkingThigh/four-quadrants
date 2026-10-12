-- ============================================================
-- 四象限待办工作台 · 数据库结构
-- 幂等：可重复执行，不会破坏已有数据
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- 任务表
-- 注意：不存 quadrant 字段。象限由 important + urgent 派生，
--       避免「拖拽」与「改属性」两条路径写出矛盾数据。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  important     INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0,1)),
  urgent        INTEGER NOT NULL DEFAULT 0 CHECK (urgent    IN (0,1)),
  status        TEXT    NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
  position      REAL    NOT NULL DEFAULT 0,
  completed_at  TEXT,
  is_deleted    INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  deleted_at    TEXT,
  owner_id      TEXT    NOT NULL DEFAULT 'local',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 主查询索引：按象限 + 状态 + 排序
CREATE INDEX IF NOT EXISTS idx_items_bucket
  ON items (important, urgent, status, is_deleted, position);

-- ------------------------------------------------------------
-- 配置表：显示控制等偏好持久化
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ------------------------------------------------------------
-- 操作日志：供撤销与行为分析使用
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER,
  action        TEXT NOT NULL,
  from_quadrant INTEGER,
  to_quadrant   INTEGER,
  from_status   TEXT,
  to_status     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL
);

-- ------------------------------------------------------------
-- 标签表（P3 启用，先建好结构，无需破坏性迁移）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  color      TEXT    NOT NULL DEFAULT '#8B8D98',
  position   REAL    NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS item_labels (
  item_id  INTEGER NOT NULL,
  label_id INTEGER NOT NULL,
  PRIMARY KEY (item_id, label_id),
  FOREIGN KEY (item_id)  REFERENCES items(id)  ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_labels_label ON item_labels (label_id);

-- ------------------------------------------------------------
-- 派生视图：把 important/urgent 折算成象限编号 1-4
--   1 重要且紧急 / 2 重要不紧急 / 3 紧急不重要 / 4 都不
-- ------------------------------------------------------------
DROP VIEW IF EXISTS v_items;
CREATE VIEW v_items AS
SELECT
  i.*,
  CASE
    WHEN i.important = 1 AND i.urgent = 1 THEN 1
    WHEN i.important = 1 AND i.urgent = 0 THEN 2
    WHEN i.important = 0 AND i.urgent = 1 THEN 3
    ELSE 4
  END AS quadrant
FROM items i
WHERE i.is_deleted = 0;

-- ------------------------------------------------------------
-- 默认配置
-- ------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES ('filter.visibility', 'hide_done');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ui.last_quadrant', '4');
