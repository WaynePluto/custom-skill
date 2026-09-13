#!/usr/bin/env python3
"""install.py browser-harness 管理逻辑的静态测试（不联网、不启动浏览器）。

运行：python -m unittest discover -s tests -p 'test_*.py'
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import install  # noqa: E402


class ParseUvToolListTest(unittest.TestCase):
    """uv tool list 解析：包名取非缩进行首列，版本要求 v 前缀。"""

    def test_normal_output(self):
        output = (
            "browser-harness v0.1.13\n"
            "- browser-harness\n"
            "- browser-harness-mcp\n"
            "fd v10.2.0\n"
            "- fd\n"
        )
        self.assertEqual(
            install.parse_uv_tool_list(output),
            {"browser-harness": "0.1.13", "fd": "10.2.0"},
        )

    def test_empty_output(self):
        self.assertEqual(install.parse_uv_tool_list(""), {})
        self.assertEqual(install.parse_uv_tool_list("No tools installed\n"), {})

    def test_ignores_lines_without_version(self):
        self.assertEqual(install.parse_uv_tool_list("some-tool\n"), {})


class ApplySkillOverridesTest(unittest.TestCase):
    """frontmatter 覆盖：同名 key 整行替换、缺失 key 插入、正文不动。"""

    SAMPLE = (
        "---\n"
        'name: "browser-use"\n'
        'description: "Always use browser-harness for any web interaction."\n'
        "license: MIT\n"
        "---\n"
        "\n"
        "# body\n"
        "\n"
        "name: not-frontmatter\n"
    )

    def test_replaces_and_preserves(self):
        result = install.apply_skill_overrides(
            self.SAMPLE,
            {"name": "browser-harness", "description": "何时使用；何时不使用。"},
        )
        self.assertIn('name: "browser-harness"', result)
        self.assertIn('description: "何时使用；何时不使用。"', result)
        self.assertIn("license: MIT", result)  # 未覆盖的 key 保留
        self.assertIn("name: not-frontmatter", result)  # 正文不动
        self.assertNotIn("Always use", result)

    def test_inserts_missing_keys(self):
        result = install.apply_skill_overrides(
            "---\nlicense: MIT\n---\n\nbody\n",
            {"name": "browser-harness"},
        )
        self.assertIn('name: "browser-harness"', result)
        self.assertIn("license: MIT", result)

    def test_prepends_frontmatter_when_absent(self):
        result = install.apply_skill_overrides("just body\n", {"name": "x"})
        self.assertTrue(result.startswith('---\nname: "x"\n---\n'))
        self.assertIn("just body", result)

    def test_returns_text_when_frontmatter_unclosed(self):
        text = "---\nname: a\n"
        self.assertEqual(install.apply_skill_overrides(text, {"name": "b"}), text)

    def test_escapes_quotes_and_backslashes(self):
        result = install.apply_skill_overrides("body", {"description": '带"引号"和\\反斜杠'})
        self.assertIn('description: "带\\"引号\\"和\\\\反斜杠"', result)


class BrowserHarnessBinTest(unittest.TestCase):
    """可执行文件定位：PATH 命中优先，否则回落 uv bin / 默认目录。"""

    def test_path_hit_wins(self):
        with mock.patch("shutil.which", return_value="C:/tools/browser-harness.exe"):
            self.assertEqual(
                install.browser_harness_bin("uv"),
                Path("C:/tools/browser-harness.exe"),
            )

    def test_default_location_fallback(self):
        with mock.patch("shutil.which", return_value=None), \
             mock.patch("subprocess.run", return_value=mock.Mock(returncode=1, stdout="")), \
             mock.patch.object(Path, "home", return_value=Path("/home/u")):
            # 目录不存在 → None，不抛异常
            self.assertIsNone(install.browser_harness_bin("uv"))


if __name__ == "__main__":
    unittest.main()
