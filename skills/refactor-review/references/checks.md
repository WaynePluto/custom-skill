# 可操作的检查方法

按原则组织。命令使用 PowerShell 7 语法和 `rg`（ripgrep）。`<src>` 代表源码目录；先用 `rg --files <src>` 确认扫描范围合理（排除 vendor、生成代码）。阈值是启发式默认值，可按项目语言和惯例调整，但偏离时要说明理由。

## 通用统计（先跑，建立整体印象）

```powershell
# 按扩展名统计文件数，确认主要语言
rg --files <src> | Group-Object { [IO.Path]::GetExtension($_) } | Sort-Object Count -Descending | Select-Object Count, Name

# 找出最大的源码文件（前 20）
rg --files <src> -g '*.{py,ts,tsx,js,jsx,go,rs,java,cs,c,cpp,h}' |
  ForEach-Object { [PSCustomObject]@{ Lines = (Get-Content $_ | Measure-Object -Line).Lines; File = $_ } } |
  Sort-Object Lines -Descending | Select-Object -First 20

# 变更热点：最常被修改的文件往往是问题集中地（有 git 时）
git log --format='' --name-only -- <src> | Where-Object { $_ } | Group-Object | Sort-Object Count -Descending | Select-Object -First 15 Count, Name
```

## DRY：重复代码

**信号**：相同或近似的逻辑块出现在多处；复制后微调导致逻辑分叉。

```powershell
# 1. 找完全相同的行（长度 > 40 字符、非 import、出现 >= 3 次的行，常指向复制的逻辑）
rg -N --no-filename '.{40,}' <src> -g '*.py' |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -notmatch '^(import|from|#|//|\*)' } |
  Group-Object | Where-Object Count -ge 3 | Sort-Object Count -Descending | Select-Object -First 20 Count, Name

# 2. 找重名函数/方法（不同文件定义同名函数常是复制的开端）
#    Python 示例；其他语言换成 'function <name>'、'func <name>' 等模式
rg -n '^\s*def (\w+)' <src> -g '*.py' -or '$1' --no-filename | Group-Object | Where-Object Count -ge 2 | Sort-Object Count -Descending

# 3. 找相似字符串常量重复（魔法字符串/数字散落多处）
rg -oN '"[^"]{15,}"' <src> --no-filename | Group-Object | Where-Object Count -ge 3 | Sort-Object Count -Descending | Select-Object -First 15 Count, Name
```

对命中的候选，打开对应文件人工比对，确认是"应当抽取的同一逻辑"还是"巧合相似"（巧合相似不算违反 DRY）。有专用工具时优先使用：`jscpd`（多语言重复检测，`npx jscpd <src> --min-tokens 50`）、Python 的 `pylint --disable=all --enable=duplicate-code`。

**判断标准**：同一业务规则的实现出现 ≥ 2 处即报告；纯结构相似（如两个不同实体的 CRUD）不报告。

## KISS / YAGNI：过度设计

**信号**：只有一个实现的接口/抽象基类；只被一处调用的中转层；从未被外部使用的配置项和参数；深层继承。

```powershell
# 1. 找只有一个实现的接口/抽象类（对每个 interface/ABC，统计实现数）
rg -n 'interface \w+|abstract class \w+|\(ABC\)|Protocol\)' <src>
# 然后对每个名字: rg -c 'implements <Name>|extends <Name>|<Name>\)' <src>  —— 结果为 1 即候选

# 2. 找从未被调用的函数/导出（定义处之外零引用）
#    对可疑函数逐个验证：
rg -c '\b<funcName>\b' <src>   # 结果为 1（仅定义处）即死代码候选

# 3. 找深层嵌套（缩进 >= 5 层的代码行，圈复杂度信号）
rg -n '^( {20,}|\t{5,})\S' <src> -g '*.py' | Select-Object -First 20

# 4. 找参数过多的函数（> 5 个参数）
rg -n 'def \w+\([^)]{80,}' <src> -g '*.py'
```

有语言工具时优先：Python `radon cc <src> -n C`（圈复杂度 ≥ C 级）、JS/TS 用 ESLint `complexity` 规则。

