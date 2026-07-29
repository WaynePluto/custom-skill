---
name: fetch-rebase
description: 从远程仓库拉取最新代码并 rebase 到当前本地分支。当用户执行 /fetch-rebase、要求同步最新代码、拉取远程更新、或 rebase 到远程分支时使用。不适用于 merge 工作流或非 Git 仓库。
compatibility: Windows/macOS/Linux、Git 2.0+。
---

# Fetch & Rebase

从远程仓库获取最新提交，然后将当前本地分支 rebase 到其上游跟踪分支。

## 使用原则

- 仅在 Git 仓库中使用。执行前确认当前目录处于 Git 仓库内。
- 不修改用户的 Git 全局配置。
- rebase 遇到冲突时停止并报告，不自动解决冲突。

## 工作流

按顺序执行以下步骤，任何一步失败则停止并向用户报告原因。

### 1. 前置检查

```shell
git rev-parse --is-inside-work-tree
```

如果不在 Git 仓库中，告知用户并停止。

### 2. 获取当前分支和上游信息

```shell
git branch --show-current
```

如果处于 detached HEAD 状态（输出为空），告知用户并停止。

```shell
git rev-parse --abbrev-ref '@{upstream}'
```

如果当前分支没有设置上游跟踪分支，告知用户可以用 `git branch --set-upstream-to=<remote>/<branch>` 设置，然后停止。

### 3. 检查工作区状态

```shell
git status --porcelain
```

如果有未提交的更改（输出不为空），自动执行 `git stash push -m "fetch-rebase: auto stash"` 暂存更改，并在流程结束后恢复。记住已执行 stash。

### 4. Fetch 远程

从上游信息中提取 remote 名称（`/` 之前的部分），然后 fetch：

```shell
git fetch <remote>
```

### 5. Rebase

```shell
git rebase '@{upstream}'
```

- **成功**：报告 rebase 完成，显示更新的提交数（对比 rebase 前后的 HEAD）。
- **冲突**：报告冲突文件列表，提示用户手动解决后执行 `git rebase --continue`，或执行 `git rebase --abort` 取消。如果之前执行了 stash，提醒用户解决冲突并完成 rebase 后需手动执行 `git stash pop`。

### 6. 恢复暂存

如果第 3 步执行了 stash 且 rebase 成功（无冲突）：

```shell
git stash pop
```

如果 stash pop 产生冲突，报告并提示用户手动解决。

### 7. 报告结果

向用户简要报告：
- 分支名和上游分支名
- fetch 和 rebase 是否成功
- 是否有新提交被应用
- 工作区暂存是否已恢复
