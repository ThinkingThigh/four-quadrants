# 四象限待办工作台

一个基于**艾森豪威尔四象限**（重要 / 紧急）的本地待办工作台。把任务拖进对应象限，一眼看清该立刻做、该排计划、该委托掉、该直接砍的事。

数据全部存在本机 SQLite 文件里，可随时复制备份。

---

## 运行

需要 **Node.js 22.5 或以上**（用到内置的 `node:sqlite`，无需安装任何第三方依赖）。

### 方式一：pm2 托管（推荐，已在用）

服务已由 pm2 托管，开机后自动恢复、崩溃自动重启，不需要手动启动。

```bash
pm2 list                      # 查看运行状态
pm2 logs four-quadrants       # 实时看日志
pm2 restart four-quadrants    # 重启
pm2 stop four-quadrants       # 停止
pm2 delete four-quadrants     # 移除托管
```

配置文件是 `ecosystem.config.cjs`，日志在 `logs/`。

**配置开机自启**（需要 sudo，只需执行一次）：

```bash
cd four-quadrants
sudo bash scripts/setup-pm2-startup.sh
```

脚本做三件事：注册 launchd 自启项 → 保存进程快照 → 校验结果。
路径全部自动推导，无需手工修改。重启电脑后 pm2 会自动拉起 `four-quadrants`。

> 端口固定为 **7788**。选它是因为 5173 是 Vite 默认端口、3000 是 React/Next 默认端口，
> 容易和本地其它前端项目撞车。改端口就改 `ecosystem.config.cjs` 里的 `PORT`。

### ⚠️ 关于 node 版本

项目依赖 Node 内置的 `node:sqlite`，**需 Node 22.5+**。
`ecosystem.config.cjs` 里的 `interpreter` 是写死的绝对路径，**换机器或换 node 版本时必须改**。

```js
const NODE = '/Users/tal/.nvm/versions/node/v22.16.0/bin/node';
```

注意：**v18.20.8 也装了 pm2，但它的 node 不支持 `node:sqlite`**，选错会起不来。
详细排查与踩坑记录见 **[docs/部署与运维.md](docs/部署与运维.md)**。

### 方式二：直接运行

```bash
cd four-quadrants
node server/index.js
```

然后打开 **http://127.0.0.1:7788**

首次启动会自动创建 `data/todo.db`，无需任何初始化步骤。

换端口：

```bash
PORT=8080 node server/index.js
```

---

## 使用

界面就是**四个撑满屏幕的象限**，没有顶栏和侧栏。所有操作都在**右下角的圆形按钮**里。

点右下角 `+` 展开控制台，包含三块：

| 区域 | 能做什么 |
| --- | --- |
| **添加任务** | 输入标题回车创建；先在下面选好落到哪个象限 |
| **显示** | 在「全部 / 隐藏已完成 / 仅看已完成」之间切换，选择会被记住 |
| **回收站** | 查看已删除任务，点「恢复」找回 |

**任务卡片**：

- 点左侧方框 → 标记完成（再点一次取消）
- 拖左侧 `⠿` 手柄 → 移动；拖到别的象限＝改变重要/紧急，拖到同象限别的位置＝调整顺序
- 悬停卡片右侧 → 出现「编辑」「删除」
- 双击标题 → 就地改标题
- 删除后有 5 秒可以点「撤销」

**显示控制**的默认值是「隐藏已完成」，这样界面保持清爽。想看完成记录就切到「仅看已完成」。

---

## 数据

| 项 | 说明 |
| --- | --- |
| 位置 | `data/todo.db` |
| 格式 | SQLite 单文件（WAL 模式） |
| 备份 | 直接复制该文件即可 |
| 删除 | 为软删除，任务仍在库里，可从回收站恢复 |

数据库结构见 `server/schema.sql`，共 5 张表（`items` / `settings` / `activity_log` / `labels` / `item_labels`）+ 1 个视图 `v_items`。

---

## 项目结构

```
four-quadrants/
├─ server/
│   ├─ index.js          服务入口，静态托管 + 路由分发
│   ├─ db.js             数据库连接与初始化
│   ├─ schema.sql        建表语句（幂等）
│   └─ routes/items.js   任务 API 与业务规则
├─ public/
│   ├─ index.html        页面骨架
│   ├─ styles.css        全部样式（设计令牌在文件顶部）
│   ├─ app.js            状态、渲染、事件
│   ├─ api.js            接口封装
│   └─ drag.js           拖拽（Pointer Events 自实现）
├─ data/todo.db          数据文件（自动生成）
├─ logs/                 pm2 日志（out.log / err.log）
├─ ecosystem.config.cjs  pm2 进程配置
└─ docs/                 需求与设计、视觉稿
```

---

## 设计要点

**为什么只有一个悬浮按钮？** 工作台是每天要看好几次的地方，布局越少越好。四象限占满屏幕，功能收进一个按钮，不占视野。

**颜色只做标记，不做背景。** 象限颜色仅出现在表头左侧一条 2px 色条和卡片上的 6px 色点上。大面积铺色会让界面发俗。

**象限不存进数据库。** 任务只存 `important` 和 `urgent` 两个布尔值，象限由代码推导。这样「拖到某象限」和「修改属性」两条路径不可能写出矛盾数据。

**排序用分数。** 拖拽落点取前后两个任务 position 的中值，一次只改一条记录。精度耗尽时才整象限重排。

**拖拽用 Pointer Events 自己写。** 不用 HTML5 原生拖拽，才能做到卡片跟手浮起、落点精确预览，并且鼠标和触屏共用一套逻辑。

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/items` | 列表 + 统计 |
| POST | `/api/items` | 新建 |
| PATCH | `/api/items/:id` | 改标题 / 备注 / 完成状态 / 象限 |
| PATCH | `/api/items/:id/move` | 拖拽落点（原子操作） |
| DELETE | `/api/items/:id` | 软删除 |
| POST | `/api/items/:id/restore` | 恢复 |
| GET / PATCH | `/api/settings` | 读 / 写配置 |

---

## 说明

服务只监听 `127.0.0.1`，不对外暴露，适合本机自用。