**判断标准**：抽象层若删除后代码更短且无功能损失，报告为 YAGNI 违反；嵌套 ≥ 5 层或圈复杂度 ≥ 15 的函数报告为 KISS 违反。

## 单一职责（SRP）：巨型文件与巨型函数

```powershell
# 1. 巨型文件：见"通用统计"第 2 条。阈值：> 500 行为候选，> 1000 行为高严重度。

# 2. 巨型函数：统计函数长度（Python 示例，靠 def 之间的行数近似）
#    对候选大文件逐个查看函数边界：
rg -n '^\s*(def|class) ' <path/to/big/file.py>
#    相邻 def 间隔 > 80 行的函数为候选。

# 3. 职责混杂信号：一个文件同时 import 多个层面的依赖
#    例如同时出现 HTTP、DB、模板渲染：
rg -l 'import requests|import httpx' <src> -g '*.py' | ForEach-Object { if (rg -q 'import sqlalchemy|import sqlite3' $_) { $_ } }

# 4. 类的方法数（> 20 个方法的类为候选）
```

**判断标准**：不只看行数——看文件是否有多个"修改原因"（业务规则变了要改它、存储方式变了也要改它、展示格式变了还要改它 → 违反 SRP）。

## 高内聚低耦合：依赖问题

```powershell
# 1. 提取 import 关系（Python 示例）
rg -n '^\s*(from|import) ' <src> -g '*.py' --no-heading

# 2. 循环依赖检测：优先用工具
#    Python: pip install pydeps; pydeps <pkg> --show-cycles --no-output
#    JS/TS:  npx madge --circular <src>
#    Go:     go vet 自带；Rust: 编译器自带

# 3. 被最多模块依赖的文件（God module 候选）
rg -oN 'from ([\w.]+) import' <src> -g '*.py' -r '$1' --no-filename | Group-Object | Sort-Object Count -Descending | Select-Object -First 10 Count, Name

# 4. 跨层调用：低层模块反向 import 高层模块（依赖倒置违反）
#    按项目分层约定检查，例如 utils/ 不应 import services/：
rg -n 'from services|import services' <src>/utils
```

**判断标准**：任何循环依赖都报告为高严重度；被 > 一半模块依赖且自身超过 300 行的模块报告为 God module。

## 关注点分离：业务逻辑混入 IO/UI

```powershell
# 业务/领域代码中直接出现 IO 调用
rg -n 'print\(|input\(|open\(|requests\.|console\.log|fetch\(|alert\(' <src>/domain <src>/models <src>/core
# UI/handler 代码中出现复杂业务规则（长条件链）
rg -n 'if .+ and .+ and .+' <src>/views <src>/handlers <src>/routes
```

**判断标准**：核心业务函数无法在不 mock 网络/文件系统的情况下做单元测试，即报告。

## 一致性：同一件事的多种做法（AI 多轮编码典型病）

```powershell
# 1. 混用的等价库/API（示例：HTTP 客户端）
rg -l 'import requests' <src>; rg -l 'import httpx' <src>; rg -l 'import urllib' <src>

# 2. 混用的错误处理风格
rg -c 'raise \w+Error' <src> -g '*.py'; rg -c 'return None.*#.*error|return \{.*error' <src> -g '*.py'

# 3. 混用的命名风格（同一语言内 camelCase 与 snake_case 混用）
rg -n 'def [a-z]+[A-Z]' <src> -g '*.py'   # Python 中的 camelCase 函数

# 4. 配置/常量的多个来源
rg -ln 'os\.environ|getenv' <src> | Measure-Object   # 环境变量读取点是否分散
```

**判断标准**：同一职能存在 ≥ 2 种做法且无明确迁移计划时报告；报告时建议收敛到项目中占多数的那种。

## 里氏替换 / 接口隔离（次要，按需检查）

- LSP：查找子类中覆写后抛 `NotImplementedError` / 空实现的方法：
  `rg -n 'raise NotImplementedError|throw new Error\(.not implemented' <src>`
  出现在子类覆写中即候选（说明继承关系不成立，应改组合）。
- ISP：查找实现方被迫写大量空方法的宽接口；结合 SRP 检查中的"类方法数"结果判断。
