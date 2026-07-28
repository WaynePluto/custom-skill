---
name: git-commit
description: 创建符合规范的 Git commit，遵循 Conventional Commits 格式和项目约定
---

请按照以下规范创建 Git commit：

## Commit 格式规范

### 基本格式

```
<type>: <subject>

<body>

<footer>
```

### Type 类型

- **feat** - 新功能
- **fix** - 修复 bug
- **refactor** - 重构代码（既不是新功能也不是修复）
- **style** - 代码格式调整（不影响代码逻辑）
- **docs** - 文档更新
- **test** - 测试相关
- **chore** - 构建工具、辅助工具的变动
- **wip** - 进行中的工作（Work In Progress）
- **perf** - 性能优化

### Subject 主题

- 使用中文描述
- 简洁明了，不超过 50 字
- 不以句号结尾
- 使用祈使句语气（如"添加"、"修复"而非"添加了"、"已修复"）

### Body 正文

- 详细描述本次提交的内容
- 可以分多条列举
- 每行不超过 72 字符
- 解释 **what** 和 **why**，而不是 **how**

### Footer 脚注

- 关联 Issue：`#123`
- Breaking Changes：`BREAKING CHANGE: 详细说明`

## 常用模板

### 新功能

```
feat: 添加用户登录功能

- 新增登录界面
- 实现表单验证
- 集成后端 API
```

### Bug 修复

```
fix: 修复卡牌拖动延迟问题

将长按触发时长从 200ms 降低到 50ms，提升响应速度
```

### 重构

```
refactor: 重构场景管理器

- 将 PauseScene 改为游戏场景内的弹窗
- 新增 PauseManager 管理暂停弹窗
- 删除不必要的场景切换逻辑
```

### 代码格式

```
style: 删除调试日志

清理项目中的 console.log 调试语句，保留错误和警告日志
```

## Commit 步骤

1. **查看改动**

   ```bash
   git status
   git diff
   ```

2. **分批次提交**

   **默认行为**：提交项目里的全部内容，但按逻辑分批次提交多个 commit。

   - 每个 commit 只包含一个逻辑变更（如：一个模块的重构、一个新功能、一个 bug 修复）
   - 每个 commit 都是完整的、可独立理解的
   - 不要把所有改动混在一个 commit 里

   ```bash
   # 第一批：重构相关的文件
   git add path/to/refactored/files
   git commit -m "refactor: 重构 XXX 模块"

   # 第二批：新功能相关的文件
   git add path/to/new/feature/files
   git commit -m "feat: 添加 YYY 功能"

   # 第三批：配置文件、文档等
   git add path/to/config/files
   git commit -m "chore: 更新配置文件"
   ```

3. **确认 commit**
   ```bash
   git log --oneline -5
   ```

4. **创建 commit**

   根据当前 Shell 选择写法。**PowerShell 7（pwsh）不支持 bash 的 HEREDOC**，出现 `<<` 会报 `ParserError: Missing file specification after redirection operator`。

   **PowerShell 7（pi 默认 Shell，推荐）**

   多个 `-m` 拼接，每个 `-m` 为一段，git 自动用空行分隔；body 用内联 here-string 实现多行：

   ```powershell
   git commit -m "feat: 添加功能描述" -m @"
   - 详细说明 1
   - 详细说明 2
   "@
   ```

   也可把整段 message 放进一个 here-string 变量（与 bash HEREDOC 等价）：

   ```powershell
   $msg = @"
   feat: 添加功能描述

   - 详细说明 1
   - 详细说明 2
   "@
   git commit -m $msg
   ```

   **Bash（其他 Shell 环境）**

   ```bash
   git commit -m "$(cat <<'EOF'
   feat: 添加功能描述

   - 详细说明 1
   - 详细说明 2

   EOF
   )"
   ```

   > 注意：pwsh here-string 的结束标记 `"@` 必须顶格写在行首，前面不能有任何空格。

5. **确认 commit**
   ```bash
   git log -1 --pretty=fuller
   ```

## 项目特定规范

### 本项目的 Commit 风格

- 使用中文描述
- 简洁的 subject（通常一行）
- 多个改动时使用 body 列举
- 不强制添加 body，简单改动可以只有 subject

### 示例

PowerShell 7（pi 默认 Shell）：

```powershell
# 简单改动
git commit -m "fix: 修复按钮点击无响应"

# 复杂改动
git commit -m "refactor: 重构暂停菜单为游戏内弹窗" -m @"
- 新增 PauseManager 管理暂停弹窗
- 修改 GameScene 集成暂停功能
- 从调试面板移除暂停场景
- 删除不必要的 resume 参数传递逻辑
"@
```

Bash（其他 Shell 环境）：

```bash
# 复杂改动
git commit -m "$(cat <<'EOF'
refactor: 重构暂停菜单为游戏内弹窗

- 新增 PauseManager 管理暂停弹窗
- 修改 GameScene 集成暂停功能
- 从调试面板移除暂停场景
- 删除不必要的 resume 参数传递逻辑

EOF
)"
```

## 注意事项

- ❌ 不要使用 `git commit -am`（容易误添加不该提交的文件）
- ❌ PowerShell 7 中不要使用 bash 的 HEREDOC（`$(cat <<'EOF' ... EOF)`），会触发 `ParserError`；多行 message 改用多个 `-m` 或 here-string（见“创建 commit”）
- ❌ 不要使用不符合规范的 commit message
- ❌ 不要修改除了格式化以外的业务功能代码。如果提交被异常中断（比如编译失败），请你把问题列出来告诉用户，同时本次任务不提交代码。
- ✅ 每次提交前使用 `git status` 确认改动
- ✅ 大改动前先 `git pull` 确保代码是最新的
- ✅ 提交后使用 `git log -1` 检查 commit 信息

现在请根据你的改动创建合适的 commit，然后执行git commit命令提交你的改动。
