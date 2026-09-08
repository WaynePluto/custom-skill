#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""代码量化指标检测脚本（refactor-review 技能配套）。

用法:
    python code_metrics.py <路径> [选项]

对扫描到的源码计算量化指标：文件行数、函数行数、圈复杂度、嵌套深度、
参数个数、类方法数、代码重复率、注释规范（中文/超长注释块）、循环依赖、
未使用 import、命名风格、核心目录 IO 调用。
全部达标退出码 0（无需重构），存在不达标退出码 1（需要重构）。
仅使用标准库，源码按 UTF-8 读取；指标定义与阈值理由见 references/metrics.md。
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from dataclasses import asdict
from pathlib import Path

import py_metrics
import text_metrics
from metrics_core import LANG_BY_EXT, Check, Config, FileData, discover_files


def load_files(root: Path, files: list[Path]) -> tuple[list[FileData], list[str]]:
    """读取文件内容、注释与 Python AST。"""
    data, errors = [], []
    for f in files:
        try:
            text = f.read_text(encoding='utf-8', errors='replace')
        except OSError as exc:
            errors.append(f'{f}: 读取失败 {exc}')
            continue
        if '\x00' in text:
            continue  # 二进制文件跳过
        lines = text.splitlines()
        lang = LANG_BY_EXT[f.suffix.lower()]
        comments = text_metrics.extract_comments(lines, lang)
        tree = None
        if lang == 'python':
            try:
                tree = ast.parse(text)
            except SyntaxError as exc:
                errors.append(f'{f.relative_to(root)}:{exc.lineno}: 语法错误，跳过 AST 检查')
        data.append(FileData(f, f.relative_to(root).as_posix(), lang, lines, comments, tree))
    return data, errors


def run_checks(root: Path, data: list[FileData], cfg: Config) -> list[Check]:
    """执行全部检查项。"""
    return ([text_metrics.check_file_length(data, cfg),
             text_metrics.check_duplication(data, cfg),
             text_metrics.check_comment_language(data),
             text_metrics.check_comment_run(data, cfg)]
            + py_metrics.check_python_functions(data, cfg)
            + [py_metrics.check_class_methods(data, cfg),
               py_metrics.check_unused_imports(data),
               py_metrics.check_naming(data),
               py_metrics.check_cycles(root, data),
               text_metrics.check_domain_io(root, data, cfg)])


# ---------- 报告与输出 ----------


def compute_totals(data: list[FileData]) -> dict:
    """扫描范围统计。"""
    ext_counts: dict[str, int] = {}
    for d in data:
        ext_counts[d.path.suffix] = ext_counts.get(d.path.suffix, 0) + 1
    by_ext = dict(sorted(ext_counts.items(), key=lambda kv: -kv[1]))
    return {'files': len(data), 'lines': sum(len(d.lines) for d in data), 'by_ext': by_ext}


def print_summary(checks: list[Check], totals: dict, errors: list[str], cfg: Config) -> None:
    """打印人类可读摘要，每项条目按 --top 截断。"""
    ext = ' '.join(f'{k}:{v}' for k, v in totals['by_ext'].items())
    print('== 代码量化指标报告 ==')
    print(f"范围: {totals['files']} 个文件 / {totals['lines']} 行（{ext}）")
    for c in checks:
        if c.skipped:
            print(f'[SKIP] {c.name}: {c.display}')
            continue
        tag = 'PASS' if c.passed else 'FAIL'
        print(f'[{tag}] {c.name}（{c.principle}）: {c.display}，阈值 {c.threshold}')
        if not c.passed:
            for item in c.items[:cfg.top]:
                print(f'    - {item}')
            if len(c.items) > cfg.top:
                print(f'    …另有 {len(c.items) - cfg.top} 处，完整清单见 --json 输出')
    for e in errors:
        print(f'[警告] {e}')


