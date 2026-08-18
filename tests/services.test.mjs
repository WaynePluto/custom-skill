/**
 * services 扩展的静态测试。
 *
 * 运行：node --experimental-strip-types --test tests/services.test.mjs
 *
 * 只测 core.ts：注册表对账、pid 身份判定、就绪探测的分支、日志截取与格式化。
 * 不启动真实服务进程——启动路径依赖操作系统调度，做成断言只会得到不稳定的测试；
 * 这里保证的是「给定进程状态，扩展做出的决定是对的」，其中最关键的是
 * identify() 绝不能把被复用的 pid 判成我们的服务（判错就会杀掉无关进程树）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	START_TIME_TOLERANCE_MS,
	LAZY_TOOL_NAMES,
	formatServiceLines,
	formatServiceReport,
	formatStatus,
	formatUptime,
	identify,
	isValidName,
	lazyToolsFor,
	listLogNames,
	matchesReadyLog,
	parseCommandArgs,
	planToolLoad,
	planToolReset,
	reconcile,
	findExecutable,
	shellDialectWarning,
	shellInvocation,
	tailText,
	waitForReady,
} from "../extensions/services/core.ts";

// ── fixture ──

const service = (overrides = {}) => ({
	name: "dev",
	command: "pnpm dev",
	cwd: "/workspace",
	pid: 1234,
	startedAt: 1_000_000,
	logFile: "/workspace/.pi/logs/dev.log",
	...overrides,
});

// ── 名字校验 ──

test("isValidName 挡掉路径穿越和空名", () => {
	assert.equal(isValidName("dev"), true);
	assert.equal(isValidName("api-2.local_1"), true);
	assert.equal(isValidName(""), false);
	assert.equal(isValidName("../etc/passwd"), false);
	assert.equal(isValidName("a/b"), false);
	assert.equal(isValidName("a b"), false);
	assert.equal(isValidName("x".repeat(65)), false);
});

// ── pid 身份判定 ──

test("identify: 进程不在时判为 gone", () => {
	const result = identify(service(), { alive: () => false, startedAt: () => undefined });
	assert.equal(result, "gone");
});

test("identify: 创建时间对得上判为 ours", () => {
	const record = service();
	const result = identify(record, { alive: () => true, startedAt: () => record.startedAt + 500 });
	assert.equal(result, "ours");
});

test("identify: 创建时间差超过容差判为 recycled，绝不能当成 ours", () => {
	const record = service();
	const result = identify(record, {
		alive: () => true,
		startedAt: () => record.startedAt + START_TIME_TOLERANCE_MS + 1,
	});
	assert.equal(result, "recycled");
});

test("identify: 读不到创建时间判为 unknown，而不是乐观地判为 ours", () => {
	const result = identify(service(), { alive: () => true, startedAt: () => undefined });
	assert.equal(result, "unknown");
});

// ── 注册表对账 ──

test("reconcile 保留 ours 与 unknown，丢弃 gone 与 recycled", () => {
	const records = [
		service({ name: "a", pid: 1 }),
		service({ name: "b", pid: 2 }),
		service({ name: "c", pid: 3 }),
		service({ name: "d", pid: 4 }),
	];
	const identities = { a: "ours", b: "gone", c: "recycled", d: "unknown" };
	const { live, dropped } = reconcile(records, (record) => identities[record.name]);

	assert.deepEqual(
		live.map((record) => record.name),
		["a", "d"],
	);
	assert.deepEqual(
		dropped.map((entry) => [entry.record.name, entry.reason]),
		[
			["b", "gone"],
			["c", "recycled"],
		],
	);
});

test("reconcile 对空注册表是安全的", () => {
	const { live, dropped } = reconcile([], () => "ours");
	assert.deepEqual(live, []);
	assert.deepEqual(dropped, []);
});

// ── 就绪探测 ──

test("waitForReady: 进程中途退出立即返回 exited，不干等超时", async () => {
	let calls = 0;
	const outcome = await waitForReady(
		service(),
		{ readyLog: "ready", timeoutMs: 10_000 },
		{
			alive: () => {
				calls += 1;
				return false;
			},
		},
	);
	assert.equal(outcome, "exited");
	assert.equal(calls, 1);
});

test("waitForReady: 没有探测条件时，等满时间且进程还活着即视为 ready", async () => {
	let now = 0;
	const outcome = await waitForReady(
		service(),
		{ timeoutMs: 1 },
		{ alive: () => true, now: () => (now += 1) },
	);
	assert.equal(outcome, "ready");
});

test("waitForReady: 有探测条件但始终不满足时返回 timeout", async () => {
	let now = 0;
	const outcome = await waitForReady(
		service({ logFile: "/nonexistent/never.log" }),
		{ readyLog: "listening", timeoutMs: 1 },
		{ alive: () => true, now: () => (now += 1) },
	);
	assert.equal(outcome, "timeout");
});

test("matchesReadyLog 支持正则并忽略大小写", () => {
	assert.equal(matchesReadyLog("Local:  http://localhost:5173", "listening|local:"), true);
	assert.equal(matchesReadyLog("starting...", "listening"), false);
});

test("matchesReadyLog 遇到非法正则退化为子串匹配而不是抛错", () => {
	assert.equal(matchesReadyLog("build [ok] done", "[ok"), true);
	assert.equal(matchesReadyLog("build failed", "[ok"), false);
});

// ── 日志截取 ──

test("tailText 取末尾若干行并吃掉结尾空行", () => {
	assert.equal(tailText("a\nb\nc\n", 2), "b\nc");
	assert.equal(tailText("a\nb\nc", 10), "a\nb\nc");
	assert.equal(tailText("", 5), "");
	assert.equal(tailText("a\nb", 0), "");
});

test("tailText 兼容 CRLF", () => {
	assert.equal(tailText("a\r\nb\r\nc\r\n", 2), "b\nc");
});

// ── 展示 ──

test("formatUptime 按量级切换单位", () => {
	assert.equal(formatUptime(0), "0s");
	assert.equal(formatUptime(45_000), "45s");
	assert.equal(formatUptime(90_000), "1m");
	assert.equal(formatUptime(3_600_000 + 120_000), "1h2m");
	assert.equal(formatUptime(26 * 3_600_000), "1d2h");
});

test("formatServiceLines 每个服务一行，端口可选", () => {
	const now = 2_000_000;
	const lines = formatServiceLines([service({ port: 5173 }), service({ name: "api", pid: 9, startedAt: now })], now);
	assert.deepEqual(lines, ["dev  :5173  pid 1234  16m", "api  pid 9  0s"]);
});

test("formatStatus 在没有服务时返回 undefined，以便调用方清除状态行", () => {
	assert.equal(formatStatus([]), undefined);
	assert.equal(formatStatus([service()]), "▶ 1 service");
	assert.equal(formatStatus([service(), service({ name: "api" })]), "▶ 2 services");
});

test("formatServiceReport 空列表给出明确结论而不是空字符串", () => {
	assert.equal(formatServiceReport([]), "没有正在运行的服务");
});

test("formatServiceReport 没有活服务时列出可读的历史日志名", () => {
	assert.equal(formatServiceReport([], 1_000_000, ["api", "dev"]), "没有正在运行的服务\n已停止但日志可读：api、dev");
});

test("formatServiceReport 含命令与日志路径，并只单列已停止服务的日志", () => {
	const now = 1_000_000;
	const report = formatServiceReport([service({ port: 5173 })], now, ["api", "dev"]);
	assert.match(report, /运行中 1 个服务/);
	assert.match(report, /dev {2}:5173 {2}pid 1234 {2}0s {2}pnpm dev/);
	assert.match(report, /日志 \/workspace\/\.pi\/logs\/dev\.log/);
	assert.match(report, /已停止但日志可读：api/);
	assert.doesNotMatch(report, /已停止但日志可读：.*dev/);
});

test("listLogNames 扫描、去后缀、排序，并忽略非日志与非法空名", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-services-"));
	try {
		const logs = path.join(cwd, ".pi", "logs");
		fs.mkdirSync(logs, { recursive: true });
		for (const file of ["dev.log", "api.log", "notes.txt", ".log"]) fs.writeFileSync(path.join(logs, file), "");
		fs.mkdirSync(path.join(logs, "not-a-file.log"));
		assert.deepEqual(listLogNames(cwd), ["api", "dev"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("listLogNames 在日志目录不存在时返回空列表", () => {
	assert.deepEqual(listLogNames(path.join(os.tmpdir(), `pi-services-missing-${Date.now()}`)), []);
});

// ── 启动方式 ──

/**
 * shellInvocation 的形状直接决定服务能不能起来，而且三条 Windows 结论都是实测踩出来的
 * （node 的 shell 选项与 detached 不兼容、pwsh 在无 console 的 detached 进程里跑不起来、
 * cmd.exe 在 detached 下不转发子进程 stdio）。这里锁住结论，避免以后被「简化」回去。
 */
