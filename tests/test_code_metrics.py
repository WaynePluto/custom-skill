#!/usr/bin/env python3
"""code_metrics.py 检测逻辑的静态测试（不联网，fixture 全部在临时目录中生成）。

运行：python -m unittest discover -s tests -p 'test_*.py'
"""

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

SKILL_SCRIPTS = Path(__file__).resolve().parent.parent / 'skills' / 'refactor-review' / 'scripts'
sys.path.insert(0, str(SKILL_SCRIPTS))

import code_metrics  # noqa: E402
import py_metrics  # noqa: E402
import text_metrics  # noqa: E402
from metrics_core import Config  # noqa: E402


def scan(root: Path):
    """对目录执行加载，返回 FileData 列表。"""
    files = code_metrics.discover_files(root, ())
    data, _errors = code_metrics.load_files(root, files)
    return data


def run_main(argv: list[str]) -> tuple[int, str]:
    """执行 CLI 入口并捕获输出，返回 (退出码, stdout)。"""
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = code_metrics.main(argv)
    return rc, buf.getvalue()


class TempDirTest(unittest.TestCase):
    """提供临时目录基类。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def write(self, rel: str, content: str) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path


class ExitCodeTest(TempDirTest):
    """退出码语义：0=全部达标，1=存在不达标。"""

    def test_clean_project_passes(self):
        self.write('ok.py', '# 中文说明\nx = 1  # 赋值\nprint(x)\n')
        rc, out = run_main([str(self.root)])
        self.assertEqual(rc, 0)
        self.assertIn('全部指标达标', out)

    def test_violation_fails(self):
        self.write('big.py', '\n'.join(f'x{i} = {i}' for i in range(601)) + '\n')
        rc, out = run_main([str(self.root)])
        self.assertEqual(rc, 1)
        self.assertIn('文件行数', out)

    def test_json_report_and_compare(self):
        big = self.write('big.py', '\n'.join(f'x{i} = {i}' for i in range(601)) + '\n')
        report = self.root / 'report.json'
        rc, _ = run_main([str(self.root), '--json', str(report)])
        self.assertEqual(rc, 1)
        doc = json.loads(report.read_text(encoding='utf-8'))
        self.assertFalse(doc['passed'])
        ids = {c['id'] for c in doc['checks']}
        self.assertIn('file-length', ids)
        # 修复后对比基线，应显示改善
        big.write_text('x = 1\n', encoding='utf-8')
        rc, out = run_main([str(self.root), '--compare', str(report)])
        self.assertEqual(rc, 0)
        self.assertIn('改善', out)


class TextMetricsTest(TempDirTest):
    """文本级指标：行数、重复率、注释规范、IO。"""

    def test_file_length_boundary(self):
        self.write('a.py', 'x = 1\n' * 600)   # 恰好 600 行：达标
        self.write('b.py', 'y = 2\n' * 601)   # 601 行：超限
        check = text_metrics.check_file_length(scan(self.root), Config())
        self.assertFalse(check.passed)
        self.assertEqual(check.value, 1)
        self.assertIn('b.py', check.items[0])

    def test_duplication_detected(self):
        block = '\n'.join(f'do_thing_{i}({i})' for i in range(8))
        self.write('a.py', f'# 文件甲\n{block}\n')
        self.write('b.py', f'# 文件乙\n{block}\n')
        check = text_metrics.check_duplication(scan(self.root), Config())
        self.assertFalse(check.passed)
        self.assertGreater(check.value, 0)

    def test_short_duplication_ignored(self):
        block = '\n'.join(f'short_{i}' for i in range(5))  # 少于最小克隆窗口
        self.write('a.py', f'# 甲\n{block}\n')
        self.write('b.py', f'# 乙\n{block}\n')
        check = text_metrics.check_duplication(scan(self.root), Config())
        self.assertTrue(check.passed)

    def test_comment_language_rules(self):
        content = '\n'.join([
            '#!/usr/bin/env python3',
            '# -*- coding: utf-8 -*-',
            '# type: ignore',
            '# ---- 分节 ----',
            '# 中文说明',
            'x = "http://example.com/#anchor"  # 引号内的井号不算注释',
            '# TODO: fix this later',
        ])
        self.write('a.py', content + '\n')
        check = text_metrics.check_comment_language(scan(self.root))
        self.assertEqual(check.value, 1)  # 仅英文 TODO 违规
        self.assertIn('TODO', check.items[0])

    def test_comment_language_c_style(self):
        content = 'const u = "https://x";\n// english note\n/* 中文块开始\n * 中文块\n */\n'
        self.write('a.ts', content)
        check = text_metrics.check_comment_language(scan(self.root))
        self.assertEqual(check.value, 1)  # 仅 // english note 违规
        self.assertIn('english note', check.items[0])

    def test_overlong_comment_run(self):
        run10 = '\n'.join(f'# 第 {i} 行说明' for i in range(10))
        run12 = '\n'.join(f'# 备注 {i}' for i in range(12))
        self.write('ok.py', f'{run10}\nx = 1\n')
        self.write('bad.py', f'{run12}\ny = 2\n')
        check = text_metrics.check_comment_run(scan(self.root), Config())
        self.assertEqual(check.value, 1)
        self.assertIn('bad.py', check.items[0])

    def test_comment_run_doc_annotation_exempt(self):
        # 文档注解块不受 10 行限制：swag 风格 @ 标签块、Javadoc /** */ 块均豁免
        swag = '\n'.join(['// 创建订单', '// @Summary 创建订单', '// @Router /orders [post]']
                        + [f'// @Param p{i} 参数 {i}' for i in range(12)])
        javadoc = '\n'.join(['/**'] + [f' * 说明 {i}' for i in range(15)] + [' */'])
        self.write('swag.go', f'{swag}\nfunc A() {{}}\n')
        self.write('doc.java', f'{javadoc}\nvoid B() {{}}\n')
        check = text_metrics.check_comment_run(scan(self.root), Config())
        self.assertTrue(check.passed)

    def test_domain_io(self):
        self.write('core/logic.py', 'def run():\n    print("结果")\n')
        self.write('app.py', 'def main():\n    print("入口")\n')
        data = scan(self.root)
        skipped = text_metrics.check_domain_io(self.root, data, Config())
        self.assertTrue(skipped.skipped)
        cfg = Config(domain_dirs=('core',))
        check = text_metrics.check_domain_io(self.root, data, cfg)
        self.assertFalse(check.passed)
        self.assertEqual(check.value, 1)
        self.assertIn('core/logic.py', check.items[0])


class FunctionMetricsTest(TempDirTest):
    """函数级指标：行数、圈复杂度、嵌套、参数。"""

    def test_function_violations(self):
        body = '\n'.join(f'    v{i} = {i}' for i in range(85))
        branches = '\n'.join(f'    if v{i}:\n        v{i} += 1' for i in range(16))
        content = (
            'def too_long():\n'
            f'{body}\n'
            '\n'
            'def too_complex(v):\n'
            f'{branches}\n'
            '        return 1\n'
            '\n'
            'def too_deep(v):\n'
            '    if v:\n'
            '        for i in v:\n'
            '            if i:\n'
            '                for j in v:\n'
            '                    if j:\n'
            '                        return 1\n'
            '\n'
            'def too_many(a, b, c, d, e, f):\n'
            '    return a\n'
        )
        self.write('funcs.py', content)
        cfg = Config()
        checks = {c.cid: c for c in py_metrics.check_python_functions(scan(self.root), cfg)}
        self.assertEqual(checks['function-length'].value, 1)
        self.assertEqual(checks['function-complexity'].value, 1)
        self.assertEqual(checks['nesting-depth'].value, 1)
        self.assertEqual(checks['param-count'].value, 1)

    def test_method_self_not_counted(self):
        content = 'class A:\n    def m(self, a, b, c, d):\n        return a\n'
        self.write('a.py', content)
        checks = {c.cid: c for c in py_metrics.check_python_functions(scan(self.root), Config())}
        self.assertEqual(checks['param-count'].value, 0)


class ClassAndImportTest(TempDirTest):
    """类方法数、未使用 import、命名、循环依赖。"""

    def test_class_methods_over_limit(self):
        methods = '\n'.join(f'    def m{i}(self):\n        return {i}' for i in range(21))
        self.write('big.py', f'class Big:\n{methods}\n')
        check = py_metrics.check_class_methods(scan(self.root), Config())
        self.assertEqual(check.value, 1)

    def test_unused_import_rules(self):
        content = (
            'import os\n'
            'import json as j\n'
            'from pathlib import Path\n'
            'def f(p):\n'
            '    return Path(p) and j.dumps({})\n'
        )
        (self.root / 'pkg').mkdir()
        (self.root / 'pkg' / '__init__.py').write_text('import os\n', encoding='utf-8')
        (self.root / 'pkg' / 'mod.py').write_text(content, encoding='utf-8')
        check = py_metrics.check_unused_imports(scan(self.root))
        # mod.py 中 os 未使用；__init__.py 的再导出豁免
        self.assertEqual(check.value, 1)
        self.assertIn('mod.py', check.items[0])
        self.assertIn('os', check.items[0])

    def test_all_export_counts_as_used(self):
        content = 'import os\n__all__ = ["os"]\n'
        self.write('a.py', content)
        check = py_metrics.check_unused_imports(scan(self.root))
        self.assertEqual(check.value, 0)

    def test_naming_violations(self):
        content = 'def getUser():\n    return 1\n\nclass config:\n    pass\n'
        self.write('a.py', content)
        check = py_metrics.check_naming(scan(self.root))
        self.assertEqual(check.value, 2)

    def test_import_cycle_detected(self):
        self.write('a.py', 'import b\n')
        self.write('b.py', 'import a\n')
        check = py_metrics.check_cycles(self.root, scan(self.root))
        self.assertEqual(check.value, 1)
        self.assertIn('↔', check.items[0])

    def test_no_cycle_in_layered_graph(self):
        self.write('low.py', 'VALUE = 1\n')
        self.write('high.py', 'import low\n\nprint(low.VALUE)\n')
        check = py_metrics.check_cycles(self.root, scan(self.root))
        self.assertEqual(check.value, 0)


class SelfScanTest(unittest.TestCase):
    """技能自带脚本必须通过自身全部指标（自举约束）。"""

    def test_skill_scripts_pass_own_metrics(self):
        rc, out = run_main([str(SKILL_SCRIPTS)])
        self.assertEqual(rc, 0, f'技能脚本未通过自身检测:\n{out}')


if __name__ == '__main__':
    unittest.main()
