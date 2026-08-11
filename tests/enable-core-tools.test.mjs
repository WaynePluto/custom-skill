/**
 * enable-core-tools 扩展的静态测试。
 *
 * 运行：node --experimental-strip-types --test tests/
 *
 * 不启动真实 pi 会话，用最小的假 ExtensionAPI 验证三条关键约束：
 * 激活集是合并而非替换、未注册的工具不会被激活、每个 session_start reason 都生效。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import enableCoreTools from "../extensions/enable-core-tools.ts";

const SDK_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** 构造一个只实现本扩展所需方法的假 ExtensionAPI */
function createFakePi({ active, allTools = SDK_TOOLS }) {
	const calls = [];
	const handlers = new Map();
	let current = [...active];

	return {
		calls,
		getCurrentTools: () => current,
		emit(event, payload = { reason: "startup" }) {
			const handler = handlers.get(event);
			assert.ok(handler, `未注册事件处理器：${event}`);
			return handler(payload, {});
		},
		api: {
			on(event, handler) {
				handlers.set(event, handler);
			},
			getActiveTools: () => [...current],
			getAllTools: () => allTools.map((name) => ({ name })),
			setActiveTools(names) {
				calls.push([...names]);
				current = [...names];
			},
		},
	};
}

test("session_start 时把 grep/find/ls 合并进激活集，不丢失原有工具", () => {
	const fake = createFakePi({ active: ["read", "bash", "edit", "write"] });
	enableCoreTools(fake.api);
	fake.emit("session_start");

	assert.equal(fake.calls.length, 1);
	assert.deepEqual(fake.calls[0], ["read", "bash", "edit", "write", "grep", "find", "ls"]);
});

test("其它扩展注册的工具（如 GUI 的 subagent）不会被挤掉", () => {
	const fake = createFakePi({
		active: ["read", "bash", "edit", "write", "subagent"],
		allTools: [...SDK_TOOLS, "subagent"],
	});
	enableCoreTools(fake.api);
	fake.emit("session_start");

	assert.ok(fake.getCurrentTools().includes("subagent"));
	assert.deepEqual(fake.getCurrentTools(), [
		"read",
		"bash",
		"edit",
		"write",
		"subagent",
		"grep",
		"find",
		"ls",
	]);
});

test("registry 里不存在的工具不会被激活", () => {
	// 模拟 SDK 升级后删掉 find 的情况
	const fake = createFakePi({
		active: ["read", "bash", "edit", "write"],
		allTools: ["read", "bash", "edit", "write", "grep", "ls"],
	});
	enableCoreTools(fake.api);
	fake.emit("session_start");

	assert.deepEqual(fake.getCurrentTools(), ["read", "bash", "edit", "write", "grep", "ls"]);
});

test("激活集已完整时不调用 setActiveTools", () => {
	const fake = createFakePi({ active: SDK_TOOLS });
	enableCoreTools(fake.api);
	fake.emit("session_start");

	assert.equal(fake.calls.length, 0);
});

test("startup/reload/new/resume/fork 每个 reason 都生效且结果幂等", () => {
	for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
		const fake = createFakePi({ active: ["read", "bash", "edit", "write"] });
		enableCoreTools(fake.api);
		fake.emit("session_start", { reason });
		fake.emit("session_start", { reason });

		assert.equal(fake.calls.length, 1, `reason=${reason} 应只需要一次 setActiveTools`);
		assert.deepEqual(fake.getCurrentTools(), SDK_TOOLS, `reason=${reason} 未激活全部工具`);
	}
});
