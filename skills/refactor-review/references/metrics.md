# 量化指标定义与重构手法

本技能只依据 `scripts/code_metrics.py` 的量化数值决定是否重构与是否完成重构。本文档定义每个指标的口径、阈值理由、失败后的重构手法，以及少量不作为门槛的非量化补充信号。

## 快速命令

```powershell
# 基线检测（在技能目录下执行，<target> 为要检测的项目目录）
python scripts/code_metrics.py <target> --json <target>/baseline.json

# 复测并对比基线
python scripts/code_metrics.py <target> --compare <target>/baseline.json
```

退出码：`0` = 全部达标（无需重构），`1` = 存在不达标（需要重构），`2` = 路径/文件错误。

## 指标总表

| 指标 ID | 名称 | 对应原则 | 默认阈值 | 调整参数 |
|---|---|---|---|---|
| file-length | 文件总行数 | SRP | ≤ 600 行（含注释与空行） | `--max-file-lines` |
| function-length | 函数行数 | SRP/KISS | ≤ 80 行 | `--max-func-lines` |
| function-complexity | 圈复杂度 | KISS | ≤ 15 | `--max-complexity` |
| nesting-depth | 嵌套深度 | KISS | ≤ 4 层 | `--max-nesting` |
| param-count | 参数个数 | KISS | ≤ 5 个（self/cls 不计） | `--max-params` |
| class-methods | 类方法数 | SRP/ISP | ≤ 20 个 | `--max-class-methods` |
| duplication-rate | 代码重复率 | DRY | ≤ 5% | `--max-dup-rate`、`--min-clone-lines` |
| comment-language | 非中文注释 | 注释规范 | 0 条 | 固定 |
| comment-run | 超长注释块 | 注释规范 | 连续整行注释 ≤ 10 行 | `--max-comment-run` |
| import-cycles | 循环依赖 | 高内聚低耦合 | 0 个环 | 固定 |
| unused-imports | 未使用 import | YAGNI | 0 个 | 固定 |
| naming-style | 命名风格 | 一致性 | 函数 snake_case、类 PascalCase，0 违规 | 固定 |
| domain-io | 核心目录 IO 调用 | 关注点分离 | 0 处（需 `--domain-dirs` 启用） | `--domain-dirs` |

除重复率（百分比）外，所有指标的数值都是"违规数量"，必须为 0。所有指标统一为"越低越好"，便于 `--compare` 前后对比。

## 各指标口径与重构手法

### file-length：文件总行数（SRP）

- 口径：物理行数，含注释、空行、docstring 所在行。超过 600 行说明该文件有多个"修改原因"，必须按职责拆分。
- 重构手法：识别文件的段落边界（数据、IO、业务、入口），按修改原因拆成多个模块；大型项目可先用 `architecture-map` 技能生成架构文档辅助定位。**按职责拆，不是机械对半砍**。
- 用户硬性要求：超过 600 行即触发重构，无商量余地；若确有例外（生成代码、数据文件），应加入 `--exclude` 并说明理由。

### function-length：函数行数（SRP/KISS）

- 口径：从 `def` 行到函数体末行的总行数，嵌套函数单独计数。
- 重构手法：提取子函数（每个子函数一句话说清做什么）；参数与局部变量打包成对象。

### function-complexity：圈复杂度（KISS）

- 口径：分支点数 + 1，统计 if/elif/for/while/except/assert/三元/布尔运算/推导式条件/match 分支；不进入嵌套函数。
- 重构手法：卫语句提前返回；长 if/elif 链改查表（dict 映射）或拆函数；布尔条件提取成具名变量/函数。

### nesting-depth：嵌套深度（KISS）

- 口径：控制流块（if/for/while/try/with/match）的最大嵌套层数；elif 延续与 else/except 分支不额外计层。
- 重构手法：提取函数；用 `continue`/提前返回反转移出深层嵌套；集合推导替代多层循环。

### param-count：参数个数（KISS）

- 口径：位置参数 + 仅关键字参数 + `*args`/`**kwargs` 各计 1；方法首参 self/cls 不计。
- 重构手法：相关性强的参数合并为 dataclass/参数对象；用关键字参数与默认值替代布尔开关参数。

### class-methods：类方法数（SRP/ISP）

- 口径：类体中直接定义的方法数（含 property，不含继承）。
- 重构手法：按职责拆出协作类；把一组只操作部分状态的方法移到新类。

### duplication-rate：代码重复率（DRY）

- 口径：把所有代码行归一化（压缩空白）后按滑窗（默认连续 6 行）匹配，重复行数占全部有效行数的百分比。行级近似，能抓"复制粘贴"，抓不到"复制后批量重命名"的克隆。
- 重构手法：完全相同的逻辑提取为公共函数/模块，一处维护；近似逻辑先参数化合并，确认不是"巧合相似"再合并。
- 需要更精确的检测时可用 `npx jscpd <src> --min-tokens 50` 复核，但门槛以本脚本为准。

