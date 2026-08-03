#!/usr/bin/env python3
"""把 browser-tools 技能部署到指定目录（默认 ~/.agents/skills/browser-tools）。

复制 SKILL.md、scripts/、package.json，然后在目标目录执行
pnpm install --prod（依赖从 pnpm store 硬链接，几乎不占额外磁盘）。
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

DEPLOY_FILES = ["SKILL.md", "package.json"]
DEPLOY_DIRS = ["scripts"]


def run(cmd: list[str], cwd: Path) -> None:
    result = subprocess.run(cmd, cwd=cwd, shell=(sys.platform == "win32"))
    if result.returncode != 0:
        sys.exit(f"{' '.join(cmd)} 失败（退出码 {result.returncode}）。")


def dir_size_mb(path: Path) -> float:
    total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return total / (1024 * 1024)


def main() -> None:
    skill_root = Path(__file__).resolve().parent.parent

    parser = argparse.ArgumentParser(description="部署 browser-tools 技能")
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path.home() / ".agents" / "skills" / skill_root.name,
        help="部署目标路径",
    )
    parser.add_argument("--force", action="store_true", help="覆盖已存在的目标目录")
    args = parser.parse_args()

    dest: Path = args.destination

    if dest.exists():
        if not args.force:
            print(f"跳过：目标目录已存在（{dest}），使用 --force 覆盖。")
            return
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    for name in DEPLOY_FILES:
        shutil.copy2(skill_root / name, dest / name)
    for name in DEPLOY_DIRS:
        shutil.copytree(skill_root / name, dest / name)

    print("安装运行时依赖（pnpm install --prod）...")
    run(["pnpm", "install", "--prod", "--ignore-scripts", "--ignore-workspace"], cwd=dest)

    print(f"\n部署完成：{dest}")
    print(f"总计体积（含硬链接依赖）：{dir_size_mb(dest):.1f} MB")


if __name__ == "__main__":
    main()
