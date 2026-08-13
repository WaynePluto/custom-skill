/**
 * services 扩展：常驻服务（dev server、后端、watcher）的启动、查看与停止。
 *
 * 目录形式扩展，入口文件叫 services.ts 而不是惯例的 index.ts：pi 的资源列表用
 * `basename(extension.path)` 做显示名，叫 index.ts 就看不出是哪个扩展。改名后必须靠
 * 同目录的 package.json 声明 `pi.extensions` 来指定入口，否则 loader 只认 index.ts / index.js。
 * core.ts 不在声明列表里，不会被当成第二个扩展加载。
 *
 * 解决的问题：`pnpm dev` 这类命令永远不退出，而 bash 工具的语义是「等进程退出、
 * 拿退出码」，两者天然冲突——模型一调就卡住。更糟的是进程起来之后没人记得它在哪，
 * 用户想手动关也找不到。
 *
 * 做法是把「后台执行 + 句柄 + 单独读日志」这三件事补齐：
 * detached 起进程、日志落 `.pi/logs/<name>.log`、注册表落 `.pi/services.json`，
 * 工具调用立刻返回，不阻塞对话。
 *
 * 呈现只用 SDK 原生、宿主无关的接口：
 * - `ctx.ui.setStatus` —— CLI 画在 footer，pi-agent-chat 画在状态行
 * - `ctx.ui.setWidget` —— CLI 画在编辑器上方，pi-agent-chat 画在输入框上方
 * - `ctx.ui.notify`    —— CLI 走状态区，pi-agent-chat 走对话流卡片
 * 因此这个扩展不依赖任何特定宿主，CLI 与 GUI 的能力完全一致。
 *
 * 安全约束：pid 会被操作系统复用，「pid 还活着」不等于「还是我们那个进程」。
 * 所有会杀进程的路径都先比对进程创建时间，比对不上或比对不了就拒绝执行，
 * 详见 core.ts 的 identify()。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	type ServiceRecord,
	formatServiceLines,
	formatServiceReport,
	formatStatus,
	identify,
	isValidName,
	killTree,
	logPath,
	parseCommandArgs,
	readRegistry,
	readText,
	reconcile,
	shellDialectWarning,
	startProcess,
	tailText,
	waitForReady,
	writeRegistry,
} from "./core.ts";

/** 注册表与 UI 共用的 key；同一个 key 重复 set 即替换。 */
const SURFACE_KEY = "services";

const DEFAULT_READY_TIMEOUT_MS = 8000;
const DEFAULT_LOG_LINES = 40;

/** 最小上下文类型：只声明本扩展用到的成员，不依赖 SDK 内部类型。 */
interface Ctx {
	cwd: string;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		setWidget(key: string, content: string[] | undefined): void;
	};
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

/** 注册表对齐操作系统实况，并把结果推到状态行与 widget。 */
function refresh(ctx: Ctx): ServiceRecord[] {
	const { live, dropped } = reconcile(readRegistry(ctx.cwd).services, (record) => identify(record));
	if (dropped.length > 0) writeRegistry(ctx.cwd, live);
	ctx.ui.setStatus(SURFACE_KEY, formatStatus(live));
	ctx.ui.setWidget(SURFACE_KEY, live.length === 0 ? undefined : formatServiceLines(live));
	return live;
}

function find(services: ServiceRecord[], name: string): ServiceRecord | undefined {
	return services.find((service) => service.name === name);
}

/**
 * 停止一个服务。返回给调用方的字符串已经是最终结论，
 * 包括「拒绝执行」的情形——那不是失败，是安全默认值。
 */
function stop(ctx: Ctx, name: string): string {
	const services = refresh(ctx);
	const service = find(services, name);
	if (!service) return `没有名为 ${name} 的运行中服务`;

	const identity = identify(service);
	if (identity === "gone" || identity === "recycled") {
		writeRegistry(
			ctx.cwd,
			services.filter((item) => item.name !== name),
		);
		refresh(ctx);
		return `${name} 已经不在运行（注册表条目已清理）`;
	}
	if (identity === "unknown") {
		// 无法确认 pid 身份时宁可不动手：杀错一棵进程树的代价远大于让用户手动确认。
		return (
			`无法确认 pid ${service.pid} 仍是 ${name} 本身（读不到进程创建时间），已放弃自动停止。\n` +
			`确认无误后手动结束：${process.platform === "win32" ? `taskkill /PID ${service.pid} /T /F` : `kill -- -${service.pid}`}`
		);
	}

	killTree(service.pid);
	writeRegistry(
		ctx.cwd,
		services.filter((item) => item.name !== name),
	);
	refresh(ctx);
	return `${name} 已停止（pid ${service.pid}）`;
}

