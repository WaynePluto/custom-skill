#!/usr/bin/env python3
"""构建并安装技能和 prompts 到全局目录。"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


# ── 工具函数 ──

def run(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=cwd, shell=(sys.platform == "win32"))


def check_prerequisites() -> None:
    if not shutil.which("node"):
        sys.exit("错误：未找到 Node.js（要求 >= 20）。请先安装 Node.js。")

    result = subprocess.run(
        ["node", "--version"], capture_output=True, text=True,
        shell=(sys.platform == "win32"),
    )
    version = result.stdout.strip().lstrip("v")
    major = int(version.split(".")[0])
    if major < 20:
        sys.exit(f"错误：Node.js 版本过低：v{version}（要求 >= 20）。")

    if not shutil.which("npm"):
        sys.exit("错误：未找到 npm。请确认 Node.js 安装完整。")


def dir_size_mb(path: Path) -> float:
    total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return total / (1024 * 1024)


# ── Prompts ──

def deploy_prompts(pi_agent_dir: Path, force: bool) -> None:
    """将 prompts/ 目录下的文件部署到 Pi agent 目录。"""
    prompts_dir = REPO_ROOT / "prompts"
    if not prompts_dir.exists():
        return

    prompt_files = list(prompts_dir.glob("*.md"))
    if not prompt_files:
        return

    print(f"\n{'═' * 4} prompts {'═' * 4}")

    pi_agent_dir.mkdir(parents=True, exist_ok=True)

    for src in prompt_files:
        dest = pi_agent_dir / src.name
        if dest.exists() and not force:
            print(f"  跳过 {src.name}（已存在，使用 --force 覆盖）")
            continue
        shutil.copy2(src, dest)
        print(f"  {src.name} → {dest}")


# ── Skills ──

def build_skill(skill_dir: Path) -> None:
    """安装依赖并执行构建。"""
    pkg_path = skill_dir / "package.json"
    if not pkg_path.exists():
        return

    print("  安装依赖...")
    r = run(["npm", "install", "--ignore-scripts"], cwd=skill_dir)
    if r.returncode != 0:
        sys.exit(f"npm install 失败（退出码 {r.returncode}）")

    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    if pkg.get("scripts", {}).get("build"):
        print("  构建打包...")
        r = run(["npm", "run", "build"], cwd=skill_dir)
        if r.returncode != 0:
            sys.exit(f"npm run build 失败（退出码 {r.returncode}）")


def deploy_with_script(skill_dir: Path, destination: Path, force: bool) -> None:
    """使用技能自带的 deploy.py 部署。"""
    deploy_script = skill_dir / "scripts" / "deploy.py"
    deploy_args = [sys.executable, str(deploy_script), "--destination", str(destination)]
    if force:
        deploy_args.append("--force")
    r = run(deploy_args)
    if r.returncode != 0:
        sys.exit(f"部署失败（退出码 {r.returncode}）")


def deploy_generic(skill_dir: Path, destination: Path, force: bool) -> None:
    """通用部署：复制必要文件，安装生产依赖。"""
    if destination.exists():
        if not force:
            sys.exit(f"目标目录已存在：{destination}\n使用 --force 覆盖。")
        shutil.rmtree(destination)

    exclude = {"tests", "node_modules", ".gitignore", "dist"}
    destination.mkdir(parents=True, exist_ok=True)

    for item in skill_dir.iterdir():
        if item.name in exclude:
            continue
        dest_item = destination / item.name
        if item.is_dir():
            shutil.copytree(item, dest_item)
        else:
            shutil.copy2(item, dest_item)

    dist_dir = skill_dir / "dist"
    if dist_dir.exists():
        shutil.copytree(dist_dir, destination / "dist")

    if (destination / "package.json").exists():
        run(["npm", "install", "--omit=dev", "--ignore-scripts"], cwd=destination)

    print(f"  部署完成（{dir_size_mb(destination):.1f} MB）")


def deploy_skills(skills_dir: Path, name: str | None, force: bool) -> None:
    """构建并部署技能。"""
    sources_dir = REPO_ROOT / "skills"

    if name:
        skill_dirs = [sources_dir / name]
        if not skill_dirs[0].exists():
            sys.exit(f"技能不存在：{name}（路径 {skill_dirs[0]}）")
    else:
        skill_dirs = sorted(d for d in sources_dir.iterdir() if d.is_dir())
        if not skill_dirs:
            print("未发现任何技能。")
            return

    for skill_dir in skill_dirs:
        skill_name = skill_dir.name
        if not (skill_dir / "SKILL.md").exists():
            print(f"跳过 {skill_name}（缺少 SKILL.md）")
            continue

        print(f"\n{'═' * 4} {skill_name} {'═' * 4}")

        build_skill(skill_dir)

        destination = skills_dir / skill_name
        deploy_script = skill_dir / "scripts" / "deploy.py"

        print(f"  部署到 {destination} ...")
        if deploy_script.exists():
            deploy_with_script(skill_dir, destination, force)
        else:
            deploy_generic(skill_dir, destination, force)


# ── 入口 ──

def main() -> None:
    parser = argparse.ArgumentParser(description="构建并安装技能和 prompts")
    parser.add_argument("--name", default=None, help="要安装的技能名称（省略则安装所有）")
    parser.add_argument(
        "--skills-dir", type=Path,
        default=Path.home() / ".agents" / "skills",
        help="全局 Skills 目录路径",
    )
    parser.add_argument(
        "--pi-agent-dir", type=Path,
        default=Path.home() / ".pi" / "agent",
        help="Pi agent 配置目录路径",
    )
    parser.add_argument("--force", action="store_true", help="覆盖已存在的文件")
    parser.add_argument("--no-skills", action="store_true", help="跳过技能安装")
    parser.add_argument("--no-prompts", action="store_true", help="跳过 prompts 部署")
    args = parser.parse_args()

    check_prerequisites()

    if not args.no_prompts:
        deploy_prompts(args.pi_agent_dir, args.force)

    if not args.no_skills:
        deploy_skills(args.skills_dir, args.name, args.force)

    print("\n全部完成。")


if __name__ == "__main__":
    main()
