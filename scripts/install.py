#!/usr/bin/env python3
"""构建并安装技能、prompts 和扩展到全局目录。"""

import argparse
import json
import os
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

    if not shutil.which("pnpm"):
        sys.exit("错误：未找到 pnpm。请先安装 pnpm（npm install -g pnpm）。")


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


# ── Shell ──

def detect_pwsh() -> str | None:
    """检测 PowerShell 7（pwsh）可执行文件路径，找不到返回 None。"""
    found = shutil.which("pwsh") or shutil.which("pwsh.exe")

    if not found:
        # 常见安装位置兜底（仅用系统标准变量，不读取自定义 shell 偏好）
        candidates = [
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "PowerShell" / "7" / "pwsh.exe",
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "PowerShell" / "7" / "pwsh.exe",
        ]
        for c in candidates:
            if c.exists():
                found = str(c)
                break

    if not found:
        return None

    # 归一化扩展名为小写 .exe（shutil.which 在 Windows 上可能返回大写 .EXE）
    root, ext = os.path.splitext(found)
    return root + ext.lower() if ext else found


def configure_shell(pi_agent_dir: Path, force: bool) -> None:
    """在 Windows 上将 settings.json 的 shellPath 指向 PowerShell 7。

    prompts/APPEND_SYSTEM.md 假定工具 shell 是 pwsh；此处确保安装后实际 shell 与之一致。
    采用合并写法：只设置 shellPath 键，保留用户已有的其它配置。
    """
    if sys.platform != "win32":
        return

    print(f"\n{'═' * 4} shell {'═' * 4}")

    pwsh = detect_pwsh()
    if not pwsh:
        print("  跳过：未检测到 PowerShell 7（pwsh）。")
        print("    提示：APPEND_SYSTEM.md 假定 pwsh 作为工具 shell；")
        print("    请安装 PowerShell 7 后重跑，或手动在 settings.json 设置 shellPath。")
        return

    settings_path = pi_agent_dir / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    if settings_path.exists():
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            sys.exit(f"错误：{settings_path} 解析失败：{e}")
        if not isinstance(data, dict):
            sys.exit(f"错误：{settings_path} 顶层不是 JSON 对象，已跳过以避免破坏配置。")
    else:
        data = {}

    existing = data.get("shellPath")
    if existing and not force:
        print(f"  跳过 shellPath（已存在：{existing}，使用 --force 覆盖）")
        return

    data["shellPath"] = pwsh
    settings_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    action = "覆盖" if existing else "设置"
    print(f"  {action} shellPath → {pwsh}")


# ── Extensions ──

def deploy_extensions(pi_agent_dir: Path, force: bool) -> None:
    """将 extensions/ 目录下的扩展部署到 Pi 扩展目录。"""
    extensions_dir = REPO_ROOT / "extensions"
    if not extensions_dir.exists():
        return

    ext_files = [p for p in extensions_dir.iterdir() if p.is_file() or p.is_dir()]
    if not ext_files:
        return

    print(f"\n{'═' * 4} extensions {'═' * 4}")

    dest_dir = pi_agent_dir / "extensions"
    dest_dir.mkdir(parents=True, exist_ok=True)

    for src in ext_files:
        dest = dest_dir / src.name
        if dest.exists() and not force:
            print(f"  跳过 {src.name}（已存在，使用 --force 覆盖）")
            continue
        if src.is_dir():
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(src, dest)
        else:
            shutil.copy2(src, dest)
        print(f"  {src.name} → {dest}")


# ── Skills ──

def build_skill(skill_dir: Path) -> None:
    """在仓库根安装 workspace 依赖（幂等，只需一次）。"""
    pkg_path = skill_dir / "package.json"
    if not pkg_path.exists():
        return

    print("  安装依赖...")
    r = run(["pnpm", "install", "--ignore-scripts"], cwd=REPO_ROOT)
    if r.returncode != 0:
        sys.exit(f"pnpm install 失败（退出码 {r.returncode}）")


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
            print(f"  跳过（已存在：{destination}，使用 --force 覆盖）")
            return
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

    if (destination / "package.json").exists():
        run(["pnpm", "install", "--prod", "--ignore-scripts", "--ignore-workspace"], cwd=destination)

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

        destination = skills_dir / skill_name
        if destination.exists() and not force:
            # 提前跳过，避免为已存在的技能白跑一次 pnpm install
            print(f"  跳过（已存在：{destination}，使用 --force 覆盖）")
            continue

        build_skill(skill_dir)

        deploy_script = skill_dir / "scripts" / "deploy.py"

        print(f"  部署到 {destination} ...")
        if deploy_script.exists():
            deploy_with_script(skill_dir, destination, force)
        else:
            deploy_generic(skill_dir, destination, force)


# ── 入口 ──

def main() -> None:
    parser = argparse.ArgumentParser(
        description="构建并安装技能、prompts 和扩展（不加选择参数则全部安装）"
    )
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
    parser.add_argument("--skills", action="store_true", help="安装技能")
    parser.add_argument("--prompts", action="store_true", help="部署 prompts")
    parser.add_argument("--extensions", action="store_true", help="部署扩展")
    args = parser.parse_args()

    # 不加选择参数时全部安装
    install_all = not (args.skills or args.prompts or args.extensions)

    check_prerequisites()

    if install_all or args.prompts:
        deploy_prompts(args.pi_agent_dir, args.force)
        # APPEND_SYSTEM.md 假定工具 shell 为 pwsh，需同步配置 settings.json
        configure_shell(args.pi_agent_dir, args.force)

    if install_all or args.extensions:
        deploy_extensions(args.pi_agent_dir, args.force)

    if install_all or args.skills:
        deploy_skills(args.skills_dir, args.name, args.force)

    print("\n全部完成。")


if __name__ == "__main__":
    main()