test("shellInvocation: Windows 走 node 启动器中转，而不是直接交给 shell", { skip: process.platform !== "win32" }, () => {
	const invocation = shellInvocation("pnpm dev");
	assert.equal(invocation.file, process.execPath);
	assert.equal(invocation.args[0], "-e");
	assert.match(invocation.args[1], /require\("child_process"\)/);
	// 命令原样作为 argv 传给启动器，不做任何拼接或转义
	assert.equal(invocation.args[2], "pnpm dev");
});

/**
 * 默认 shell 必须跟 pi 的 bash 工具一致（Windows 上是 pwsh）。两边不一致的话，模型得记住
 * 「这个工具用 pwsh 语法、那个用 cmd 语法」，是纯粹的人为负担。
 */
test("shellInvocation: Windows 默认落到 pwsh（找不到才退回 cmd）", { skip: process.platform !== "win32" }, () => {
	const invocation = shellInvocation("pnpm dev");
	const pwsh = findExecutable("pwsh");
	if (pwsh) {
		assert.match(invocation.shell, /pwsh(\.exe)?$/i);
		assert.equal(invocation.args[3], invocation.shell);
		assert.equal(shellDialectWarning(invocation.shell), undefined);
	} else {
		assert.match(invocation.shell, /cmd(\.exe)?$/i);
		// 启动器收到空串时回退到 Node 的 shell: true
		assert.equal(invocation.args[3], "");
		assert.match(String(shellDialectWarning(invocation.shell)), /pwsh/);
	}
});

