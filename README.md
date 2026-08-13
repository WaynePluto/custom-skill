# custom-skills

个人专用 Coding Agent Skills 集合，可被 Pi、OpenCode、GitHub Copilot（CLI）等支持从 `~/.agents/skills` 加载 Agent Skills 的工具复用。

## 前置要求

- **Python >= 3.10**
- **Node.js >= 20**（部分技能需要）
- **本机安装的 Chrome 或 Edge**（浏览器类技能需要）
- **Windows + PowerShell 7（pwsh）**：项目中的脚本、SKILL 命令示例和 context 文件默认面向 Windows 上的 PowerShell 7 编写，Shell 命令使用 pwsh 7 语法；在其他 OS / Shell 下使用时需自行改写相应命令

## 快速开始

### 一键安装所有技能、context 文件和扩展

```shell
git clone https://github.com/<your-username>/custom-skills.git
cd custom-skills
python scripts/install.py
```

脚本会自动完成：
- 全局技能：依赖下载 → 构建打包 → 部署到 `~/.agents/skills/`
- Context：将 `context/APPEND_SYSTEM.md` 部署到 `~/.pi/agent/`
- 二进制：确保 `grep`、`find` 依赖的 `rg`、`fd` 存在于 `~/.pi/agent/bin/`
- 扩展：将 `extensions/` 下的 Pi 扩展部署到 `~/.pi/agent/extensions/`

`project-skills/` 中的项目级技能不会被默认安装，必须显式指定技能名称和目标项目。

### 只安装指定全局技能

```shell
python scripts/install.py --name local-web-search
```

### 将指定项目级技能安装到项目

```shell
python scripts/install.py --project-skills --project-dir 'D:/dev/empty' --name pixel2ase
```

项目级技能部署到 `<project-dir>/.agents/skills/<name>/`。`--project-skills`、`--project-dir` 和 `--name` 必须同时提供；不支持把全部项目级技能批量安装到一个项目。覆盖已有技能时增加 `--force`。

### 覆盖已安装的技能

```shell
python scripts/install.py --force
```

### 只安装指定类别

不加选择参数时全部安装；加 `--skills`、`--context`、`--extensions`、`--binaries` 则只安装对应类别（可组合）：

```shell
# 只更新 context 文件
python scripts/install.py --context --force

# 只安装技能
python scripts/install.py --skills

# 只部署扩展（会连带检查 rg / fd）
python scripts/install.py --extensions --force

# 只检查二进制依赖，有新版时询问是否升级
python scripts/install.py --binaries
```

### 自定义安装目录

```shell
python scripts/install.py --skills-dir /path/to/skills --pi-agent-dir /path/to/pi/agent
```

### npm scripts 快捷方式

```shell
pnpm run sync         # 等价于 python scripts/install.py
pnpm run sync:force   # 等价于 python scripts/install.py --force
pnpm test             # 跑全部静态测试（Node + Python）
```

注：这些脚本不能叫 `install`（npm 生命周期钩子，`npm install` 会递归触发），也不建议叫 `setup` / `deploy`（与 `pnpm setup`、`pnpm deploy` 内置命令同名）。

## 技能列表

| 技能 | 作用域 | 说明 |
|---|---|---|
| [local-web-search](skills/local-web-search/) | 全局 | 使用本机 Chrome/Edge 进行实时网络搜索、网页阅读和多来源核实 |
| [pixel2ase](project-skills/pixel2ase/) | 项目级 | 将 AI 生成的像素风图片转换为原生分辨率 PNG 和 indexed `.aseprite` 工程 |

## 目录结构

```
custom-skills/
├── scripts/
│   └── install.py            # 全局安装脚本
├── context/
│   └── APPEND_SYSTEM.md     # Pi 系统提示词补充 → ~/.pi/agent/
├── extensions/
│   ├── notify.ts            # Pi 扩展 → ~/.pi/agent/extensions/
│   ├── enable-core-tools.ts # 同上：激活 grep / find / ls
│   └── tools-status.ts      # 同上：/tools-status 工具使用统计
├── tests/
│   ├── *.test.mjs           # 扩展的静态测试（不部署）
│   └── test_*.py            # install.py 的静态测试
├── skills/                    # 默认安装到全局目录
│   └── <skill-name>/
│       ├── SKILL.md           # 技能定义（Agent 读取）
│       ├── README.md          # 人类可读说明
│       ├── package.json       # 依赖声明（如需要）
│       ├── scripts/           # 可执行脚本
│       │   ├── build.mjs      # 构建打包（如有）
│       │   ├── deploy.py      # 自定义部署逻辑（如有）
│       │   └── ...
│       └── tests/             # 测试（不部署）
├── project-skills/            # 按名称分发到任意目标项目
│   └── <skill-name>/
│       ├── SKILL.md
│       └── scripts/
└── AGENTS.md                  # 项目开发规则
```

## 安装原理

### Skills

