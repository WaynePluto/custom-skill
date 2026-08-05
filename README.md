# custom-skills

个人专用 Coding Agent Skills 集合，可被 Pi、OpenCode、GitHub Copilot（CLI）等支持从 `~/.agents/skills` 加载 Agent Skills 的工具复用。

## 前置要求

- **Python >= 3.10**
- **Node.js >= 20**（部分技能需要）
- **本机安装的 Chrome 或 Edge**（浏览器类技能需要）
- **Windows + PowerShell 7（pwsh）**：项目中的脚本、SKILL 命令示例和 prompts 默认面向 Windows 上的 PowerShell 7 编写，Shell 命令使用 pwsh 7 语法；在其他 OS / Shell 下使用时需自行改写相应命令

## 快速开始

### 一键安装所有技能、prompts 和扩展

```shell
git clone https://github.com/<your-username>/custom-skills.git
cd custom-skills
python scripts/install.py
```

脚本会自动完成：
- 全局技能：依赖下载 → 构建打包 → 部署到 `~/.agents/skills/`
- Prompts：将 `prompts/APPEND_SYSTEM.md` 部署到 `~/.pi/agent/`
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

不加选择参数时全部安装；加 `--skills`、`--prompts`、`--extensions` 则只安装对应类别（可组合）：

```shell
# 只更新 prompts
python scripts/install.py --prompts --force

# 只安装技能
python scripts/install.py --skills

# 只部署扩展
python scripts/install.py --extensions --force
```

### 自定义安装目录

```shell
python scripts/install.py --skills-dir /path/to/skills --pi-agent-dir /path/to/pi/agent
```

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
├── prompts/
│   └── APPEND_SYSTEM.md     # Pi 系统提示词补充 → ~/.pi/agent/
├── extensions/
│   └── notify.ts            # Pi 扩展 → ~/.pi/agent/extensions/
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

### Prompts

`prompts/` 目录下的 `.md` 文件会被复制到 `~/.pi/agent/`。目前支持：

| 文件 | 作用 |
|---|---|
| `APPEND_SYSTEM.md` | 追加到 Pi 系统提示词末尾，定义全局行为规则 |

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
