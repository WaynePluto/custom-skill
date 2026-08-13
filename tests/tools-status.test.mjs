/**
 * tools-status 扩展的静态测试。
 *
 * 运行：node --experimental-strip-types --test tests/tools-status.test.mjs
 *
 * 不启动真实 pi 会话：统计逻辑是纯函数，直接喂手写条目 fixture；
 * 命令部分用最小假 ExtensionAPI + 假 ctx 验证输出通道（统一走 notify）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import registerToolsStatus, {
	collectStats,
	formatReportLines,
	formatToolLines,
	formatToolSummary,
	sortedToolNames,
} from "../extensions/tools-status.ts";

// ── fixture 构造器：贴合 docs/session-format.md 的条目结构 ──

const message = (msg) => ({ type: "message", id: Math.random().toString(36).slice(2), message: msg });
const user = (text) => message({ role: "user", content: text });
const assistant = (...content) => message({ role: "assistant", content });
const toolResult = (toolName, isError = false) =>
	message({ role: "toolResult", toolCallId: "c1", toolName, content: [], isError });
const bashExecution = (command) => message({ role: "bashExecution", command, output: "" });
const thinking = (text) => ({ type: "thinking", thinking: text });
const toolCall = (name) => ({ type: "toolCall", id: "c1", name, arguments: {} });
const text = (value) => ({ type: "text", text: value });

test("按工具聚合调用 / 完成 / 出错次数", () => {
	const stats = collectStats([
		user("go"),
		assistant(toolCall("bash"), toolCall("bash"), toolCall("read")),
		toolResult("bash", true),
		toolResult("bash"),
		toolResult("read"),
	]);

	assert.equal(stats.toolCalls, 3);
	assert.equal(stats.toolResults, 3);
	assert.equal(stats.toolErrors, 1);
	assert.deepEqual(stats.perTool.bash, { calls: 2, results: 2, errors: 1 });
	assert.deepEqual(stats.perTool.read, { calls: 1, results: 1, errors: 0 });
});

test("工具调用只数 assistant 的 toolCall 块，用户 bash 不计入", () => {
	const stats = collectStats([
		bashExecution("ls"),
		bashExecution("git status"),
		assistant(toolCall("read")),
		toolResult("read"),
	]);

	assert.equal(stats.toolCalls, 1);
	assert.equal(stats.userBash, 2);
	assert.equal(stats.perTool.bash, undefined, "用户 bash 不该出现在分工具统计里");
});

test("缺少 toolResult 时 pendingCalls > 0（Esc / 崩溃留下的未完成调用）", () => {
	const stats = collectStats([assistant(toolCall("bash"), toolCall("read")), toolResult("bash")]);

	assert.equal(stats.pendingCalls, 1);
	assert.deepEqual(stats.perTool.read, { calls: 1, results: 0, errors: 0 });
});

test("同一条 assistant 消息里的多个 thinking 块：段数按块、轮数按消息", () => {
	const stats = collectStats([
		assistant(thinking("a"), text("t"), thinking("bb")),
		assistant(thinking("ccc")),
		assistant(text("no thinking")),
	]);

	assert.equal(stats.thinkingBlocks, 3);
	assert.equal(stats.thinkingMessages, 2);
	assert.equal(stats.thinkingChars, 6);
	assert.equal(stats.assistantMessages, 3);
});

test("非 message 条目（compaction / model_change / custom）被忽略", () => {
	const stats = collectStats([
		{ type: "compaction", data: { tokensBefore: 100 } },
		{ type: "model_change", model: { id: "x" } },
		{ type: "custom", customType: "status-card", data: {} },
		{ type: "message" }, // 没有 message 字段
		assistant(toolCall("read")),
		toolResult("read"),
	]);

	assert.equal(stats.entries, 6);
	assert.equal(stats.toolCalls, 1);
	assert.equal(stats.toolResults, 1);
});

test("字符串 content 的 assistant 消息与缺名工具不会抛错", () => {
	const stats = collectStats([
		message({ role: "assistant", content: "plain string" }),
		message({ role: "assistant", content: [{ type: "toolCall" }] }),
		message({ role: "toolResult", isError: true }),
		message({ role: "branchSummary", summary: "x" }),
	]);

	assert.deepEqual(stats.perTool["(unknown)"], { calls: 1, results: 1, errors: 1 });
});

test("空会话不出 NaN，报告显示占位行", () => {
	const stats = collectStats([]);

	assert.match(formatToolSummary(stats), /工具调用 0 次 \/ 0 个工具 .* 出错 0（0\.0%）/);
	assert.ok(!formatToolSummary(stats).includes("NaN"));
	assert.ok(formatReportLines(stats).includes("（无工具调用）"));
});

test("工具行按调用次数降序、同次数按名称升序；出错与未完成为 0 时省略", () => {
	const stats = collectStats([
		assistant(toolCall("read"), toolCall("read"), toolCall("bash"), toolCall("write")),
		toolResult("read"),
		toolResult("read"),
		toolResult("bash", true),
	]);

	assert.deepEqual(sortedToolNames(stats), ["read", "bash", "write"]);
	assert.deepEqual(formatToolLines(stats), [
		"read: 调用 2 · 完成 2",
		"bash: 调用 1 · 完成 1 · 出错 1",
		"write: 调用 1 · 完成 0 · 未完成 1",
	]);
});

test("报告以工具数据开头，随后是思考、模型和口径说明", () => {
	const stats = collectStats([
		assistant(thinking("xx"), toolCall("bash")),
		toolResult("bash", true),
		bashExecution("ls"),
	]);
	const lines = formatReportLines(stats, { model: "anthropic/claude", thinkingLevel: "high" });

	assert.match(lines[0], /^工具调用 1 次 \/ 1 个工具/);
	assert.equal(lines[1], "bash: 调用 1 · 完成 1 · 出错 1");
	const joined = lines.join("\n");
	assert.match(joined, /思考 1 段 · 2 字符/);
	assert.match(joined, /用户 bash 1/);
	assert.match(joined, /模型 anthropic\/claude · 思考等级 high/);
	assert.match(joined, /仅统计当前分支/);
	assert.match(joined, /subagent 子会话独立计数/);
	assert.match(
		formatReportLines(stats).join("\n"),
		/模型 unknown · 思考等级 unknown/,
		"缺模型信息时应有占位",
	);
});

// ── 命令层 ──

function createFakeCtx({ branch = [] } = {}) {
	const notifications = [];
	return {
		notifications,
		ctx: {
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "medium",
			sessionManager: { getBranch: () => branch },
			ui: {
				notify: (msg, level) => notifications.push({ msg, level }),
				select: async () => {
					throw new Error("命令不应再使用 select：报告统一走 notify，以便 CLI 与 GUI 都留在对话流里");
				},
			},
		},
	};
}

function registerAndGetCommand() {
	let registered;
	registerToolsStatus({
		registerCommand(name, options) {
			registered = { name, options };
		},
	});
	assert.equal(registered.name, "tools-status", "命令名必须是 tools-status");
	assert.equal(typeof registered.options.handler, "function");
	assert.equal(
		registered.options.getArgumentCompletions,
		undefined,
		"命令无参数，不应注册参数补全",
	);
	return registered;
}

test("无参数直接输出整份报告，且只输出一次", async () => {
	const { options } = registerAndGetCommand();
	const fake = createFakeCtx({
		branch: [assistant(thinking("a"), toolCall("bash")), toolResult("bash")],
	});

	await options.handler("", fake.ctx);

	assert.equal(fake.notifications.length, 1);
	assert.equal(fake.notifications[0].level, "info");
	const [title, ...body] = fake.notifications[0].msg.split("\n");
	assert.match(title, /工具使用统计/, "首行是标题：GUI 拿它当折叠头");
	assert.match(body.join("\n"), /bash: 调用 1 · 完成 1/);
	assert.match(body.join("\n"), /模型 anthropic\/claude · 思考等级 medium/);
});

test("多余参数被忽略，不影响输出", async () => {
	const { options } = registerAndGetCommand();
	const fake = createFakeCtx({ branch: [assistant(toolCall("read")), toolResult("read")] });

	await options.handler("detail all json", fake.ctx);

	assert.equal(fake.notifications.length, 1);
	assert.match(fake.notifications[0].msg, /read: 调用 1 · 完成 1/);
});

test("空会话也输出完整报告，不因模式而降级", async () => {
	const { options } = registerAndGetCommand();
	const fake = createFakeCtx({ branch: [] });

	await options.handler("", fake.ctx);

	assert.equal(fake.notifications.length, 1);
	assert.match(fake.notifications[0].msg, /（无工具调用）/);
	assert.match(fake.notifications[0].msg, /仅统计当前分支/, "口径说明也在同一段文本里");
});