test("shellInvocation: 显式 shell 覆盖默认", { skip: process.platform !== "win32" }, () => {
	const invocation = shellInvocation("pnpm dev", "bash");
	assert.equal(invocation.args[3], "bash");
	assert.equal(invocation.shell, "bash");
});

test("shellInvocation: POSIX 保持原生 sh -c，不多一层进程", { skip: process.platform === "win32" }, () => {
	assert.deepEqual(shellInvocation("pnpm dev"), { file: "/bin/sh", args: ["-c", "pnpm dev"], shell: "/bin/sh" });
	assert.deepEqual(shellInvocation("pnpm dev", "/bin/zsh"), {
		file: "/bin/zsh",
		args: ["-c", "pnpm dev"],
		shell: "/bin/zsh",
	});
});

test("shellDialectWarning 只在 Windows 且不是 pwsh 时报警", () => {
	// pwsh 无论平台都不报警；非 Windows 上根本不存在方言问题。
	assert.equal(shellDialectWarning("C:\\Program Files\\PowerShell\\7\\pwsh.EXE"), undefined);
	if (process.platform === "win32") {
		assert.match(String(shellDialectWarning("C:\\Windows\\system32\\cmd.exe")), /cmd\.exe/);
	} else {
		assert.equal(shellDialectWarning("/bin/sh"), undefined);
	}
});

