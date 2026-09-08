#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Python AST 指标：函数/类规模、复杂度、未使用 import、命名与循环依赖。"""
from __future__ import annotations

import ast
import re
from pathlib import Path

from metrics_core import Check, Config, FileData

FUNC_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef)
NEST_TYPES = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.With,
              ast.AsyncWith) + ((ast.Match,) if hasattr(ast, 'Match') else ())
MATCH_CASE = getattr(ast, 'match_case', ())


def _own_nodes(root: ast.AST):
    """遍历 root 的后代节点，不进入嵌套函数/lambda。"""
    for child in ast.iter_child_nodes(root):
        if isinstance(child, FUNC_TYPES + (ast.Lambda,)):
            continue
        yield child
        yield from _own_nodes(child)


def _complexity(fn: ast.AST) -> int:
    """圈复杂度 = 分支点数 + 1（if/循环/异常/布尔运算/推导式条件/match 分支）。"""
    score = 1
    for node in _own_nodes(fn):
        if isinstance(node, (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While,
                             ast.ExceptHandler, ast.Assert)):
            score += 1
        elif isinstance(node, ast.BoolOp):
            score += len(node.values) - 1
        elif isinstance(node, ast.comprehension):
            score += 1 + len(node.ifs)
        elif MATCH_CASE and isinstance(node, MATCH_CASE):
            score += 1
    return score


def _is_elif_arm(parent: ast.AST, child: ast.AST) -> bool:
    """child 是否为 parent 的 elif 延续分支（elif 不应额外计一层嵌套）。"""
    return (isinstance(parent, ast.If) and isinstance(child, ast.If)
            and len(parent.orelse) == 1 and parent.orelse[0] is child)


def _nesting(root: ast.AST) -> int:
    """最大嵌套深度；elif 延续与 else/except 分支不额外计层。"""
    best = 0
    for child in ast.iter_child_nodes(root):
        if isinstance(child, FUNC_TYPES + (ast.Lambda,)):
            continue
        sub = _nesting(child)
        if isinstance(child, NEST_TYPES) and not _is_elif_arm(root, child):
            sub += 1
        best = max(best, sub)
    return best


def _param_count(fn: ast.AST) -> int:
    """统计参数个数；方法的 self/cls 首参不计。"""
    args = fn.args
    names = [p.arg for p in args.posonlyargs + args.args + args.kwonlyargs]
    names += [a.arg for a in (args.vararg, args.kwarg) if a]
    if names and names[0] in ('self', 'cls'):
        names = names[1:]
    return len(names)


def _function_stats(tree: ast.AST):
    """产出 (名称, 行号, 行数, 圈复杂度, 嵌套深度, 参数个数)。"""
    for node in ast.walk(tree):
        if isinstance(node, FUNC_TYPES):
            yield (node.name, node.lineno, node.end_lineno - node.lineno + 1,
                   _complexity(node), _nesting(node), _param_count(node))


def check_python_functions(data: list[FileData], cfg: Config) -> list[Check]:
    """函数级检查（仅 Python）：行数、圈复杂度、嵌套、参数个数。"""
    long_f, complex_f, deep_f, many_p = [], [], [], []
    for d in data:
        if d.tree is None:
            continue
        for name, lineno, flen, cc, nest, pc in _function_stats(d.tree):
            loc = f'{d.rel}:{lineno} {name}'
            if flen > cfg.max_func_lines:
                long_f.append(f'{loc} {flen} 行')
            if cc > cfg.max_complexity:
                complex_f.append(f'{loc} 圈复杂度 {cc}')
            if nest > cfg.max_nesting:
                deep_f.append(f'{loc} 嵌套 {nest} 层')
            if pc > cfg.max_params:
                many_p.append(f'{loc} {pc} 个参数')
    return [
        Check('function-length', '函数行数', 'SRP/KISS', len(long_f),
              f'≤ {cfg.max_func_lines} 行', not long_f, f'{len(long_f)} 个函数超限', long_f),
        Check('function-complexity', '圈复杂度', 'KISS', len(complex_f),
              f'≤ {cfg.max_complexity}', not complex_f, f'{len(complex_f)} 个函数超限', complex_f),
        Check('nesting-depth', '嵌套深度', 'KISS', len(deep_f),
              f'≤ {cfg.max_nesting} 层', not deep_f, f'{len(deep_f)} 个函数超限', deep_f),
        Check('param-count', '参数个数', 'KISS', len(many_p),
              f'≤ {cfg.max_params} 个', not many_p, f'{len(many_p)} 个函数超限', many_p),
    ]