def print_compare(baseline_path: str, checks: list[Check]) -> None:
    """与基线 JSON 报告对比数值变化（所有指标均为越低越好）。"""
    try:
        old = json.loads(Path(baseline_path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        print(f'无法读取基线报告 {baseline_path}: {exc}')
        return
    old_map = {c['id']: c for c in old.get('checks', [])}
    print(f'== 与基线对比（{baseline_path}）==')
    for c in checks:
        prev = old_map.get(c.cid)
        if prev is None:
            continue
        delta = c.value - prev['value']
        trend = '改善' if delta < 0 else ('恶化' if delta > 0 else '持平')
        print(f'  {c.name}: {prev["value"]:g} -> {c.value:g}（{delta:+g}）{trend}')


def report_json(root: Path, checks: list[Check], totals: dict, errors: list[str]) -> dict:
    """完整 JSON 报告结构，可作为后续 --compare 的基线。"""
    return {
        'root': str(root),
        'totals': totals,
        'warnings': errors,
        'passed': all(c.passed for c in checks if not c.skipped),
        'checks': [{'id': c.cid, 'name': c.name, 'principle': c.principle,
                    'value': c.value, 'threshold': c.threshold, 'passed': c.passed,
                    'skipped': c.skipped, 'items': c.items[:500]} for c in checks],
    }


# ---------- 命令行入口 ----------


def parse_args(argv: list[str]) -> tuple[argparse.Namespace, Config]:
    """解析命令行参数并构造配置。"""
    parser = argparse.ArgumentParser(
        prog='code_metrics.py',
        description='代码量化指标检测：全部达标退出码 0（无需重构），不达标退出码 1。')
    parser.add_argument('path', nargs='?', default='.', help='要扫描的目录，默认当前目录')
    parser.add_argument('--exclude', action='append', default=[], metavar='DIR',
                        help='额外排除的目录名，可多次指定')
    parser.add_argument('--domain-dirs', default='', metavar='A,B',
                        help='核心业务目录（逗号分隔，相对扫描根），启用关注点分离检查')
    parser.add_argument('--top', type=int, default=8, metavar='N', help='摘要中每项展示条目数')
    parser.add_argument('--json', metavar='PATH', help='写入完整 JSON 报告（可作 --compare 基线）')
    parser.add_argument('--compare', metavar='PATH', help='与既有 JSON 报告对比数值变化')
    cfg = Config()
    for name, default in asdict(cfg).items():
        if name in ('domain_dirs', 'top'):
            continue
        parser.add_argument(f'--{name.replace("_", "-")}', type=type(default),
                            default=default, metavar='N', help=f'默认 {default}')
    args = parser.parse_args(argv)
    for name in asdict(cfg):
        if hasattr(args, name):
            setattr(cfg, name, getattr(args, name))
    cfg.domain_dirs = tuple(x.strip().strip('/') for x in args.domain_dirs.split(',') if x.strip())
    cfg.top = args.top
    return args, cfg


def main(argv: list[str] | None = None) -> int:
    args, cfg = parse_args(argv)
    root = Path(args.path).resolve()
    if not root.is_dir():
        print(f'路径不存在或不是目录: {root}')
        return 2
    data, errors = load_files(root, discover_files(root, tuple(args.exclude)))
    if not data:
        print('未发现可检测的源码文件')
        return 2
    checks = run_checks(root, data, cfg)
    print_summary(checks, compute_totals(data), errors, cfg)
    if args.compare:
        print_compare(args.compare, checks)
    if args.json:
        report = json.dumps(report_json(root, checks, compute_totals(data), errors),
                            ensure_ascii=False, indent=2)
        Path(args.json).write_text(report, encoding='utf-8')
        print(f'JSON 报告已写入 {args.json}')
    failed = [c.name for c in checks if not c.skipped and not c.passed]
    if failed:
        print(f'结论: {len(failed)} 项不达标 → 需要重构（{"、".join(failed)}）')
        return 1
    print('结论: 全部指标达标，无需重构')
    return 0


if __name__ == '__main__':
    sys.exit(main())