1. **依赖下载**：在技能源码目录执行 `pnpm install`，获取构建工具和运行时依赖。
2. **部署全局技能**：将 `skills/` 中选中的技能复制到全局目录。
3. **部署项目级技能**：仅在同时提供 `--project-skills --project-dir <目录> --name <技能>` 时，将 `project-skills/<技能>/` 复制到目标项目的 `.agents/skills/<技能>/`。
4. **隔离作用域**：默认安装不会扫描或安装 `project-skills/`。

### Context

`context/` 目录下的 `.md` 文件会被复制到 `~/.pi/agent/`。命名为 `context` 而非 `prompts`，是为了与 Pi 自身的 `~/.pi/agent/prompts/`（提示词模板 / 斜杠命令）区分。目前支持：

| 文件 | 作用 |
|---|---|
| `APPEND_SYSTEM.md` | 追加到 Pi 系统提示词末尾，定义全局行为规则 |

### Extensions

`extensions/` 下的文件和目录会被复制到 `~/.pi/agent/extensions/`，CLI（`pi`）与 GUI（pi-agent-chat）共享同一目录，改动对两边同时生效。

| 扩展 | 作用 |
|---|---|
| `notify.ts` | 任务完成时发送 Windows toast 通知 |
| `enable-core-tools.ts` | 每次 `session_start` 时把 SDK 内置的 `grep` / `find` / `ls` 补进激活集（Pi 默认只激活 `read`/`bash`/`edit`/`write`） |
| `tools-status.ts` | 提供 `/tools-status` 斜杠命令，统计本会话**每个工具**的调用 / 完成 / 出错 / 未完成次数，并附带思考段数等辅助指标 |

`/tools-status` 无参数，一次输出整份报告（范围固定为当前分支，首行为标题行）：

```
工具使用统计（当前分支）
工具调用 106 次 / 5 个工具 · 完成 106 · 未完成 0 · 出错 4（3.8%）
bash: 调用 49 · 完成 49 · 出错 2
read: 调用 29 · 完成 29
edit: 调用 19 · 完成 19 · 出错 2
…
思考 60 段 / 60 轮 · 47749 字符
模型 anthropic/claude · 思考等级 medium
```

口径：工具调用按 assistant 消息里的 `toolCall` 块计，结果按 `toolResult` 消息计，未完成 = 调用 − 结果（Esc 中断 / 崩溃）；用户 `!` 命令（`bashExecution`）不计入工具调用；被扩展拦截的调用与真实失败一样记为 `isError`；subagent 子会话独立记账，父会话里只算 1 次工具调用。

输出通道：一次 `ctx.ui.notify(整份报告)`，CLI 与 GUI 共用同一条路径，效果一致——报告都留在对话流里而不是弹层：TUI 的 `notify(info)` 向聊天区追加一段文本，pi-agent-chat 把扩展的 `notify` 渲染成 transcript 卡片（首行作标题，多行自动折叠）。无 UI 的 `json` / `print` 模式下 `notify` 是 no-op。

口径：思考段数按 `thinking` 块计、思考轮数按含 thinking 的 assistant 消息计；用户 `!` 命令（`bashExecution`）不计入工具调用；被扩展拦截的工具调用与真实失败一样记为 `isError`；subagent 子会话独立记账，父会话里只算 1 次工具调用。详见 `SESSION-STATS-PLAN.md` §2。

`grep` 依赖 `rg`、`find` 依赖 `fd`，二进制统一放在 `~/.pi/agent/bin/`（与 Pi SDK 同一位置，CLI 与 GUI 共用）。安装脚本的处理规则：

| 情况 | 行为 |
|---|---|
| `bin/` 里没有 | 从 GitHub Releases 下载最新版 |
| 下载失败 | **中断安装**，打印资产 URL 和目标路径，手动放好后重跑即可 |
| `bin/` 里已有 | 对比 GitHub 最新版；有新版时询问 `[y/N]`，输入 `y` 才升级（`--force` 不会绕过询问，非交互环境只提示不升级） |
| 升级失败 | 保留原版本，不中断安装 |
| 仅系统 PATH 上有 | 只报告版本，不接管升级 |
| `PI_OFFLINE=1` | 跳过下载和更新检查并提示 |

静态测试：

```shell
# 扩展逻辑
node --experimental-strip-types --test tests/enable-core-tools.test.mjs tests/tools-status.test.mjs

# install.py 的二进制检查/下载/升级逻辑
python -m unittest discover -s tests -p 'test_*.py'
```

开发阶段的 `node_modules/`、`dist/`、lock 文件均不纳入 Git。

## 手动构建（不安装）

如果只想构建而不部署到全局目录：

```shell
cd skills/local-web-search
npm install --ignore-scripts
npm run build
npm test
```

## 添加新技能

1. 全局技能在 `skills/` 下创建目录；必须按名称显式分发到目标项目的技能放在 `project-skills/`。
2. 编写 `SKILL.md`（遵循 Agent Skills 规范）。
3. 如需依赖，添加 `package.json`。
4. 如需自定义部署逻辑，添加 `scripts/deploy.py`。
5. 添加测试到 `tests/`。
6. 全局技能运行 `python scripts/install.py --name <skill-name>` 验证；项目级技能运行 `python scripts/install.py --project-skills --project-dir <project-root> --name <skill-name>` 验证。
