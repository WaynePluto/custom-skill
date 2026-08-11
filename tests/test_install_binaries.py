#!/usr/bin/env python3
"""install.py 二进制管理逻辑的静态测试（不联网）。

运行：python -m unittest discover -s tests -p 'test_*.py'
"""

import io
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import install  # noqa: E402


class AssetNameTest(unittest.TestCase):
    """资产名必须与 SDK utils/tools-manager.ts 完全一致，否则下载链接 404。"""

    def test_rg_assets(self):
        asset = install.BINARY_TOOLS["rg"]["asset"]
        self.assertEqual(asset("14.1.1", "win32", "x86_64"), "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip")
        self.assertEqual(asset("14.1.1", "darwin", "aarch64"), "ripgrep-14.1.1-aarch64-apple-darwin.tar.gz")
        # linux x86_64 用 musl，arm64 用 gnu
        self.assertEqual(asset("14.1.1", "linux", "x86_64"), "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz")
        self.assertEqual(asset("14.1.1", "linux", "aarch64"), "ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz")
        self.assertIsNone(asset("14.1.1", "sunos", "x86_64"))

    def test_fd_assets(self):
        asset = install.BINARY_TOOLS["fd"]["asset"]
        self.assertEqual(asset("10.2.0", "win32", "x86_64"), "fd-v10.2.0-x86_64-pc-windows-msvc.zip")
        self.assertEqual(asset("10.2.0", "linux", "aarch64"), "fd-v10.2.0-aarch64-unknown-linux-gnu.tar.gz")
        self.assertEqual(asset("10.2.0", "darwin", "x86_64"), "fd-v10.2.0-x86_64-apple-darwin.tar.gz")

    def test_tag_prefix(self):
        # rg 的 release tag 无 v 前缀，fd 有；拼错会导致 404
        self.assertEqual(install.BINARY_TOOLS["rg"]["tag_prefix"], "")
        self.assertEqual(install.BINARY_TOOLS["fd"]["tag_prefix"], "v")


class HostDetectionTest(unittest.TestCase):
    def test_machine_normalization(self):
        for raw, expected in [
            ("AMD64", "x86_64"), ("x86_64", "x86_64"), ("arm64", "aarch64"),
            ("aarch64", "aarch64"), ("armv7l", None),
        ]:
            with mock.patch("platform.machine", return_value=raw):
                self.assertEqual(install.host_machine(), expected, raw)

    def test_platform_normalization(self):
        for raw, expected in [
            ("win32", "win32"), ("darwin", "darwin"), ("linux", "linux"), ("aix", None),
        ]:
            with mock.patch.object(install.sys, "platform", raw):
                self.assertEqual(install.host_platform(), expected, raw)

    def test_offline_mode(self):
        for value, expected in [
            (None, False), ("", False), ("0", False), ("1", True),
            ("true", True), ("YES", True), ("no", False),
        ]:
            env = {} if value is None else {"PI_OFFLINE": value}
            with mock.patch.dict(install.os.environ, env, clear=True):
                self.assertIs(install.offline_mode(), expected, value)


class VersionCompareTest(unittest.TestCase):
    def test_is_outdated(self):
        self.assertTrue(install.is_outdated("14.1.0", "14.1.1"))
        self.assertTrue(install.is_outdated("9.0.0", "10.0.0"))
        self.assertFalse(install.is_outdated("14.1.1", "14.1.1"))
        self.assertFalse(install.is_outdated("14.2.0", "14.1.1"))
        # 位数不同也要能比较
        self.assertTrue(install.is_outdated("14.1", "14.1.1"))

    def test_non_numeric_versions_fall_back_to_inequality(self):
        self.assertTrue(install.is_outdated("14.1.1-beta", "14.1.1"))
        self.assertFalse(install.is_outdated("nightly", "nightly"))


