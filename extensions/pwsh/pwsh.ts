/**
 * PowerShell 7 工具扩展。
 *
 * 复用 Pi 内置命令工具的执行框架，因此保留流式更新、Esc 取消、超时、Windows 进程树清理、
 * 末尾 2000 行 / 50KB 截断、完整输出临时文件与 PI_* 会话环境；只把可执行文件固定为
 * 经诊断确认过的 PowerShell 7，并把面向模型的名称、schema 与提示全部改成 pwsh 语义。
 *
 * 本扩展刻意不调用 getActiveTools / setActiveTools，也不覆盖同名内置工具：`bash` 是否禁用、
 * 何时禁用属于用户的工具集策略，不应由一个命令执行器擅自决定。
 */

import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import { diagnosePwsh } from "./core.ts";

export const PWSH_PARAMETERS = Type.Object({
	command: Type.String({ description: "PowerShell 7 command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type PwshToolInput = Static<typeof PWSH_PARAMETERS>;

export default function (pi: ExtensionAPI): void {
	const diagnostic = diagnosePwsh();
	if (!diagnostic.available) {
		// 不注册一个注定失败的工具；保留内置 bash 原状，并让所有 session replacement 都能看到原因。
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`PowerShell 7 工具未注册：${diagnostic.reason}`, "warning");
		});
		return;
	}

	const shellPath = diagnostic.executable;
	const base = createBashToolDefinition(process.cwd(), { shellPath });

	pi.registerTool({
		...base,
		name: "pwsh",
		label: "PowerShell 7",
		description:
			"Execute a PowerShell 7 command in the current working directory. Returns stdout and stderr. " +
			"Output is truncated to the last 2000 lines or 50KB (whichever is hit first); if truncated, the full output " +
			"is saved to a temporary file. Optionally provide a timeout in seconds.",
		promptSnippet: "Execute PowerShell 7 commands in the current working directory",
		promptGuidelines: ["Commands passed to pwsh must use PowerShell 7 syntax, not Bash or CMD syntax."],
		parameters: PWSH_PARAMETERS,
		// 执行 cwd 必须取 ctx.cwd（调用时从当前会话解析）：createBashToolDefinition 的第一个
		// 参数在加载时固化，而 process.cwd() 只在 CLI 宿主碰巧等于项目目录；在嵌入宿主
		// （pi-agent-chat 的 VS Code 扩展进程）里它指向宿主安装目录，每条命令都会落在项目外。
		// 这里按次重建定义，其余（流式/取消/超时/截断/环境注入）全部复用 base 的实现。
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const live = createBashToolDefinition(ctx.cwd, { shellPath });
			return live.execute(toolCallId, input, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const command = typeof args?.command === "string" ? args.command : "...";
			const timeout = typeof args?.timeout === "number" ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
			text.setText(theme.fg("toolTitle", theme.bold(`PS> ${command}`)) + timeout);
			return text;
		},
	});
}