async function start(
	ctx: Ctx,
	options: {
		name: string;
		command: string;
		cwd?: string;
		port?: number;
		readyLog?: string;
		readyTimeoutMs?: number;
		shell?: string;
	},
): Promise<string> {
	if (!isValidName(options.name))
		return `服务名 ${options.name} 不合法：只允许字母、数字、点、下划线和连字符，且不超过 64 字符`;

	const services = refresh(ctx);
	if (find(services, options.name)) return `${options.name} 已在运行；要换命令请先 service_stop，或用 service_restart`;

	const record = startProcess({
		name: options.name,
		command: options.command,
		cwd: options.cwd ?? ctx.cwd,
		...(options.port === undefined ? {} : { port: options.port }),
		...(options.shell === undefined ? {} : { shell: options.shell }),
	});
	writeRegistry(ctx.cwd, [...services, record]);
	refresh(ctx);

	const outcome = await waitForReady(record, {
		...(options.port === undefined ? {} : { port: options.port }),
		...(options.readyLog === undefined ? {} : { readyLog: options.readyLog }),
		timeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
	});
	const tail = tailText(readText(record.logFile), DEFAULT_LOG_LINES);

	if (outcome === "exited") {
		// 进程没活过启动阶段：注册表不该留下一条假的运行记录。
		writeRegistry(ctx.cwd, readRegistry(ctx.cwd).services.filter((item) => item.name !== options.name));
		refresh(ctx);
		return `${options.name} 启动后立即退出。日志（${record.logFile}）:\n${tail}`;
	}
	refresh(ctx);
	const head =
		outcome === "ready"
			? `${options.name} 已启动，pid ${record.pid}`
			: `${options.name} 已启动（pid ${record.pid}），但在超时前未确认就绪，请自行判断下面的日志`;
	// 默认情况下 shell 与 bash 工具一致，不需要说明；只有落不到 pwsh 时才必须提醒调用方换语法。
	const dialect = shellDialectWarning(record.shell ?? "");
	return [head, ...(dialect ? [dialect] : []), `日志 ${record.logFile}`, tail].join("\n");
}