class ArchiveTest(unittest.TestCase):
    """解压走标准库，不依赖外部 tar/unzip；二进制可能嵌在版本子目录里。"""

    def test_zip_with_nested_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            archive = tmp_dir / "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("ripgrep-14.1.1-x86_64-pc-windows-msvc/rg.exe", "binary")
                zf.writestr("ripgrep-14.1.1-x86_64-pc-windows-msvc/doc/rg.1", "man")

            dest = tmp_dir / "out"
            dest.mkdir()
            install.extract_archive(archive, dest)
            found = install.find_binary(dest, "rg.exe")
            self.assertIsNotNone(found)
            self.assertEqual(found.read_text(), "binary")

    def test_targz_with_nested_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            archive = tmp_dir / "fd-v10.2.0-x86_64-unknown-linux-gnu.tar.gz"
            payload = b"binary"
            with tarfile.open(archive, "w:gz") as tf:
                info = tarfile.TarInfo("fd-v10.2.0-x86_64-unknown-linux-gnu/fd")
                info.size = len(payload)
                tf.addfile(info, io.BytesIO(payload))

            dest = tmp_dir / "out"
            dest.mkdir()
            install.extract_archive(archive, dest)
            found = install.find_binary(dest, "fd")
            self.assertIsNotNone(found)
            self.assertEqual(found.read_bytes(), payload)

    def test_unsupported_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "rg.7z"
            archive.write_bytes(b"")
            with self.assertRaises(RuntimeError):
                install.extract_archive(archive, Path(tmp))


class BinaryVersionTest(unittest.TestCase):
    def test_parses_version_from_output(self):
        completed = mock.Mock(returncode=0, stdout="ripgrep 14.1.1 (rev e50df40a19)\n")
        with mock.patch("subprocess.run", return_value=completed):
            self.assertEqual(install.binary_version("rg"), "14.1.1")

    def test_returns_none_on_failure(self):
        completed = mock.Mock(returncode=1, stdout="")
        with mock.patch("subprocess.run", return_value=completed):
            self.assertIsNone(install.binary_version("rg"))
        with mock.patch("subprocess.run", side_effect=OSError("not found")):
            self.assertIsNone(install.binary_version("rg"))


class UpgradeFlowTest(unittest.TestCase):
    """已安装时的升级分支：升级必须交互确认，失败不中断。"""

    def _run(self, current, latest, answer=False, offline=False):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "rg.exe"
            local.write_text("old")
            env = {"PI_OFFLINE": "1"} if offline else {}
            with (
                mock.patch.object(install, "binary_version", return_value=current),
                mock.patch.object(install, "latest_release_version", return_value=latest) as latest_mock,
                mock.patch.object(install, "prompt_yes_no", return_value=answer) as prompt_mock,
                mock.patch.object(install, "download_binary", return_value=local) as download_mock,
                mock.patch.dict(install.os.environ, env, clear=True),
                mock.patch("sys.stdout", new_callable=io.StringIO),
            ):
                install.check_and_upgrade("rg", local)
                return latest_mock, prompt_mock, download_mock

    def test_up_to_date_does_not_prompt_or_download(self):
        _, prompt, download = self._run("14.1.1", "14.1.1")
        prompt.assert_not_called()
        download.assert_not_called()

    def test_outdated_asks_and_respects_no(self):
        _, prompt, download = self._run("14.1.0", "14.1.1", answer=False)
        prompt.assert_called_once()
        download.assert_not_called()

    def test_outdated_downloads_only_on_yes(self):
        _, prompt, download = self._run("14.1.0", "14.1.1", answer=True)
        prompt.assert_called_once()
        download.assert_called_once()

    def test_offline_skips_network(self):
        latest, prompt, download = self._run("14.1.0", "14.1.1", answer=True, offline=True)
        latest.assert_not_called()
        prompt.assert_not_called()
        download.assert_not_called()

    def test_network_failure_keeps_existing(self):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "rg.exe"
            local.write_text("old")
            with (
                mock.patch.object(install, "binary_version", return_value="14.1.0"),
                mock.patch.object(install, "latest_release_version", side_effect=OSError("timeout")),
                mock.patch.object(install, "download_binary") as download,
                mock.patch.dict(install.os.environ, {}, clear=True),
                mock.patch("sys.stdout", new_callable=io.StringIO),
            ):
                install.check_and_upgrade("rg", local)
                download.assert_not_called()
            self.assertEqual(local.read_text(), "old")

    def test_upgrade_download_failure_does_not_abort(self):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "rg.exe"
            local.write_text("old")
            with (
                mock.patch.object(install, "binary_version", return_value="14.1.0"),
                mock.patch.object(install, "latest_release_version", return_value="15.2.0"),
                mock.patch.object(install, "prompt_yes_no", return_value=True),
                mock.patch.object(install, "download_binary", side_effect=install.BinaryDownloadError("TLS")),
                mock.patch.dict(install.os.environ, {}, clear=True),
                mock.patch("sys.stdout", new_callable=io.StringIO),
            ):
                install.check_and_upgrade("rg", local)  # 不应抛 SystemExit
            self.assertEqual(local.read_text(), "old")