// ── 工具按需加载 ──

/** 已注册工具名：内置工具 + 本扩展的五个 */
const REGISTERED = ["read", "bash", "service_start", "service_list", ...LAZY_TOOL_NAMES];

const ENTRY_TOOLS = ["read", "bash", "service_start", "service_list"];

test("service_start 与 service_list 常驻，只有三个带参数的管理工具懒加载", () => {
	assert.equal(LAZY_TOOL_NAMES.includes("service_start"), false);
	assert.equal(LAZY_TOOL_NAMES.includes("service_list"), false);
	assert.deepEqual([...LAZY_TOOL_NAMES], ["service_logs", "service_stop", "service_restart"]);
});

test("lazyToolsFor 有活服务放三个，只有历史日志只放 service_logs", () => {
	assert.deepEqual(lazyToolsFor({ live: true, logs: false }), [...LAZY_TOOL_NAMES]);
	assert.deepEqual(lazyToolsFor({ live: true, logs: true }), [...LAZY_TOOL_NAMES]);
	assert.deepEqual(lazyToolsFor({ live: false, logs: true }), ["service_logs"]);
	assert.deepEqual(lazyToolsFor({ live: false, logs: false }), []);
});

test("planToolLoad 只追加，不动常驻工具与现有顺序", () => {
	const next = planToolLoad(ENTRY_TOOLS, REGISTERED, LAZY_TOOL_NAMES);
	// 前缀保持原样是关键：只有纯增量的变化才会走 deferred loading。
	assert.deepEqual(next, [...ENTRY_TOOLS, ...LAZY_TOOL_NAMES]);
});

test("planToolLoad 只追加已注册的名字", () => {
	assert.deepEqual(planToolLoad(ENTRY_TOOLS, [...ENTRY_TOOLS, "service_logs"], LAZY_TOOL_NAMES), [
		...ENTRY_TOOLS,
		"service_logs",
	]);
});

test("planToolLoad 不重复追加，并在无变化时返回 undefined", () => {
	assert.deepEqual(planToolLoad([...ENTRY_TOOLS, "service_logs"], REGISTERED, LAZY_TOOL_NAMES), [
		...ENTRY_TOOLS,
		"service_logs",
		"service_stop",
		"service_restart",
	]);
	assert.equal(planToolLoad([...ENTRY_TOOLS, ...LAZY_TOOL_NAMES], REGISTERED, LAZY_TOOL_NAMES), undefined);
});

test("planToolReset 收回懒加载工具，但始终保留 service_start / service_list 与其它扩展工具", () => {
	const active = ["read", "service_logs", "service_list", "other_tool", "service_stop", "service_start"];
	assert.deepEqual(planToolReset(active, [...REGISTERED, "other_tool"], []), [
		"read",
		"service_list",
		"other_tool",
		"service_start",
	]);
});

test("planToolReset 可按实况保留部分工具，无需变化时返回 undefined", () => {
	assert.deepEqual(planToolReset([...ENTRY_TOOLS, ...LAZY_TOOL_NAMES], REGISTERED, ["service_logs"]), [
		...ENTRY_TOOLS,
		"service_logs",
	]);
	assert.equal(planToolReset(ENTRY_TOOLS, REGISTERED, []), undefined);
});

// ── 命令参数 ──

test("parseCommandArgs 无参数视为 list", () => {
	assert.deepEqual(parseCommandArgs(""), { action: "list" });
	assert.deepEqual(parseCommandArgs("   "), { action: "list" });
});

test("parseCommandArgs 解析动作与名字并归一化大小写", () => {
	assert.deepEqual(parseCommandArgs("STOP dev"), { action: "stop", name: "dev" });
	assert.deepEqual(parseCommandArgs("  restart   api  "), { action: "restart", name: "api" });
	assert.deepEqual(parseCommandArgs("logs"), { action: "logs" });
});
