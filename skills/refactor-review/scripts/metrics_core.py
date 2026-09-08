#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量化检测的共享基础：配置、结果结构与文件发现。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Config:
    """全部阈值参数。所有指标均为“越低越好”，违规数必须为 0。"""

    max_file_lines: int = 600     # 文件总行数上限（含注释与空行）
    max_func_lines: int = 80      # 函数行数上限
    max_complexity: int = 15      # 函数圈复杂度上限
    max_nesting: int = 4          # 语句块嵌套深度上限
    max_params: int = 5           # 函数参数个数上限
    max_class_methods: int = 20   # 类直接方法数上限
    max_dup_rate: float = 5.0     # 代码重复率上限（百分比）
    min_clone_lines: int = 6      # 重复块判定的最小连续行数
    max_comment_run: int = 10     # 连续整行注释的行数上限
    domain_dirs: tuple[str, ...] = ()  # 核心业务目录（相对扫描根），启用 IO 检查
    top: int = 8                  # 摘要中每项最多展示的条目数


@dataclass
class Check:
    """单项指标结果。value 统一为“越低越好”的数值，便于前后对比。"""

    cid: str
    name: str
    principle: str        # 对应的设计原则
    value: float          # 指标数值（违规数或百分比）
    threshold: str        # 阈值的人类可读描述
    passed: bool
    display: str          # 摘要中的数值描述
    items: list[str] = field(default_factory=list)
    skipped: bool = False


@dataclass
class FileData:
    """单个文件的分析输入。tree 为 Python AST（无法解析时为 None）。"""

    path: Path
    rel: str
    lang: str
    lines: list[str]
    comments: list[tuple[int, str, bool]]  # (行号, 注释文本, 是否整行注释)
    tree: object | None


# 扫描时剪枝的目录：依赖、构建产物、缓存等
EXCLUDE_DIRS = {'.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target',
                '__pycache__', '.venv', 'venv', 'site-packages', 'coverage',
                '.idea', '.vscode', '.agents', '.pytest_cache', '.mypy_cache', '.ruff_cache'}

# 扩展名到注释风格的映射：python 走 tokenize，hash 用 #，dash 用 --，其余按 C 系处理
LANG_BY_EXT = {
    '.py': 'python', '.pyw': 'python',
    '.sh': 'hash', '.bash': 'hash', '.zsh': 'hash', '.ps1': 'hash', '.psm1': 'hash',
    '.rb': 'hash', '.yaml': 'hash', '.yml': 'hash', '.toml': 'hash', '.ini': 'hash',
    '.lua': 'dash', '.sql': 'dash',
    '.js': 'c', '.mjs': 'c', '.cjs': 'c', '.jsx': 'c', '.ts': 'c', '.tsx': 'c',
    '.java': 'c', '.cs': 'c', '.go': 'c', '.rs': 'c', '.c': 'c', '.h': 'c',
    '.cpp': 'c', '.hpp': 'c', '.swift': 'c', '.kt': 'c', '.php': 'c', '.scala': 'c',
}


def discover_files(root: Path, extra_excludes: tuple[str, ...]) -> list[Path]:
    """收集参与检测的源码文件，剪枝排除目录与压缩产物。"""
    excludes = EXCLUDE_DIRS | set(extra_excludes)
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in excludes]
        for name in filenames:
            if name.endswith('.min.js') or name == 'package-lock.json':
                continue
            path = Path(dirpath) / name
            if path.suffix.lower() in LANG_BY_EXT:
                files.append(path)
    files.sort()
    return files