def check_class_methods(data: list[FileData], cfg: Config) -> Check:
    """类的直接方法数过多说明职责混杂（仅 Python）。"""
    bad = []
    for d in data:
        if d.tree is None:
            continue
        for node in ast.walk(d.tree):
            if isinstance(node, ast.ClassDef):
                count = sum(1 for c in node.body if isinstance(c, FUNC_TYPES))
                if count > cfg.max_class_methods:
                    bad.append(f'{d.rel}:{node.lineno} {node.name} {count} 个方法')
    return Check('class-methods', '类方法数', 'SRP/ISP', len(bad),
                 f'≤ {cfg.max_class_methods} 个', not bad, f'{len(bad)} 个类超限', bad)


def _collect_imports(tree: ast.AST) -> list[tuple[int, str]]:
    """收集 import 绑定 (行号, 名字)，跳过 __future__ 与通配导入。"""
    imported = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported += [(node.lineno, a.asname or a.name.split('.')[0]) for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module != '__future__':
            imported += [(node.lineno, a.asname or a.name) for a in node.names if a.name != '*']
    return imported


def _collect_used_names(tree: ast.AST) -> set:
    """收集已使用的名字：Name 引用与 __all__ 导出。"""
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple))):
            continue
        if any(isinstance(t, ast.Name) and t.id == '__all__' for t in node.targets):
            used |= {e.value for e in node.value.elts
                     if isinstance(e, ast.Constant) and isinstance(e.value, str)}
    return used


def check_unused_imports(data: list[FileData]) -> Check:
    """未被使用的 import 属于死代码（仅 Python，__init__.py 再导出豁免）。"""
    bad = []
    for d in data:
        if d.tree is None or d.path.name == '__init__.py':
            continue
        used = _collect_used_names(d.tree)
        bad += [f'{d.rel}:{ln}: {name}' for ln, name in _collect_imports(d.tree)
                if name not in used]
    return Check('unused-imports', '未使用 import', 'YAGNI', len(bad),
                 '0 个', not bad, f'{len(bad)} 个未使用', bad)


SNAKE_RE = re.compile(r'^_?[a-z][a-z0-9_]*$|^__\w+__$')
PASCAL_RE = re.compile(r'^_?[A-Z][A-Za-z0-9]*$')


def check_naming(data: list[FileData]) -> Check:
    """命名一致性：函数/方法 snake_case，类 PascalCase（仅 Python）。"""
    bad = []
    for d in data:
        if d.tree is None:
            continue
        for node in ast.walk(d.tree):
            if isinstance(node, FUNC_TYPES) and not SNAKE_RE.match(node.name):
                bad.append(f'{d.rel}:{node.lineno} 函数 {node.name}')
            elif isinstance(node, ast.ClassDef) and not PASCAL_RE.match(node.name):
                bad.append(f'{d.rel}:{node.lineno} 类 {node.name}')
    return Check('naming-style', '命名风格', '一致性', len(bad),
                 'snake_case / PascalCase', not bad, f'{len(bad)} 处违规', bad)


# ---------- 循环依赖（本地 import 图） ----------


def module_dotted_name(path: Path, root: Path) -> str:
    """计算模块点分名；包根为向上第一个不含 __init__.py 的目录。"""
    if path.name == '__init__.py':
        parts, cur = [], path.parent
    else:
        parts, cur = [path.stem], path.parent
    while cur != root and (cur / '__init__.py').is_file():
        parts.insert(0, cur.name)
        cur = cur.parent
    return '.'.join(parts)


