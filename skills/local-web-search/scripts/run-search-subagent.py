#!/usr/bin/env python3
"""为网络搜索研究生成子 Agent 任务文本，或启动隔离的 pi 子进程执行研究。

当前 Agent 有 subagent 工具时，用 --print-prompt 输出任务文本交给 subagent 工具；
没有 subagent 工具时，直接运行本脚本（不带 --print-prompt）由 pi --print 子进程执行。
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

TEMPLATE_NAME = "subagent-task.md"


def find_scripts(scripts_dir: Path) -> dict[str, Path]:
    return {
        "research": scripts_dir / "research.mjs",
        "search": scripts_dir / "search-bing.mjs",
        "read": scripts_dir / "read-page.mjs",
    }


def check_prerequisites(skill_root: Path, research_script: Path) -> None:
    if not shutil.which("node"):
        sys.exit("错误：未找到 Node.js。请安装 Node.js 20 或更高版本。")
    if not shutil.which("pi"):
        sys.exit("错误：未找到 Pi CLI。请确认 pi 命令已加入 PATH。")
    if not research_script.exists():
        sys.exit(f"错误：搜索脚本不存在：{research_script}")
    if not (skill_root / "node_modules" / "playwright-core").exists():
        sys.exit(f"错误：技能依赖尚未安装。请先在 {skill_root} 执行：pnpm install --ignore-scripts")


def build_prompt(query: str, scripts: dict[str, Path]) -> str:
    """从共享模板 subagent-task.md 生成子 Agent 任务文本，两种执行方式共用同一份内容。"""
    template_path = scripts["research"].parent / TEMPLATE_NAME
    template = template_path.read_text(encoding="utf-8")
    return (
        template.replace("{{scripts_dir}}", str(scripts["research"].parent))
        .replace("{{query}}", query)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="为网络搜索研究生成/启动隔离子 Agent")
    parser.add_argument("--query", required=True, help="完整搜索任务描述")
    parser.add_argument("--provider", default=None, help="Pi provider（仅 pi CLI 方式）")
    parser.add_argument("--model", default=None, help="Pi model（仅 pi CLI 方式）")
    parser.add_argument(
        "--print-prompt",
        action="store_true",
        help="只把子 Agent 任务文本打印到 stdout 后退出（供 subagent 工具使用），不启动任何进程",
    )
    args = parser.parse_args()

    scripts_dir = Path(__file__).resolve().parent
    skill_root = scripts_dir.parent
    scripts = find_scripts(scripts_dir)

    prompt = build_prompt(args.query, scripts)

    if args.print_prompt:
        print(prompt)
        return

    check_prerequisites(skill_root, scripts["research"])

    pi_args = [
        "pi",
        "--print",
        "--no-session",
        "--no-skills",
        "--no-prompt-templates",
        "--no-extensions",
        "--no-context-files",
        "--tools", "read,bash",
    ]
    if args.provider:
        pi_args += ["--provider", args.provider]
    if args.model:
        pi_args += ["--model", args.model]

    # prompt 通过 stdin 传递，避免 Windows 上 cmd.exe 在换行符处截断命令行参数
    result = subprocess.run(
        pi_args,
        input=prompt,
        text=True,
        shell=(sys.platform == "win32"),
    )
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
