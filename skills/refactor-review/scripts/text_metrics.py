#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文本级指标：文件行数、代码重复率、注释规范、核心目录 IO 调用。"""
from __future__ import annotations

import re
from pathlib import Path

from metrics_core import Check, Config, FileData

# 中日韩表意字符区间（含扩展 A 区与兼容表意区）
CJK_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')

# 可豁免中文检查的注释前缀：工具指令、文档标签、折叠标记等
IGNORE_PREFIXES = ('type:', 'noqa', 'pragma', 'pylint', 'ruff', 'isort', 'mypy',
                   'eslint', 'tslint', 'prettier', 'fmt:', 'nolint', 'spelling',
                   'cspell', 'region', 'endregion', '@')


# ---------- 注释提取 ----------


def _starts_like_comment(line: str) -> bool:
    """判断该物理行是否以注释标记开头（用于识别整行注释）。"""
    return line.lstrip().startswith(('#', '//', '/*', '*', '--'))


def _py_comments(lines: list[str]) -> list[tuple[int, str, bool]]:
    """用 tokenize 精确提取 Python 注释，可正确跳过字符串内的 #。"""
    from io import StringIO
    import tokenize
    out = []
    try:
        for tok in tokenize.generate_tokens(StringIO('\n'.join(lines)).readline):
            if tok.type == tokenize.COMMENT:
                full = _starts_like_comment(lines[tok.start[0] - 1])
                out.append((tok.start[0], tok.string.lstrip('#'), full))
    except (tokenize.TokenError, IndentationError):
        pass  # 无法解析的文件跳过注释检查
    return out


def _marker_comments(lines: list[str], marker: str) -> list[tuple[int, str, bool]]:
    """提取 # 或 -- 注释：仅识别行首或空白之后的标记，降低字符串误报。"""
    pat = re.compile(r'(?<!\S)' + re.escape(marker))
    out = []
    for lineno, line in enumerate(lines, 1):
        m = pat.search(line)
        if m:
            out.append((lineno, line[m.end():], _starts_like_comment(line)))
    return out


def _skip_string(line: str, j: int, quote: str) -> tuple[int, bool]:
    """跳过从 j 开始的字符串内容，返回 (新位置, 是否已闭合)。"""
    k = j + 1
    while k < len(line):
        if line[k] == '\\':
            k += 2  # 跳过转义字符
            continue
        if line[k] == quote:
            return k + 1, True
        k += 1
    return k, False


def _c_comments(lines: list[str]) -> list[tuple[int, str, bool]]:
    """提取 C 系语言注释（// 与块注释），跳过字符串字面量。"""
    out, state, buf = [], 'code', []
    for lineno, line in enumerate(lines, 1):
        j, n = 0, len(line)
        while j < n:
            ch = line[j]
            if state in ('"', "'"):  # 字符串内部：跳到闭合引号
                j, closed = _skip_string(line, j, state)
                if closed:
                    state = 'code'
            elif state == 'block':
                end = line.find('*/', j)
                if end < 0:
                    buf.append(line[j:])
                    j = n
                else:
                    buf.append(line[j:end])
                    out.append((lineno, ''.join(buf), _starts_like_comment(line)))
                    j, buf, state = end + 2, [], 'code'
            elif line.startswith('//', j):
                buf = list(line[j + 2:])
                state, j = 'line', n
            elif line.startswith('/*', j):
                j, state = j + 2, 'block'
            elif ch in '"\'':
                state = ch
                j += 1
            else:
                j += 1
        if state == 'line':
            out.append((lineno, ''.join(buf), _starts_like_comment(line)))
            state, buf = 'code', []
        elif state == 'block':
            out.append((lineno, ''.join(buf), _starts_like_comment(line)))
            buf = []
    return out


def extract_comments(lines: list[str], lang: str) -> list[tuple[int, str, bool]]:
    """按语言提取注释，返回 (行号, 注释文本, 是否整行注释) 列表。"""
    if lang == 'python':
        return _py_comments(lines)
    if lang == 'hash':
        return _marker_comments(lines, '#')
    if lang == 'dash':
        return _marker_comments(lines, '--')
    return _c_comments(lines)


def is_neutral_comment(text: str, lineno: int, raw_line: str) -> bool:
    """判断注释是否豁免中文检查（空注释、分隔线、工具指令、shebang 等）。"""
    t = text.strip()
    if not t:
        return True
    if lineno == 1 and raw_line.lstrip().startswith('#!'):
        return True
    low = t.lower()
    if low.startswith(IGNORE_PREFIXES) or 'coding:' in low or 'coding=' in low:
        return True
    return not re.search(r'[a-zA-Z0-9]', t)  # 纯符号（如 ---- 分隔线）


# ---------- 检查项 ----------


def check_file_length(data: list[FileData], cfg: Config) -> Check:
    """文件总行数（含注释与空行）不得超过阈值。"""
    over = [(len(d.lines), d.rel) for d in data if len(d.lines) > cfg.max_file_lines]
    over.sort(reverse=True)
    items = [f'{rel}: {n} 行' for n, rel in over]
    return Check('file-length', '文件行数', 'SRP', len(over),
                 f'每文件 ≤ {cfg.max_file_lines} 行', not over,
                 f'{len(over)} 个文件超限', items)


