/**
 * 工具使用统计扩展：/tools-status
 *
 * 一条命令输出当前会话的工具调用情况（每个工具调用了多少次、完成多少、出错多少），
 * 附带思考段数等辅助指标。CLI 与 pi-agent-chat 共用同一份扩展目录。
 *
 * 数据来源是 ctx.sessionManager 的会话条目，不在内存里记账，因此 /resume、/reload、fork 之后
 * 统计依然准确。统计范围固定为当前分支（root→leaf），与用户在界面上看到的对话一致。
 *
 * 口径：
 * 1. 工具调用 = assistant 消息里 type === "toolCall" 的块数；工具结果 = role === "toolResult" 的消息数；
 *    出错 = isError === true 的结果数；未完成 = 调用数 - 结果数（Esc 中断、退出、崩溃）。
 * 2. 用户自己执行的 `!` 命令是 role === "bashExecution"，单独统计，不计入工具调用。
 * 3. 被扩展 tool_call 拦截（{ block: true }）的调用同样落盘为 isError，从会话文件无法与真实失败区分。
 * 4. subagent 子会话是独立的 JSONL 文件，不递归统计：父会话里 subagent 只算 1 次工具调用。
 * 5. 思考段数按 thinking 块计、思考轮数按含 thinking 块的 assistant 消息计。thinking 为 0 不代表
 *    模型没推理：非 reasoning 模型、thinkingLevel: off、加密返回 reasoning 的供应商都不产生 thinking 块，
 *    所以报告里附带当前模型与思考等级。
 *
 * 输出通道：一次 ctx.ui.notify(整份报告)，CLI 与 GUI 共用同一条路径，不做 mode 分支。
 * 两边都把报告留在对话流里而不是弹层：tui 的 notify(info) 走 showStatus()，向 chat 容器追加
 * 一段 dim 文本；pi-agent-chat 把扩展的 notify 接到 transcript notice card（首行作标题，多行折叠）。
 * 无 UI 的 json / print 模式下 notify 是 no-op，不额外降级（降级也同样看不见）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 最小结构化类型：只声明本扩展读取的字段，避免依赖 SDK 内部类型 ──

interface ContentBlock {
	type: string;
	thinking?: string;
	name?: string;
}

interface AnyMessage {
	role: string;
	content?: string | ContentBlock[];
	toolName?: string;
	isError?: boolean;
}

interface AnyEntry {
	type: string;
	message?: AnyMessage;
}

export interface ToolStat {
	calls: number;
	results: number;
	errors: number;
}

export interface SessionStats {
	entries: number;
	userMessages: number;
	assistantMessages: number;
	thinkingBlocks: number;
	thinkingMessages: number;
	thinkingChars: number;
	toolCalls: number;
	toolResults: number;
	toolErrors: number;
	pendingCalls: number;
	userBash: number;
	perTool: Record<string, ToolStat>;
}

const UNKNOWN_TOOL = "(unknown)";

function emptyToolStat(): ToolStat {
	return { calls: 0, results: 0, errors: 0 };
}

/** 纯函数：条目数组 → 统计结果。单测直接调用这个函数。 */
export function collectStats(entries: readonly AnyEntry[]): SessionStats {
	const stats: SessionStats = {
		entries: entries.length,
		userMessages: 0,
		assistantMessages: 0,
		thinkingBlocks: 0,
		thinkingMessages: 0,
		thinkingChars: 0,
		toolCalls: 0,
		toolResults: 0,
		toolErrors: 0,
		pendingCalls: 0,
		userBash: 0,
		perTool: {},
	};

	const bump = (name: string): ToolStat => (stats.perTool[name] ??= emptyToolStat());

	for (const entry of entries) {
		// compaction / model_change / custom 等非 message 条目一律忽略
		if (!entry || entry.type !== "message" || !entry.message) continue;
		const message = entry.message;

		if (message.role === "user") {
			stats.userMessages++;
			continue;
		}
		if (message.role === "bashExecution") {
			stats.userBash++;
			continue;
		}
		if (message.role === "toolResult") {
			stats.toolResults++;
			const tool = bump(message.toolName ?? UNKNOWN_TOOL);
			tool.results++;
			if (message.isError === true) {
				stats.toolErrors++;
				tool.errors++;
			}
			continue;
		}
		if (message.role !== "assistant") continue;

		stats.assistantMessages++;
		if (!Array.isArray(message.content)) continue;

		let thinkingInMessage = 0;
		for (const block of message.content) {
			if (!block) continue;
			if (block.type === "thinking") {
				thinkingInMessage++;
				stats.thinkingBlocks++;
				stats.thinkingChars += block.thinking?.length ?? 0;
			} else if (block.type === "toolCall") {
				stats.toolCalls++;
				bump(block.name ?? UNKNOWN_TOOL).calls++;
			}
		}
		if (thinkingInMessage > 0) stats.thinkingMessages++;
	}

	stats.pendingCalls = Math.max(0, stats.toolCalls - stats.toolResults);
	return stats;
}

