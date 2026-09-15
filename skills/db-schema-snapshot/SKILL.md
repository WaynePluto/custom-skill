---
name: db-schema-snapshot
description: 通过生成临时 schema 快照帮助 AI 准确了解 SQLite / PostgreSQL 数据库的当前结构：先从真实库（只读）或迁移文件生成快照建立全貌，疑点再回迁移文件查演化与意图，迁移是唯一写入路径。当用户要求分析数据库结构、表关系、字段含义，或开发任务需要先读懂现有库表时使用。不适用于修改表结构（只能新增迁移）、导出或修改业务数据、性能调优。
compatibility: 通用；SQLite 依赖 Python 3.10+（仅标准库）；PostgreSQL 依赖 pg_dump 客户端。
---

# 通过临时快照了解数据库

先快照、后细节：快照回答"现在长什么样"，迁移记录回答"为什么长这样"。三条边界优先于一切步骤：

1. **迁移是唯一写入路径。** 本技能全程只读。要改表结构只能在项目中新增迁移，不允许直接改库，也不允许手改快照冒充现状。
2. **快照是机器产物。** 只能用 `scripts/db_snapshot.py` 或项目自身的迁移代码生成，禁止手写或手改快照内容；怀疑过期就重新生成。
3. **快照是临时文件。** 放 `<项目>/.ai/`（确认已被 .gitignore 覆盖）或系统临时目录，不入 Git；任务收尾删除。

## 1. 识别数据库与迁移形态

- SQLite：`Get-ChildItem -Recurse -Include *.db,*.sqlite,*.sqlite3 -File` 排除 node_modules 与构建产物，确认有无真实库文件。
- PostgreSQL：从环境变量、应用配置或 docker-compose 里找连接串，并确认本机有 pg_dump。
- 迁移形态：编号 .sql 目录 / 代码内嵌迁移数组（如 TS）/ 无迁移。

## 2. 生成快照

### SQLite：真实库文件（存在则优先）

```powershell
python scripts/db_snapshot.py sqlite --file <db路径> --out <项目>/.ai/schema-v<user_version>.sql
```

- 脚本以 read-only URI 打开，应用运行中读取也安全；头部记录 `PRAGMA user_version`，供过期判断。
- 红线：不要直接复制 .db 文件当快照——WAL 未 checkpoint 时副本会缺最近写入。
- 若只读打开失败（应用异常退出留下的 WAL 库），把 .db / -wal / -shm 三个文件一起复制后再对副本执行。

### SQLite：编号 .sql 迁移目录（无库文件，或要预览迁移结果）

```powershell
python scripts/db_snapshot.py sqlite --migrations <迁移目录> --out <项目>/.ai/schema.sql
```

- 按文件名排序应用到 `:memory:` 临时库，完全不碰真实库；某条迁移失败则整条命令报错退出，不产出快照。

### SQLite：代码内嵌迁移（如 TS 里的迁移数组）

写一次性 runner，复用项目自身的迁移定义建临时库文件，再用 `--file` 模式导出：

```ts
// 一次性 runner（用后即删）；import 路径按项目实际的迁移导出调整
import { DatabaseSync } from 'node:sqlite'
import { STORE_MIGRATIONS } from './src/store/migrations.js'

const db = new DatabaseSync('.ai/tmp-build.sqlite')
for (const m of STORE_MIGRATIONS) {
  db.exec(m.sql)
  db.exec(`PRAGMA user_version = ${m.version}`)
}
db.close()
```

```powershell
python scripts/db_snapshot.py sqlite --file <项目>/.ai/tmp-build.sqlite --out <项目>/.ai/schema-v4.sql
```

- 关键：必须 import 项目自身的迁移定义，禁止把迁移 SQL 复制进 runner（复制会漂移）。
- 用完删除 tmp-build.sqlite。

### PostgreSQL

```powershell
python scripts/db_snapshot.py pg --conn "<连接串>" --out <项目>/.ai/schema-pg.sql
```

- 内部执行 `pg_dump --schema-only --no-owner --no-privileges`，快照不含数据；头部已打码连接串中的密码。
- PG 没有跨项目通用的版本号可比对，快照按会话级对待，跨会话使用前重新生成。

## 3. 从快照建立全貌

- 先读头部：生成时间、来源、user_version、对象计数。
- 表结构看列 / 主键 / 外键 / CHECK；SQLite 的外键与 CHECK 就在 CREATE TABLE 原文里，PostgreSQL 的外键在文件末尾的 `ALTER TABLE ... ADD CONSTRAINT` 段。
- 索引名通常暗示查询模式；视图与触发器单独留意。
- 快照只包含"是什么"；"为什么、何时引入"不在快照里。

## 4. 回迁移文件查意图

- 先只扫迁移列表的 version + name（或迁移文件名）当时间线，几乎零成本。
- 只对有疑点的对象读对应那条迁移的 SQL 与注释；例如某列是 v4 加的，就只读 v4 那条。
- 快照与时间线都解释不了时，再查该表相关的应用代码调用点。

## 5. 过期与清理

- SQLite：文件名里的 user_version 与当前库 `PRAGMA user_version`（或迁移最高版本）比对，落后即重新生成。
- PostgreSQL：默认每次重新生成。
- 任务收尾：删除快照与临时构建库；不要把快照提交进 Git。