def _normalize(lines: list[str]) -> list[tuple[int, str]]:
    """归一化代码行（压缩空白）并保留原始行号，跳过空行。"""
    tokens = []
    for lineno, line in enumerate(lines, 1):
        text = re.sub(r'\s+', ' ', line.strip())
        if text:
            tokens.append((lineno, text))
    return tokens


def check_duplication(data: list[FileData], cfg: Config) -> Check:
    """滑窗克隆检测：重复率 = 重复行数 / 全部有效行数。"""
    tokens = {d.rel: _normalize(d.lines) for d in data}
    total = sum(len(t) for t in tokens.values())
    if total == 0:
        return Check('duplication-rate', '代码重复率', 'DRY', 0.0,
                     f'≤ {cfg.max_dup_rate}%', True, '0%', skipped=True)
    seen, dup, blocks = {}, {}, []
    w = max(2, cfg.min_clone_lines)
    for rel, tk in tokens.items():
        i = 0
        while i + w <= len(tk):
            window = tuple(t[1] for t in tk[i:i + w])
            hit = seen.get(window)
            if hit is None:
                seen[window] = (rel, i)
                i += 1
                continue
            srel, si = hit
            dup.setdefault(rel, set()).update(range(i, i + w))
            dup.setdefault(srel, set()).update(range(si, si + w))
            blocks.append(f'{rel}: 行{tk[i][0]} ≈ {srel}: 行{tk[si][0]}（≥{w} 行）')
            i += w
    dup_lines = sum(len(s) for s in dup.values())
    rate = dup_lines * 100.0 / total
    hot = sorted(dup.items(), key=lambda kv: -len(kv[1]))
    items = [f'{rel}: 重复 {len(s)} 行' for rel, s in hot] + blocks
    return Check('duplication-rate', '代码重复率', 'DRY', round(rate, 2),
                 f'≤ {cfg.max_dup_rate}%', rate <= cfg.max_dup_rate,
                 f'{rate:.2f}%（{dup_lines}/{total} 行）', items)


def check_comment_language(data: list[FileData]) -> Check:
    """注释必须包含中文字符（工具指令、分隔线等可豁免）。"""
    bad = []
    for d in data:
        for lineno, text, _full in d.comments:
            text = text.strip().lstrip('*').strip()
            neutral = is_neutral_comment(text, lineno, d.lines[lineno - 1])
            if not neutral and not CJK_RE.search(text):
                bad.append(f'{d.rel}:{lineno}: {text[:50]}')
    return Check('comment-language', '非中文注释', '注释规范', len(bad),
                 '0 条', not bad, f'{len(bad)} 条非中文注释', bad)


def _is_doc_annotation(text: str, raw_line: str) -> bool:
    """判断注释行是否属于文档注解（Swagger、JSDoc/Javadoc、XML 文档注释等）。"""
    s = raw_line.lstrip()
    if s.startswith('/**') or s.startswith('///'):
        return True
    t = text.strip().lstrip('*').strip()
    return t.startswith('@') and len(t) > 1 and not t[1].isspace()


def _overlong_runs(comments: list[tuple[int, str, bool]], limit: int,
                   raw_lines: list[str]) -> list[tuple[int, int]]:
    """找出超过 limit 的连续整行注释块，返回 (起始行, 长度)；文档注解块整体豁免。"""
    runs, start, length, prev, doc = [], None, 0, None, False

    def close():
        if start is not None and length > limit and not doc:
            runs.append((start, length))

    for lineno, text, full in comments:
        if full:
            if prev is not None and lineno == prev + 1:
                length += 1
            else:
                close()
                start, length, doc = lineno, 1, False
            if _is_doc_annotation(text, raw_lines[lineno - 1]):
                doc = True
            prev = lineno
        else:
            close()
            prev = None
    close()
    return runs


def check_comment_run(data: list[FileData], cfg: Config) -> Check:
    """连续整行注释过长说明该写 docstring/文档；文档注解块（Swagger 等）豁免。"""
    bad = []
    for d in data:
        for start, length in _overlong_runs(d.comments, cfg.max_comment_run, d.lines):
            bad.append(f'{d.rel}:{start}: 连续注释 {length} 行')
    return Check('comment-run', '超长注释块', '注释规范', len(bad),
                 f'连续 ≤ {cfg.max_comment_run} 行', not bad,
                 f'{len(bad)} 处超长注释块', bad)


IO_RE = re.compile(r'\b(print|input|open)\s*\(|\b(requests|httpx|urllib)\.|console\.log\s*\(|\bfetch\s*\(')


def check_domain_io(root: Path, data: list[FileData], cfg: Config) -> Check:
    """关注点分离：核心业务目录不得直接出现 IO/网络调用（需 --domain-dirs）。"""
    if not cfg.domain_dirs:
        return Check('domain-io', '核心目录 IO 调用', '关注点分离', 0, '0 处', True,
                     '未配置 --domain-dirs，跳过', skipped=True)
    bad = []
    for d in data:
        if not any(d.rel == x or d.rel.startswith(x + '/') for x in cfg.domain_dirs):
            continue
        for lineno, line in enumerate(d.lines, 1):
            m = IO_RE.search(line)
            if m:
                bad.append(f'{d.rel}:{lineno}: {m.group(0).strip()}')
    return Check('domain-io', '核心目录 IO 调用', '关注点分离', len(bad),
                 '0 处', not bad, f'{len(bad)} 处 IO 调用', bad)