/** 工具名排序：调用次数降序，同次数按名称升序（输出稳定，便于回归比对） */
export function sortedToolNames(stats: SessionStats): string[] {
	return Object.keys(stats.perTool).sort((a, b) => {
		const left = stats.perTool[a] ?? emptyToolStat();
		const right = stats.perTool[b] ?? emptyToolStat();
		return right.calls - left.calls || a.localeCompare(b);
	});
}

/** 每个工具一行；出错与未完成为 0 时省略，保持行短 */
export function formatToolLines(stats: SessionStats): string[] {
	return sortedToolNames(stats).map((name) => {
		const tool = stats.perTool[name] ?? emptyToolStat();
		const pending = Math.max(0, tool.calls - tool.results);
		return (
			`${name}: 调用 ${tool.calls} · 完成 ${tool.results}` +
			(tool.errors > 0 ? ` · 出错 ${tool.errors}` : "") +
			(pending > 0 ? ` · 未完成 ${pending}` : "")
		);
	});
}

export function formatToolSummary(stats: SessionStats): string {
	const rate =
		stats.toolResults > 0 ? ((stats.toolErrors / stats.toolResults) * 100).toFixed(1) : "0.0";
	const tools = Object.keys(stats.perTool).length;
	return (
		`工具调用 ${stats.toolCalls} 次 / ${tools} 个工具 · 完成 ${stats.toolResults} · ` +
		`未完成 ${stats.pendingCalls} · 出错 ${stats.toolErrors}（${rate}%）`
	);
}

const DIVIDER = "────────────────";

/** 完整报告：工具在前（核心），思考与口径说明在后 */
export function formatReportLines(
	stats: SessionStats,
	meta: { model?: string; thinkingLevel?: string } = {},
): string[] {
	const toolLines = formatToolLines(stats);
	return [
		formatToolSummary(stats),
		...(toolLines.length > 0 ? toolLines : ["（无工具调用）"]),
		DIVIDER,
		`思考 ${stats.thinkingBlocks} 段 / ${stats.thinkingMessages} 轮 · ${stats.thinkingChars} 字符`,
		`用户消息 ${stats.userMessages} · assistant 消息 ${stats.assistantMessages} · 用户 bash ${stats.userBash} · 条目 ${stats.entries}`,
		`模型 ${meta.model ?? "unknown"} · 思考等级 ${meta.thinkingLevel ?? "unknown"}`,
		DIVIDER,
		"仅统计当前分支；被 /tree 放弃的分支不计入",
		"被扩展拦截的工具调用同样记为出错，无法与真实执行失败区分",
		"subagent 子会话独立计数，此处只算父会话的 1 次工具调用",
		"thinking 为 0 不代表未推理：非 reasoning 模型 / thinkingLevel: off / 加密 reasoning 都不落盘",
	];
}

interface CommandContext {
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
	sessionManager: { getBranch(): unknown[] };
	ui: {
		notify(message: string, level?: string): void;
	};
}

/** 报告首行：tui 作为状态行首句，GUI 作为 notice card 的折叠标题。 */
const TITLE = "工具使用统计（当前分支）";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tools-status", {
		description: "统计本会话各工具的调用 / 完成 / 出错次数（含思考段数）",
		handler: async (_args: string, ctx: CommandContext) => {
			const stats = collectStats(ctx.sessionManager.getBranch() as AnyEntry[]);
			const model = ctx.model;
			const lines = formatReportLines(stats, {
				model: model?.id ? `${model.provider ?? "?"}/${model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			});

			ctx.ui.notify([TITLE, ...lines].join("\n"), "info");
		},
	});
}
