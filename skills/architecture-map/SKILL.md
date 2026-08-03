---
name: architecture-map
description: 分析项目源码，生成或更新模块架构文档（ARCHITECTURE.md），包含模块划分、职责说明、依赖关系 Mermaid 图，并在 AGENTS.md 中留一行引用。当用户要求生成架构图、梳理模块关系、为项目补充架构文档，或其他技能（如 refactor-review）需要项目架构信息时使用。不适用于生成 API 文档或用户手册。
compatibility: 通用；依赖 rg（ripgrep），可选 pydeps/madge 等依赖分析工具。
---

# 模块架构文档生成

从代码事实出发生成 `ARCHITECTURE.md`，让后续会话和其他 Agent 能快速理解项目结构。**文档必须基于实际扫描结果，不得凭目录名猜测模块职责。**

## 工作流

### 1. 确定范围与粒度

- 识别源码目录，排除 vendor、生成代码、构建产物。
- 粒度以"顶层模块/包"为主（通常 5–15 个节点）。小项目（< 20 文件）可到文件级；大项目不要下钻到类级，图超过 ~20 个节点就该合并。

### 2. 收集事实

```powershell
# 目录结构概览
Get-ChildItem <src> -Directory -Recurse -Depth 2 | Select-Object FullName

# import/依赖关系（按语言调整模式）
rg -n '^\s*(from|import) ' <src> -g '*.py' --no-heading
rg -n "^import .* from '" <src> -g '*.{ts,tsx}' --no-heading
```

有条件时用专用工具获得更准的模块级依赖：Python `pydeps <pkg> --max-bacon 2 --no-output --show-deps`；JS/TS `npx madge --json <src>`。

每个模块的职责说明来自：入口文件、模块内 docstring/README、主要导出符号（`rg -n '^(def|class|export) ' <module>` 的前若干条）。

### 3. 写入 ARCHITECTURE.md

写到项目根目录 `ARCHITECTURE.md`（若项目已有 `docs/architecture.md` 则更新原位置）。结构：

```markdown
# 架构概览

> 由 architecture-map 技能生成于 <日期>；模块结构变化后需重新生成。

## 模块一览
| 模块 | 路径 | 职责 | 主要依赖 |
|------|------|------|----------|

## 依赖关系图
```mermaid
graph TD
  ...（模块间依赖，箭头指向被依赖方；循环依赖用红色标注并加文字说明）
```

## 关键约定
（分层规则、入口点、数据流方向等从代码中确认到的事实）
```

已存在 `ARCHITECTURE.md` 时做增量更新：保留人工添加的章节，只重写生成的部分。

### 4. 在 AGENTS.md 中留引用

若项目根目录有 `AGENTS.md` 且尚无引用，追加一行（不要把架构内容本体写进去）：

```markdown
项目模块架构见 `ARCHITECTURE.md`；修改模块结构后请更新该文件。
```

若无 `AGENTS.md`，询问用户是否创建（只含上面这一行）。

## 注意事项

- 图中每条边都必须有 import 证据支撑；不确定的关系宁可省略。
- 发现循环依赖时在文档中明确标注，但不在本技能中给重构方案（那是 refactor-review 的职责）。
- 输出保持精简：ARCHITECTURE.md 目标 100–200 行，超出说明粒度太细。