def _match_abs(dotted: str, name_to_file: dict, root: Path, self_path: Path) -> set:
    """绝对导入匹配本地模块：先按模块名，再退化为扫描根下的路径。"""
    parts = dotted.split('.')
    for k in range(len(parts), 0, -1):
        key = '.'.join(parts[:k])
        hit = name_to_file.get(key)
        if hit is None:
            cand = root.joinpath(*key.split('.'))
            for target in (cand.with_suffix('.py'), cand / '__init__.py'):
                if target.is_file():
                    hit = target
                    break
        if hit is not None:
            return set() if hit == self_path else {hit}
    return set()


def _relative_dep(base: Path, parts: list[str], name: str, file_set: set) -> Path | None:
    """相对导入还原为本地文件，找不到返回 None。"""
    for target in (base.joinpath(*parts, name + '.py'),
                   base.joinpath(*parts, name, '__init__.py'),
                   base.joinpath(*parts, '__init__.py')):
        if target in file_set:
            return target
    return None


def _local_deps(data: FileData, root: Path, name_to_file: dict, file_set: set) -> set:
    """解析文件中指向本地模块的 import 边。"""
    deps = set()
    for node in ast.walk(data.tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                deps |= _match_abs(alias.name, name_to_file, root, data.path)
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0:
                mod = node.module or ''
                for alias in node.names:
                    cand = f'{mod}.{alias.name}' if mod else alias.name
                    deps |= _match_abs(cand, name_to_file, root, data.path)
                continue
            base = data.path.parent
            for _ in range(node.level - 1):
                base = base.parent
            parts = node.module.split('.') if node.module else []
            for alias in node.names:
                target = _relative_dep(base, parts, alias.name, file_set)
                if target and target != data.path:
                    deps.add(target)
    return deps


def strongly_connected_components(graph: dict) -> list[list]:
    """Tarjan 返回规模大于 1 的强连通分量（迭代实现，防深递归）。"""
    index, low, on_stack, stack = {}, {}, set(), []
    counter, sccs = [0], []

    def push(node, work):
        # 首次访问：编号并入栈
        index[node] = low[node] = counter[0]
        counter[0] += 1
        stack.append(node)
        on_stack.add(node)
        work.append([node, iter(graph.get(node, ()))])

    def drain(node, it, work):
        """推进节点迭代器；压入新节点时返回 True。"""
        for nxt in it:
            if nxt not in index:
                push(nxt, work)
                return True
            if nxt in on_stack:
                low[node] = min(low[node], index[nxt])
        return False

    def pop_component(node):
        """从栈中弹出 node 所属的强连通分量。"""
        comp = []
        while True:
            w = stack.pop()
            on_stack.discard(w)
            comp.append(w)
            if w == node:
                break
        return comp

    def collect_if_root(node):
        """node 为分量根时收集该分量（规模大于 1 才是环）。"""
        if low[node] == index[node]:
            comp = pop_component(node)
            if len(comp) > 1:
                sccs.append(comp)

    for start in graph:
        if start in index:
            continue
        work = []
        push(start, work)
        while work:
            node, it = work[-1]
            if drain(node, it, work):
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])
            collect_if_root(node)
    return sccs


def check_cycles(root: Path, data: list[FileData]) -> Check:
    """循环依赖：本地 import 图中的强连通分量（仅 Python）。"""
    py = [d for d in data if d.tree is not None]
    name_to_file = {}
    for d in py:
        name_to_file.setdefault(module_dotted_name(d.path, root), d.path)
    file_set = {d.path for d in py}
    graph = {d.path: _local_deps(d, root, name_to_file, file_set) for d in py}
    sccs = strongly_connected_components(graph)
    items = [' ↔ '.join(p.relative_to(root).as_posix() for p in sorted(scc, key=str))
             for scc in sccs]
    return Check('import-cycles', '循环依赖', '高内聚低耦合', len(sccs),
                 '0 个环', not sccs, f'{len(sccs)} 个循环依赖环', items)
