# custom-skills

个人专用 Coding Agent Skills 集合，可被 Pi、Claude Code 等支持 Agent Skills 的工具复用。

## 前置要求

- **Python >= 3.10**
- **Node.js >= 20**（部分技能需要）
- **本机安装的 Chrome 或 Edge**（浏览器类技能需要）

## 快速开始

### 一键安装所有技能和 prompts

```bash
git clone https://github.com/<your-username>/custom-skills.git
cd custom-skills
python scripts/install.py
```

脚本会自动完成：
- 技能：依赖下载 → 构建打包 → 部署到 `~/.agents/skills/`
- Prompts：将 `prompts/APPEND_SYSTEM.md` 部署到 `~/.pi/agent/`

### 只安装指定技能

```bash
python scripts/install.py --name local-web-search
```

### 覆盖已安装的技能

```bash
python scripts/install.py --force
```

### 只更新 prompts（不安装技能）

```bash
python scripts/install.py --no-skills --force
```

### 只安装技能（不更新 prompts）

```bash
python scripts/install.py --no-prompts
```

### 自定义安装目录

```bash
python scripts/install.py --skills-dir /path/to/skills --pi-agent-dir /path/to/pi/agent
```

## 技能列表

| 技能 | 说明 |
|---|---|
| [local-web-search](skills/local-web-search/) | 使用本机 Chrome/Edge 进行实时网络搜索、网页阅读和多来源核实 |

## 目录结构

```
custom-skills/
├── scripts/
│   └── install.py            # 全局安装脚本
├── prompts/
│   └── APPEND_SYSTEM.md     # Pi 系统提示词补充 → ~/.pi/agent/
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md           # 技能定义（Agent 读取）
│       ├── README.md          # 人类可读说明
│       ├── package.json       # 依赖声明（如需要）
│       ├── scripts/           # 可执行脚本
│       │   ├── build.mjs      # 构建打包（如有）
│       │   ├── deploy.py      # 自定义部署逻辑（如有）
│       │   └── ...
│       └── tests/             # 测试（不部署）
└── AGENTS.md                  # 项目开发规则
```

## 安装原理

### Skills

1. **依赖下载**：在技能源码目录执行 `npm install`，获取构建工具和运行时依赖。
2. **构建打包**：执行 `npm run build`，将可打包的库编译到 `dist/`，减小部署体积。
3. **部署**：将打包产物、SKILL.md、运行脚本复制到全局目录，只安装无法打包的运行时依赖。

### Prompts

`prompts/` 目录下的 `.md` 文件会被复制到 `~/.pi/agent/`。目前支持：

| 文件 | 作用 |
|---|---|
| `APPEND_SYSTEM.md` | 追加到 Pi 系统提示词末尾，定义全局行为规则 |

开发阶段的 `node_modules/`、`dist/`、lock 文件均不纳入 Git。

## 手动构建（不安装）

如果只想构建而不部署到全局目录：

```bash
cd skills/local-web-search
npm install --ignore-scripts
npm run build
npm test
```

## 添加新技能

1. 在 `skills/` 下创建新目录。
2. 编写 `SKILL.md`（遵循 Agent Skills 规范）。
3. 如需依赖，添加 `package.json` 并配置 `build` 脚本。
4. 如需自定义部署逻辑，添加 `scripts/deploy.py`。
5. 添加测试到 `tests/`。
6. 运行 `python scripts/install.py --name <skill-name>` 验证安装。
