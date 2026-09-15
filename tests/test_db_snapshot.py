#!/usr/bin/env python3
"""db_snapshot.py 快照生成逻辑的静态测试（不联网，fixture 全部在临时目录中生成）。

运行：python -m unittest discover -s tests -p 'test_*.py'
"""

import io
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SKILL_SCRIPTS = Path(__file__).resolve().parent.parent / 'skills' / 'db-schema-snapshot' / 'scripts'
sys.path.insert(0, str(SKILL_SCRIPTS))

import db_snapshot  # noqa: E402


def run_main(argv):
    """执行 main，返回 (exit_code, stdout)。"""
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        code = db_snapshot.main(argv)
    return code, buffer.getvalue()


def make_sample_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id)
        );
        CREATE INDEX sessions_user_id_idx ON sessions(user_id);
        CREATE VIEW active_users AS SELECT * FROM users WHERE name IS NOT NULL;
        PRAGMA user_version = 4;
        """
    )
    conn.commit()
    conn.close()


class RedactConnTest(unittest.TestCase):
    def test_redacts_url_password(self):
        self.assertEqual(
            db_snapshot.redact_conn('postgresql://alice:secret@db.example.com:5432/app'),
            'postgresql://alice:***@db.example.com:5432/app',
        )

    def test_redacts_keyword_password(self):
        self.assertEqual(
            db_snapshot.redact_conn('host=localhost user=alice password=s3cret dbname=app'),
            'host=localhost user=alice password=*** dbname=app',
        )

    def test_keeps_passwordless_conn(self):
        plain = 'postgresql://alice@db.example.com/app'
        self.assertEqual(db_snapshot.redact_conn(plain), plain)


class SqliteFileTest(unittest.TestCase):
    def test_dumps_schema_with_header_and_does_not_touch_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'relay.db'
            make_sample_db(db_path)
            before = db_path.read_bytes()

            out_path = Path(tmp) / '.ai' / 'schema-v4.sql'
            code, stdout = run_main(['sqlite', '--file', str(db_path), '--out', str(out_path)])

            self.assertEqual(code, 0)
            self.assertTrue(out_path.is_file())
            content = out_path.read_text(encoding='utf-8')
            self.assertEqual(db_path.read_bytes(), before, '只读导出不得改动源库文件')

            self.assertIn('-- db-schema-snapshot v1', content)
            self.assertIn('-- source: sqlite file', content)
            self.assertIn('-- user_version: 4', content)
            self.assertIn('-- objects: tables=2 indexes=1 views=1 triggers=0', content)
            self.assertIn('CREATE TABLE users', content)
            self.assertIn('REFERENCES users(id)', content, 'SQLite 外键应保留在 CREATE TABLE 原文里')
            self.assertIn('CREATE INDEX sessions_user_id_idx', content)
            self.assertIn('CREATE VIEW active_users', content)

            self.assertIn(f'snapshot: {out_path.resolve()}', stdout)
            self.assertIn('user_version: 4', stdout)

    def test_missing_file_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = db_snapshot.main(['sqlite', '--file', str(Path(tmp) / 'nope.db')])
            self.assertEqual(code, 1)

    def test_stdout_output_without_out_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'a.db'
            make_sample_db(db_path)
            code, stdout = run_main(['sqlite', '--file', str(db_path)])
            self.assertEqual(code, 0)
            self.assertIn('CREATE TABLE users', stdout)


class SqliteMigrationsTest(unittest.TestCase):
    def test_applies_sql_files_in_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            mig = Path(tmp) / 'migrations'
            mig.mkdir()
            (mig / '001_init.sql').write_text(
                'CREATE TABLE items (id TEXT PRIMARY KEY);', encoding='utf-8'
            )
            (mig / '002_add_col.sql').write_text(
                'ALTER TABLE items ADD COLUMN note TEXT;\nPRAGMA user_version = 2;',
                encoding='utf-8',
            )
            (mig / '999_notes.sql').write_text(
                '-- 只写注释不写 SQL\n', encoding='utf-8'
            )

            out_path = Path(tmp) / 'schema.sql'
            code, _stdout = run_main(['sqlite', '--migrations', str(mig), '--out', str(out_path)])

            self.assertEqual(code, 0)
            content = out_path.read_text(encoding='utf-8')
            self.assertIn('note TEXT', content)
            self.assertIn('-- user_version: 2', content)
            self.assertIn('applied 3 files', content)
            self.assertIn('-- objects: tables=1 indexes=0 views=0 triggers=0', content)

    def test_failed_migration_aborts_without_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            mig = Path(tmp) / 'migrations'
            mig.mkdir()
            (mig / '001_ok.sql').write_text('CREATE TABLE a (id TEXT);', encoding='utf-8')
            (mig / '002_bad.sql').write_text('THIS IS NOT SQL;', encoding='utf-8')

            out_path = Path(tmp) / 'schema.sql'
            stderr = io.StringIO()
            with redirect_stdout(io.StringIO()):
                with mock.patch('sys.stderr', stderr):
                    code = db_snapshot.main(
                        ['sqlite', '--migrations', str(mig), '--out', str(out_path)]
                    )

            self.assertEqual(code, 1)
            self.assertIn('002_bad.sql', stderr.getvalue())
            self.assertFalse(out_path.exists())

    def test_empty_dir_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = db_snapshot.main(['sqlite', '--migrations', str(tmp)])
            self.assertEqual(code, 1)

    def test_file_and_migrations_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = db_snapshot.main(
                ['sqlite', '--file', str(Path(tmp) / 'a.db'), '--migrations', str(tmp)]
            )
            self.assertEqual(code, 1)


class PgTest(unittest.TestCase):
    def test_missing_pg_dump_fails_cleanly(self):
        with mock.patch.object(db_snapshot.shutil, 'which', return_value=None):
            code = db_snapshot.main(['pg', '--conn', 'postgresql://x/y'])
            self.assertEqual(code, 1)

    def test_pg_dump_invocation_and_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_body = (
                'CREATE TABLE public.users (\n    id integer NOT NULL\n);\n'
                'ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);\n'
            )

            class FakeProc:
                returncode = 0
                stdout = fake_body.encode('utf-8')
                stderr = b''

            recorded = {}

            def fake_run(cmd, **_kwargs):
                recorded['cmd'] = cmd
                return FakeProc()

            out_path = Path(tmp) / 'schema-pg.sql'
            with mock.patch.object(db_snapshot.shutil, 'which', return_value='/usr/bin/pg_dump'):
                with mock.patch.object(db_snapshot.subprocess, 'run', side_effect=fake_run):
                    code, _stdout = run_main(
                        [
                            'pg',
                            '--conn',
                            'postgresql://alice:secret@localhost/app',
                            '--out',
                            str(out_path),
                        ]
                    )

            self.assertEqual(code, 0)
            pg_args = recorded['cmd'][1:]
            self.assertIn('--schema-only', pg_args)
            self.assertIn('--no-owner', pg_args)
            self.assertIn('--no-privileges', pg_args)
            self.assertIn(
                '--dbname=postgresql://alice:secret@localhost/app', pg_args,
                '真实连接串必须传给 pg_dump',
            )

            content = out_path.read_text(encoding='utf-8')
            self.assertIn('alice:***@localhost/app', content, '快照头部必须打码密码')
            self.assertNotIn('secret', content)
            self.assertIn('CREATE TABLE public.users', content)
            self.assertIn('-- objects: tables=1 indexes=0 views=0 triggers=0', content)


class StdoutTruncationTest(unittest.TestCase):
    def test_stdout_truncated_when_over_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'big.db'
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE t (a TEXT, b TEXT, c TEXT, d TEXT, e TEXT)")
            conn.commit()
            conn.close()

            original_limit = db_snapshot.STDOUT_LIMIT
            db_snapshot.STDOUT_LIMIT = 50
            try:
                code, stdout = run_main(['sqlite', '--file', str(db_path)])
            finally:
                db_snapshot.STDOUT_LIMIT = original_limit

            self.assertEqual(code, 0)
            self.assertIn('已截断', stdout)


if __name__ == '__main__':
    unittest.main()