### comment-language：非中文注释（注释规范）

- 口径：每条注释必须含中文字符。豁免：空注释、纯符号分隔线（如 `# ----`）、shebang、编码声明、工具指令（`type: ignore`、`noqa`、`pragma`、`region` 等）、以 `@` 开头的文档标签行。Python 用 tokenize 提取（字符串内的 `#` 不算注释），C 系语言跳过字符串字面量。
- 重构手法：把英文注释翻译成中文；`TODO` 类标记改为中文描述。
- 约定：面向模型和维护者的说明性文字一律中文；API 名、错误信息等标识符保持原文。

### comment-run：超长注释块（注释规范）

- 口径：连续整行注释超过 10 行即违规；行尾尾注不参与计数。
- 重构手法：成段的描述性注释改写为 docstring（Python）或移入 `references/`、`docs/` 文档，代码旁只保留必要的短注释。长注释往往说明函数本身职责不清，优先考虑拆函数让代码自解释。

### import-cycles：循环依赖（高内聚低耦合）

- 口径：本地模块 import 图中规模大于 1 的强连通分量（Tarjan 算法）；绝对/相对导入都参与建图，外部库不参与。
- 重构手法：把共同依赖下沉为独立模块；对依赖倒置，让高层定义接口、低层实现；拆出引起环的那部分职责。

### unused-imports：未使用 import（YAGNI）

- 口径：绑定的名字在模块内无 `Name` 引用且不在 `__all__` 中；`__init__.py` 的再导出豁免。TYPE_CHECKING 分支内仅出现在字符串注解里的名字可能误报，需人工复核。
- 重构手法：直接删除。

### naming-style：命名风格（一致性）

- 口径：函数/方法必须 snake_case（含 `_` 前缀与 dunder），类必须 PascalCase。仅 Python。
- 重构手法：重命名为项目主流风格；若项目整体采用其他统一风格，以一致性优先，用工具配置适配而不是逐个报违规。

### domain-io：核心目录 IO 调用（关注点分离）

- 口径：`--domain-dirs` 指定的目录（相对扫描根）中出现 `print/input/open`、`requests./httpx./urllib.`、`console.log/fetch` 计为违规；未配置时跳过。
- 重构手法：业务逻辑通过依赖注入接收 IO 边界（仓储、客户端接口），使核心逻辑可以不 mock 网络/文件就做单元测试。

## 算法近似性与已知局限

- 重复检测为行级滑窗，检测不到重命名后的克隆；重命名式克隆用 jscpd 复核。
- 圈复杂度/嵌套/参数/类方法/import 图仅支持 Python；其他语言只有行数、重复率、注释三类门槛，复杂度可用 `radon`、ESLint `complexity` 等语言工具补充但不计入门槛。
- 非 UTF-8 编码的文件可能被误报为非中文注释。
- 动态导入（`importlib`）、运行时拼出的模块名不参与 import 图。
- 语法错误的 Python 文件跳过 AST 检查并在报告中给出警告。

## 阈值调整原则

- 偏离默认阈值必须说明理由，并在交付报告中记录所用的全部参数（`--json` 报告会保存当次配置下的数值）。
- 同一项目内阈值保持一致，否则 `--compare` 的前后对比失去意义。

## 防作弊条款

达标必须通过真实改进代码结构实现，以下行为视为作弊，禁止采用：

- 删除有价值的注释或把注释改空来通过注释检查（应翻译成中文或精简）。
- 拆空行、无意义换行、缩短标识符来凑行数。
- 把多行逻辑塞进一行、lambda 或推导式来降低复杂度/行数。
- 把大文件机械对半拆成两个同样混乱的文件（拆分必须按职责）。
- 删除"未使用"代码前不确认无动态引用（`getattr`、反射、插件加载）。

## 非量化补充信号（可选，不作为重构门槛）

指标全部达标后，如用户明确要求更深入审查，可人工检查以下信号。它们难以可靠量化，不参与达标判定：

```powershell
# 只有一个实现的接口/抽象类（YAGNI）：对每个 interface/ABC 统计实现数
rg -n 'interface \w+|abstract class \w+|\(ABC\)|Protocol\)' <src>

# 子类覆写后抛 NotImplementedError（LSP 破坏）
rg -n 'raise NotImplementedError' <src>

# 混用的等价库（一致性）：如 requests 与 httpx 并存
rg -l 'import requests' <src>; rg -l 'import httpx' <src>

# 定义处之外零引用的函数（死代码候选，需排除动态调用）
rg -c '\b<funcName>\b' <src>
```