export default function (pi: ExtensionAPI) {
	// 每次会话开始都重新对齐一次：上一次会话结束后服务可能已经被手动关掉，
	// 也可能还活着（这正是 detached 的意义），注册表必须以进程实况为准。
	pi.on("session_start", (_event, ctx) => {
		refresh(ctx as unknown as Ctx);
	});

	pi.registerTool({
		name: "service_start",
		label: "Start service",
		description:
			"Start a long-running service (dev server, backend, watcher) as a detached background process and return immediately. " +
			"Output is written to .pi/logs/<name>.log; the process survives this tool call, this session and pi itself. " +
			"Use this instead of bash for any command that does not exit on its own.",
		// promptSnippet 不是可选装饰：不提供时自定义工具不会出现在系统提示的
		// Available tools 清单里，模型在规划阶段就想不起来有这个能力。
		promptSnippet: "Start a long-running command as a detached background process; returns immediately instead of waiting for exit",
		parameters: Type.Object({
			name: Type.String({ description: "Unique service name, also used as the log file name" }),
			command: Type.String({ description: "Shell command to run, e.g. 'pnpm dev'" }),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the project root" })),
			port: Type.Optional(
				Type.Number({ description: "TCP port the service listens on; used as the readiness probe when given" }),
			),
			readyLog: Type.Optional(
				Type.String({ description: "Regex matched against the log to detect readiness when no port is given" }),
			),
			readyTimeoutMs: Type.Optional(Type.Number({ description: "Readiness probe timeout in ms (default 8000)" })),
			shell: Type.Optional(
				Type.String({
					description:
						"Shell used to run the command. Defaults to the same shell as the bash tool " +
						"(PowerShell 7 on Windows, /bin/sh elsewhere), so commands use one syntax everywhere. " +
						"Override only when this specific command needs a different shell.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(await start(ctx as unknown as Ctx, params));
		},
	});

	pi.registerTool({
		name: "service_list",
		label: "List services",
		description:
			"List the services started through service_start that are still running, with pid, port, uptime and log path. " +
			"Entries whose process is gone are pruned from the registry.",
		promptSnippet: "List running background services with pid, port, uptime and log path",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return text(formatServiceReport(refresh(ctx as unknown as Ctx)));
		},
	});

	pi.registerTool({
		name: "service_logs",
		label: "Read service logs",
		description: "Return the tail of a running service's log file.",
		promptSnippet: "Read the tail of a background service's log file",
		parameters: Type.Object({
			name: Type.String({ description: "Service name" }),
			lines: Type.Optional(Type.Number({ description: `Number of trailing lines (default ${DEFAULT_LOG_LINES})` })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const context = ctx as unknown as Ctx;
			const service = find(refresh(context), params.name);
			// 服务已经停了日志还在，这时读日志恰恰是最有价值的（排查它为什么死的）。
			const file = service?.logFile ?? logPath(context.cwd, params.name);
			const tail = tailText(readText(file), params.lines ?? DEFAULT_LOG_LINES);
			if (tail === "") return text(`${file} 没有内容`);
			return text(`${file}${service ? "" : "（服务未在运行）"}\n${tail}`);
		},
	});

	pi.registerTool({
		name: "service_stop",
		label: "Stop service",
		description:
			"Stop a service started by service_start, killing its whole process tree. " +
			"Refuses to act when the recorded pid can no longer be confirmed to be that service.",
		promptSnippet: "Stop a background service and its whole process tree",
		parameters: Type.Object({ name: Type.String({ description: "Service name" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(stop(ctx as unknown as Ctx, params.name));
		},
	});

	pi.registerTool({
		name: "service_restart",
		label: "Restart service",
		description: "Stop a running service and start it again with the command recorded at start time.",
		promptSnippet: "Restart a background service with the command recorded at start time",
		parameters: Type.Object({
			name: Type.String({ description: "Service name" }),
			readyTimeoutMs: Type.Optional(Type.Number({ description: "Readiness probe timeout in ms (default 8000)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const context = ctx as unknown as Ctx;
			const previous = find(refresh(context), params.name);
			if (!previous) return text(`没有名为 ${params.name} 的运行中服务`);
			const stopped = stop(context, params.name);
			if (!stopped.includes("已停止")) return text(`重启中止：${stopped}`);
			return text(
				await start(context, {
					name: previous.name,
					command: previous.command,
					cwd: previous.cwd,
					...(previous.port === undefined ? {} : { port: previous.port }),
					...(previous.shell === undefined ? {} : { shell: previous.shell }),
					...(params.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: params.readyTimeoutMs }),
				}),
			);
		},
	});

	// 用户手动通道。工具面向模型，命令面向人，两者共用上面同一份实现，
	// 不存在「GUI 按钮做一套、CLI 做另一套」的分叉。
	pi.registerCommand("services", {
		description: "查看 / 停止 / 重启由 service_start 启动的常驻服务",
		handler: async (args: string, ctx) => {
			const context = ctx as unknown as Ctx;
			const { action, name } = parseCommandArgs(args);
			if (action === "list") {
				context.ui.notify(formatServiceReport(refresh(context)), "info");
				return;
			}
			if (!name) {
				context.ui.notify(`用法：/services list | logs <name> | stop <name> | restart <name>`, "warning");
				return;
			}
			if (action === "logs") {
				const service = find(refresh(context), name);
				const file = service?.logFile ?? logPath(context.cwd, name);
				context.ui.notify(`${file}\n${tailText(readText(file), DEFAULT_LOG_LINES)}`, "info");
				return;
			}
			if (action === "stop") {
				context.ui.notify(stop(context, name), "info");
				return;
			}
			if (action === "restart") {
				const previous = find(refresh(context), name);
				if (!previous) {
					context.ui.notify(`没有名为 ${name} 的运行中服务`, "warning");
					return;
				}
				const stopped = stop(context, name);
				if (!stopped.includes("已停止")) {
					context.ui.notify(`重启中止：${stopped}`, "warning");
					return;
				}
				context.ui.notify(
					await start(context, {
						name: previous.name,
						command: previous.command,
						cwd: previous.cwd,
						...(previous.port === undefined ? {} : { port: previous.port }),
						...(previous.shell === undefined ? {} : { shell: previous.shell }),
					}),
					"info",
				);
				return;
			}
			context.ui.notify(`未知操作 ${action}；可用：list | logs | stop | restart`, "warning");
		},
	});
}
