#!/usr/bin/env python3
"""db_snapshot.py — 生成数据库 schema 快照（只读；快照是临时文件，不入 Git）。

用法:
  python db_snapshot.py sqlite --file <db文件> [--out <快照路径>]
  python db_snapshot.py sqlite --migrations <迁移目录> [--out <快照路径>]
  python db_snapshot.py pg --conn <连接串> [--out <快照路径>]

省略 --out 时输出到 stdout（超长会截断）。
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

SNAPSHOT_VERSION = 1
STDOUT_LIMIT = 200_000  # 软上限，防止超大 schema 撑爆模型上下文

SQLITE_OBJECT_TYPES = ("table", "index", "view", "trigger")


class SnapshotError(Exception):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def redact_conn(conn: str) -> str:
    """打码连接串里的密码（URL 型与关键字型），避免凭据落进快照。"""
    redacted = re.sub(r"(://[^:/@]+:)[^@]+@", r"\1***@", conn)
    redacted = re.sub(r"(password\s*=\s*)\S+", r"\1***", redacted, flags=re.IGNORECASE)
    return redacted


def _header(info_lines: list[str]) -> str:
    lines = [f"-- db-schema-snapshot v{SNAPSHOT_VERSION}", f"-- generated: {utc_now()}"]
    lines += [f"-- {line}" for line in info_lines]
    return "\n".join(lines)


def _statement(sql: str) -> str:
    sql = sql.strip()
    return sql if sql.endswith(";") else sql + ";"


def _dump_sqlite_objects(conn: sqlite3.Connection) -> tuple[str, dict[str, int]]:
    rows = conn.execute(
        "SELECT type, name, sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql IS NOT NULL "
        "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 "
        "WHEN 'view' THEN 2 ELSE 3 END, name"
    ).fetchall()
    counts = dict.fromkeys(SQLITE_OBJECT_TYPES, 0)
    sections: list[str] = []
    current_type = None
    for type_, _name, sql in rows:
        counts[type_] = counts.get(type_, 0) + 1
        if type_ != current_type:
            sections.append(f"-- ================ {type_}s ================")
            current_type = type_
        sections.append(_statement(sql))
    return "\n\n".join(sections), counts


def _counts_line(counts: dict[str, int]) -> str:
    names = {"table": "tables", "index": "indexes", "view": "views", "trigger": "triggers"}
    return "objects: " + " ".join(f"{names[t]}={counts[t]}" for t in SQLITE_OBJECT_TYPES)


def _open_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise SnapshotError(f"数据库文件不存在: {path}")
    uri = path.resolve().as_uri() + "?mode=ro"
    try:
        return sqlite3.connect(uri, uri=True)
    except sqlite3.Error as exc:
        raise SnapshotError(f"无法以只读方式打开 {path}: {exc}") from exc


def snapshot_sqlite_file(path: Path) -> tuple[str, dict[str, int], list[str]]:
    conn = _open_readonly(path)
    try:
        user_version = conn.execute("PRAGMA user_version").fetchone()[0]
        body, counts = _dump_sqlite_objects(conn)
    finally:
        conn.close()
    info = [
        f"source: sqlite file {path.resolve()} (read-only)",
        f"user_version: {user_version}",
        _counts_line(counts),
    ]
    if user_version == 0:
        info.append("note: user_version 为 0，无法做过期判断，跨会话使用前请重新生成")
    return body, counts, info


def snapshot_sqlite_migrations(dir_path: Path) -> tuple[str, dict[str, int], list[str]]:
    if not dir_path.is_dir():
        raise SnapshotError(f"迁移目录不存在: {dir_path}")
    files = sorted(p for p in dir_path.glob("*.sql") if p.is_file())
    if not files:
        raise SnapshotError(f"{dir_path} 中没有找到 *.sql 迁移文件")

    conn = sqlite3.connect(":memory:")
    applied: list[str] = []
    try:
        for file in files:
            try:
                conn.executescript(file.read_text(encoding="utf-8-sig"))
                applied.append(file.name)
            except sqlite3.Error as exc:
                raise SnapshotError(f"应用迁移 {file.name} 失败: {exc}") from exc
        user_version = conn.execute("PRAGMA user_version").fetchone()[0]
        body, counts = _dump_sqlite_objects(conn)
    finally:
        conn.close()

    info = [
        f"source: migrations dir {dir_path.resolve()} "
        f"(applied {len(applied)} files in filename order: {', '.join(applied)})",
        f"user_version: {user_version}",
        _counts_line(counts),
    ]
    if user_version == 0:
        info.append("note: 迁移未设置 PRAGMA user_version，无法做过期判断")
    return body, counts, info


def snapshot_pg(conn_str: str) -> tuple[str, dict[str, int], list[str]]:
    pg_dump = shutil.which("pg_dump")
    if not pg_dump:
        raise SnapshotError("PATH 中找不到 pg_dump，请先安装 PostgreSQL 客户端工具")
    proc = subprocess.run(
        [pg_dump, "--schema-only", "--no-owner", "--no-privileges", f"--dbname={conn_str}"],
        capture_output=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace").strip()
        raise SnapshotError(f"pg_dump 失败（exit {proc.returncode}）: {stderr[:2000]}")
    body = proc.stdout.decode("utf-8", "replace")
    counts = {
        "table": len(re.findall(r"(?m)^CREATE TABLE ", body)),
        "index": len(re.findall(r"(?m)^CREATE (?:UNIQUE )?INDEX ", body)),
        "view": len(re.findall(r"(?m)^CREATE (?:OR REPLACE )?VIEW ", body)),
        "trigger": len(re.findall(r"(?m)^CREATE (?:CONSTRAINT )?TRIGGER ", body)),
    }
    info = [
        f"source: pg_dump --schema-only {redact_conn(conn_str)}",
        _counts_line(counts),
        "note: PG 无通用 schema 版本号，本快照按会话级对待，跨会话使用前重新生成",
    ]
    return body, counts, info


def _truncate(content: str) -> str:
    if len(content) <= STDOUT_LIMIT:
        return content
    return content[:STDOUT_LIMIT] + f"\n-- ……已截断（完整内容 {len(content)} 字符，请用 --out 落盘）"


def _render(info: list[str], body: str) -> str:
    return _header(info) + "\n\n" + body.strip() + "\n"


def _print_summary(kind: str, info: list[str], out_path: Path | None) -> None:
    print(f"kind: {kind}")
    for line in info:
        print(line)
    print(f"snapshot: {out_path.resolve() if out_path else '<stdout>'}")


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="kind", required=True)

    p_sqlite = sub.add_parser("sqlite", help="SQLite：真实库文件（只读）或 .sql 迁移目录")
    p_sqlite.add_argument("--file", type=Path, help="真实库文件，与 --migrations 二选一")
    p_sqlite.add_argument("--migrations", type=Path, help="编号 .sql 迁移目录，与 --file 二选一")
    p_sqlite.add_argument("--out", type=Path)

    p_pg = sub.add_parser("pg", help="PostgreSQL：调用 pg_dump --schema-only")
    p_pg.add_argument("--conn", required=True, help="连接串（密码会被打码后再写入快照头部）")
    p_pg.add_argument("--out", type=Path)

    args = parser.parse_args(argv)

    try:
        if args.kind == "sqlite":
            if bool(args.file) == bool(args.migrations):
                raise SnapshotError("--file 与 --migrations 必须恰好提供一个")
            if args.file:
                body, _counts, info = snapshot_sqlite_file(args.file)
            else:
                body, _counts, info = snapshot_sqlite_migrations(args.migrations)
            kind_label = f"sqlite ({'file' if args.file else 'migrations'})"
        else:
            body, _counts, info = snapshot_pg(args.conn)
            kind_label = "pg"

        content = _render(info, body)
        if args.out is None:
            print(_truncate(content))
        else:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(content, encoding="utf-8", newline="\n")
        _print_summary(kind_label, info, args.out)
        return 0
    except SnapshotError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
