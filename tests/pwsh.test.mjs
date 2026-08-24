/**
 * pwsh 扩展的静态测试。
 *
 * 运行：node --experimental-strip-types --test tests/pwsh.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	MIN_PWSH_MAJOR,
	diagnosePwsh,
	findPwshCandidates,
	parsePwshVersion,
	probePwshVersion,
} from "../extensions/pwsh/core.ts";

// ── 路径发现 ──

test("findPwshCandidates 优先从 PATH 发现并去重", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pwsh-"));
	try {
		const executable = path.join(root, process.platform === "win32" ? "pwsh.EXE" : "pwsh");
		fs.writeFileSync(executable, "");
		const candidates = findPwshCandidates({
			env: {
				PATH: `${root}${path.delimiter}${root}`,
				PATHEXT: ".EXE;.CMD",
			},
		});
		assert.deepEqual(candidates, [executable]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("findPwshCandidates 在 Windows PATH 缺失时检查 PowerShell 7 标准目录", () => {
	const expected = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
	assert.deepEqual(
		findPwshCandidates({
			platform: "win32",
			cwd: String.raw`C:\workspace`,
			env: { PATH: "", ProgramFiles: String.raw`C:\Program Files` },
			isFile: (candidate) => candidate === expected,
		}),
		[expected],
	);
});

test("findPwshCandidates 忽略同名目录，只接受文件", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pwsh-dir-"));
	try {
		fs.mkdirSync(path.join(root, process.platform === "win32" ? "pwsh.EXE" : "pwsh"));
		assert.deepEqual(findPwshCandidates({ env: { PATH: root, PATHEXT: ".EXE" } }), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ── 版本诊断 ──

test("parsePwshVersion 提取完整版本号", () => {
	assert.deepEqual(parsePwshVersion("PowerShell 7.6.4\r\n"), { text: "7.6.4", major: 7 });
	assert.deepEqual(parsePwshVersion("7.5.0-preview.1"), { text: "7.5.0", major: 7 });
	assert.equal(parsePwshVersion("not a version"), undefined);
});

test("diagnosePwsh 跳过坏候选并选择第一个 PowerShell 7", () => {
	const diagnostic = diagnosePwsh({
		findCandidates: () => ["broken.exe", "pwsh5.exe", "pwsh7.exe"],
		probeVersion: (executable) => {
			if (executable === "broken.exe") return { error: "cannot start" };
			if (executable === "pwsh5.exe") return { version: { text: "5.1.0", major: 5 } };
			return { version: { text: "7.6.4", major: 7 } };
		},
	});
	assert.deepEqual(diagnostic, {
		available: true,
		executable: "pwsh7.exe",
		version: { text: "7.6.4", major: 7 },
	});
});

test("diagnosePwsh 找不到候选时给安装指引", () => {
	const diagnostic = diagnosePwsh({ findCandidates: () => [] });
	assert.equal(diagnostic.available, false);
	assert.match(diagnostic.reason, /安装 PowerShell 7/);
});

test("diagnosePwsh 只发现旧版时拒绝注册", () => {
	const diagnostic = diagnosePwsh({
		findCandidates: () => ["pwsh.exe"],
		probeVersion: () => ({ version: { text: "6.2.0", major: 6 } }),
	});
	assert.equal(diagnostic.available, false);
	assert.match(diagnostic.reason, /版本 6\.2\.0/);
	assert.match(diagnostic.reason, /要求 >= 7/);
});

test("本机 PowerShell 诊断：Windows 上必须发现可执行的 pwsh >= 7", { skip: process.platform !== "win32" }, () => {
	const diagnostic = diagnosePwsh();
	assert.equal(diagnostic.available, true, diagnostic.available ? undefined : diagnostic.reason);
	if (!diagnostic.available) return;
	assert.ok(diagnostic.version.major >= MIN_PWSH_MAJOR);
	assert.ok(fs.statSync(diagnostic.executable).isFile());
	assert.deepEqual(probePwshVersion(diagnostic.executable), { version: diagnostic.version });
});

// ── Pi 接线约束 ──

test("入口注册 pwsh，但绝不调用 setActiveTools 或覆盖 bash", () => {
	const source = fs.readFileSync(new URL("../extensions/pwsh/pwsh.ts", import.meta.url), "utf8");
	assert.match(source, /name:\s*"pwsh"/);
	assert.doesNotMatch(source, /\bpi\.setActiveTools\s*\(/);
	assert.doesNotMatch(source, /name:\s*"bash"/);
});

test("执行 cwd 取自 ctx.cwd，不在加载时固化 process.cwd()", () => {
	// 工厂（createPowerShellToolDefinition）的第一个参数在扩展加载时被闭包固化。process.cwd()
	// 只在 CLI 宿主碰巧等于项目目录；在嵌入宿主（如 pi-agent-chat 的 VS Code 扩展进程）里它
	// 指向宿主安装目录，每条命令都会落在项目外。execute 必须按次用 ctx.cwd 重建定义。
	const source = fs.readFileSync(new URL("../extensions/pwsh/pwsh.ts", import.meta.url), "utf8");
	assert.match(source, /createPowerShellToolDefinition\(ctx\.cwd\)/);
});

test("基于内置 powershell 工具构建，不再经内置 bash 工具传 shellPath", () => {
	// bash 工具对自定义 shellPath 统一用 `-c` 启动：不带 -NoProfile，用户 profile 每条命令
	// 都会加载（报错进结果、拖慢执行）。内置 powershell 工具的参数集
	// （-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command）与 UTF-8 输出前缀
	// 修复了这两点，禁止退回 createBashToolDefinition + shellPath 的旧接线。
	const source = fs.readFileSync(new URL("../extensions/pwsh/pwsh.ts", import.meta.url), "utf8");
	assert.match(source, /createPowerShellToolDefinition\(process\.cwd\(\)\)/);
	assert.doesNotMatch(source, /createBashToolDefinition/);
});

test("目录 package.json 只声明 pwsh.ts 为扩展入口", () => {
	const packageJson = JSON.parse(
		fs.readFileSync(new URL("../extensions/pwsh/package.json", import.meta.url), "utf8"),
	);
	assert.deepEqual(packageJson.pi.extensions, ["./pwsh.ts"]);
});
