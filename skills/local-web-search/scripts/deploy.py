#!/usr/bin/env python3
"""将 local-web-search 技能部署到指定目录（默认 ~/.agents/skills/local-web-search）。"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run_npm(args: list[str], cwd: Path) -> None:
    """运行 npm 命令，失败时退出。"""
    result = subprocess.run(["npm", *args], cwd=cwd, shell=(sys.platform == "win32"))
    if result.returncode != 0:
        sys.exit(f"npm {' '.join(args)} 失败（退出码 {result.returncode}）")


def dir_size_mb(path: Path) -> float:
    total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return total / (1024 * 1024)


def main() -> None:
    skill_root = Path(__file__).resolve().parent.parent

    parser = argparse.ArgumentParser(description="部署 local-web-search 技能")
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path.home() / ".agents" / "skills" / "local-web-search",
        help="部署目标路径",
    )
    parser.add_argument("--force", action="store_true", help="覆盖已存在的目标目录")
    args = parser.parse_args()

    dest: Path = args.destination

    # 检查构建产物
    dist_dir = skill_root / "dist"
    if not (dist_dir / "research.js").exists():
        print("构建产物不存在，先执行 npm run build...")
        run_npm(["run", "build"], cwd=skill_root)

    # 检查目标目录
    if dest.exists():
        if not args.force:
            sys.exit(f"目标目录已存在：{dest}\n使用 --force 覆盖。")
        shutil.rmtree(dest)

    # 复制 dist/
    shutil.copytree(dist_dir, dest / "dist")

    # 复制 SKILL.md
    shutil.copy2(skill_root / "SKILL.md", dest / "SKILL.md")

    # 复制脚本目录（只含 Python 运行脚本）
    scripts_dest = dest / "scripts"
    scripts_dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(skill_root / "scripts" / "run-search-subagent.py", scripts_dest / "run-search-subagent.py")

    # 创建最小 package.json（仅运行时外部依赖）
    runtime_pkg = {
        "name": "local-web-search-skill-runtime",
        "version": "0.1.0",
        "private": True,
        "type": "module",
        "dependencies": {
            "playwright-core": "^1.58.2",
            "jsdom": "^28.1.0",
        },
    }
    (dest / "package.json").write_text(json.dumps(runtime_pkg, indent=2), encoding="utf-8")

    # 安装运行时依赖
    print("安装运行时依赖...")
    run_npm(["install", "--ignore-scripts"], cwd=dest)

    print(f"\n部署完成：{dest}")
    print(f"总计体积：{dir_size_mb(dest):.1f} MB")


if __name__ == "__main__":
    main()