class MissingBinaryTest(unittest.TestCase):
    """缺失且下载失败时必须中断安装，并给出手动安装指引。"""

    def test_download_failure_aborts_with_instructions(self):
        with tempfile.TemporaryDirectory() as tmp:
            pi_agent_dir = Path(tmp)
            error = install.BinaryDownloadError(
                "TLS", url="https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/x.zip"
            )
            buffer = io.StringIO()
            with (
                mock.patch.object(install, "system_binary", return_value=None),
                mock.patch.object(install, "download_binary", side_effect=error),
                mock.patch.dict(install.os.environ, {}, clear=True),
                mock.patch("sys.stdout", new=buffer),
                self.assertRaises(SystemExit) as ctx,
            ):
                install.deploy_binaries(pi_agent_dir)

            message = str(ctx.exception)
            self.assertIn("安装已中断", message)
            self.assertIn(error.url, message)
            self.assertIn(str(pi_agent_dir / "bin" / ("rg.exe" if sys.platform == "win32" else "rg")), message)

    def test_offline_missing_binary_warns_without_abort(self):
        with tempfile.TemporaryDirectory() as tmp:
            buffer = io.StringIO()
            with (
                mock.patch.object(install, "system_binary", return_value=None),
                mock.patch.object(install, "download_binary") as download,
                mock.patch.dict(install.os.environ, {"PI_OFFLINE": "1"}, clear=True),
                mock.patch("sys.stdout", new=buffer),
            ):
                install.deploy_binaries(Path(tmp))  # 不应抛 SystemExit
                download.assert_not_called()
            self.assertIn("PI_OFFLINE", buffer.getvalue())


class SystemBinaryTest(unittest.TestCase):
    def test_ignores_hits_inside_pi_bin_dir(self):
        """pi 会把自己的 bin 目录注入子 shell 的 PATH，不能当成系统二进制。"""
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            hit = bin_dir / "rg.exe"
            hit.write_text("")
            with mock.patch("shutil.which", return_value=str(hit)):
                self.assertIsNone(install.system_binary("rg", bin_dir))

    def test_reports_hits_outside_pi_bin_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            other = Path(tmp) / "system" / "rg.exe"
            other.parent.mkdir()
            other.write_text("")
            with mock.patch("shutil.which", return_value=str(other)):
                self.assertEqual(install.system_binary("rg", bin_dir), str(other))


class NonInteractivePromptTest(unittest.TestCase):
    def test_returns_false_without_tty(self):
        with mock.patch.object(install.sys, "stdin", mock.Mock(isatty=lambda: False)):
            self.assertFalse(install.prompt_yes_no("更新？"))


if __name__ == "__main__":
    unittest.main()
