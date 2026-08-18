/**
 * services 扩展的核心逻辑：注册表、进程生命周期、就绪探测、输出格式化。
 *
 * 这个文件只依赖 Node 内置模块，不 import pi SDK 也不 import typebox，
 * 因此可以被 `node --experimental-strip-types --test` 直接加载做单测。
 * 与 pi 相关的部分（registerTool / registerCommand / ctx.ui）全部留在 index.ts。
 *
 * 设计要点：
 *
 * 1. 服务进程必须脱离 pi 的进程树。pi 的 bash 工具在超时或取消时会对自己 spawn 的
 *    shell 调用 killProcessTree，若服务是它的后代就会陪葬；而扩展进程本身也会随
 *    CLI / 侧边栏退出而结束。所以一律 detached + stdio 重定向到日志文件 + unref()。
 * 2. 注册表里的 pid 会变脏（进程崩溃、机器重启、用户手动 kill）。pid 还会被系统复用，
 *    因此「pid 活着」不等于「是我们那个进程」。停止前必须比对进程创建时间，
 *    比对不了就拒绝动手，而不是盲杀一棵进程树。
 * 3. 就绪探测有三种口径（端口 / 日志正则 / 固定等待）。超时不算失败，返回日志尾部
 *    让模型自己判断——服务起没起来，日志比退出码更有信息量。
 */

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

// ── 类型 ──

export interface ServiceRecord {
	/** 用户/模型指定的名字，注册表主键 */
	name: string;
	/** 原样保存，restart 时复用 */
	command: string;
	cwd: string;
	pid: number;
	/** 我们 spawn 完成的时刻（ms）。与 OS 报告的进程创建时间比对，用于识别 pid 复用。 */
	startedAt: number;
	logFile: string;
	port?: number;
	/** spawn 时实际使用的 shell 可执行文件 */
	shell?: string;
}

export interface Registry {
	version: 1;
	services: ServiceRecord[];
}

export const REGISTRY_VERSION = 1;

/** OS 报告的创建时间与我们记录的 startedAt 允许的偏差；超出即判定 pid 已被复用。 */
export const START_TIME_TOLERANCE_MS = 60_000;

// ── 路径 ──

export function registryPath(cwd: string): string {
	return path.join(cwd, ".pi", "services.json");
}

export function logPath(cwd: string, name: string): string {
	return path.join(cwd, ".pi", "logs", `${name}.log`);
}

/**
 * `.pi/logs/` 下的服务名（去掉 `.log` 后缀）。
 * 一份扫描两个用途：判断值不值得放出 `service_logs`，以及在报告里告诉调用方有哪些日志可读。
 * 只放工具不给名字，调用方根本不知道该传什么 name。
 */
export function listLogNames(cwd: string): string[] {
	try {
		return fs
			.readdirSync(path.join(cwd, ".pi", "logs"), { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
			.map((entry) => entry.name.slice(0, -".log".length))
			.filter(isValidName)
			.sort();
	} catch {
		// 目录不存在就是「一份日志都没有」，不是错误。
		return [];
	}
}

/** 服务名同时用作文件名和注册表主键，先挡掉路径穿越和空白名。 */
export function isValidName(name: string): boolean {
	return /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

// ── 注册表读写 ──

export function readRegistry(cwd: string): Registry {
	try {
		const raw = fs.readFileSync(registryPath(cwd), "utf8");
		const parsed = JSON.parse(raw) as Partial<Registry>;
		if (!Array.isArray(parsed.services)) return { version: REGISTRY_VERSION, services: [] };
		return { version: REGISTRY_VERSION, services: parsed.services.filter(isRecord) };
	} catch {
		// 不存在 / 损坏都按空注册表处理：这份文件是缓存，不是事实来源，
		// 事实来源是操作系统里的进程。
		return { version: REGISTRY_VERSION, services: [] };
	}
}

function isRecord(value: unknown): value is ServiceRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ServiceRecord>;
	return typeof record.name === "string" && typeof record.pid === "number" && typeof record.command === "string";
}

export function writeRegistry(cwd: string, services: ServiceRecord[]): void {
	const file = registryPath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const payload: Registry = { version: REGISTRY_VERSION, services };
	fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

// ── 存活判定 ──

/** 信号 0 只做权限与存在性检查，不投递信号。 */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM 表示进程存在但不属于当前用户，仍然算活着。
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * OS 报告的进程创建时间（ms）。拿不到返回 undefined —— 调用方必须把
 * undefined 当作「无法确认身份」，而不是「确认是同一个进程」。
 */
export function processStartedAt(pid: number): number | undefined {
	if (!isPidAlive(pid)) return undefined;
	try {
		if (process.platform === "win32") {
			const shell = findExecutable("pwsh") ?? findExecutable("powershell");
			if (!shell) return undefined;
			const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
			const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf8",
				windowsHide: true,
			});
			if (result.status !== 0) return undefined;
			// .NET ticks: 100ns 自 0001-01-01；621355968000000000 是 Unix 纪元的 ticks。
			const ticks = BigInt(result.stdout.trim());
			return Number((ticks - 621_355_968_000_000_000n) / 10_000n);
		}
		const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
		if (result.status !== 0) return undefined;
		const parsed = Date.parse(result.stdout.trim());
		return Number.isNaN(parsed) ? undefined : parsed;
	} catch {
		return undefined;
	}
}

export type Identity = "ours" | "gone" | "unknown" | "recycled";

/**
 * 这个 pid 还是我们启动的那个进程吗？
 *
 * - `gone`：进程已经不在，注册表条目可以直接删掉
 * - `ours`：存活且创建时间对得上
 * - `recycled`：存活但创建时间对不上 —— pid 被复用了，绝对不能杀
 * - `unknown`：拿不到创建时间，无法判断；杀之前需要用户明确确认
 */
export function identify(
	record: ServiceRecord,
	deps: { alive?: typeof isPidAlive; startedAt?: typeof processStartedAt } = {},
): Identity {
	const alive = (deps.alive ?? isPidAlive)(record.pid);
	if (!alive) return "gone";
	const osStart = (deps.startedAt ?? processStartedAt)(record.pid);
	if (osStart === undefined) return "unknown";
	return Math.abs(osStart - record.startedAt) <= START_TIME_TOLERANCE_MS ? "ours" : "recycled";
}

/**
 * 用存活判定过滤注册表。纯函数：判定逻辑注入，便于单测。
 *
 * `recycled` 与 `gone` 一样从注册表移除：那个 pid 已经不代表我们的服务了，
 * 留着只会让后续操作误伤。
 */
export function reconcile(
	services: ServiceRecord[],
	identifyFn: (record: ServiceRecord) => Identity,
): { live: ServiceRecord[]; dropped: Array<{ record: ServiceRecord; reason: Identity }> } {
	const live: ServiceRecord[] = [];
	const dropped: Array<{ record: ServiceRecord; reason: Identity }> = [];
	for (const record of services) {
		const identity = identifyFn(record);
		if (identity === "ours" || identity === "unknown") live.push(record);
		else dropped.push({ record, reason: identity });
	}
	return { live, dropped };
}

// ── 启动 ──

export interface StartOptions {
	name: string;
	command: string;
	cwd: string;
	port?: number;
	shell?: string;
}

/**
 * detached + 日志重定向 + unref()：进程与 pi 完全脱钩。
 *
 * `detached: true` 是**必需**的，不是优化：实测下非 detached 的子进程会随父进程退出而被杀
 * （VS Code 扩展宿主与终端宿主都把子进程放在 kill-on-close 的 job object 里），
 * 而那正是本扩展要避免的情况。
 *
 * stdout 与 stderr 指向同一个 fd，交织顺序即真实发生顺序；分开两个文件会让
 * 「报错发生在哪一行输出之后」这个信息丢失，而那正是判断服务起没起来的关键。
 */
export function startProcess(options: StartOptions): ServiceRecord {
	const logFile = logPath(options.cwd, options.name);
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	// 截断而不是追加：每次启动的日志独立，就绪探测才能只看本次输出。
	const fd = fs.openSync(logFile, "w");
	const invocation = shellInvocation(options.command, options.shell);
	try {
		const child = spawn(invocation.file, invocation.args, {
			cwd: options.cwd,
			detached: true,
			stdio: ["ignore", fd, fd],
			windowsHide: true,
		});
		child.unref();
		if (child.pid === undefined) throw new Error("spawn returned no pid");
		return {
			name: options.name,
			command: options.command,
			cwd: options.cwd,
			pid: child.pid,
			startedAt: Date.now(),
			logFile,
			...(options.port === undefined ? {} : { port: options.port }),
			shell: invocation.shell,
		};
	} finally {
		fs.closeSync(fd);
	}
}

export interface ShellInvocation {
	/** 实际 spawn 的可执行文件（Windows 上是 node 启动器） */
	file: string;
	args: string[];
	/** 命令真正跑在哪个 shell 里——决定了命令该用什么语法方言 */
	shell: string;
}

/**
 * 启动器脚本：由一个 detached 的 node 执行，再由它去起真正的命令。
 * argv[1] = 命令行，argv[2] = shell（空串表示平台默认）。
 */
const WINDOWS_LAUNCHER =
	'const{spawn}=require("child_process");' +
	'spawn(process.argv[1],{shell:process.argv[2]||true,stdio:["ignore","inherit","inherit"],windowsHide:true});';

/**
 * 把命令行包成「可执行文件 + 参数」。
 *
 * **默认 shell 与 pi 的 bash 工具保持一致**（Windows 上都是 PowerShell 7）。这不是可有可无的
 * 对齐：若一个工具用 pwsh 语法、另一个用 cmd 语法，模型就得在两套方言之间切换，
 * 出错率必然上升。pwsh 不在 PATH 上时才退回平台默认（cmd.exe），且经
 * shellDialectWarning() 告知调用方。
 *
 * Windows 上经一个 node 启动器中转，看着绕，但三个实测结论把其他路都堵死了：
 *
 * 1. Node 的 `shell: true` 与 `detached: true` 在 Windows 上不兼容：命令不执行、输出全丢，
 *    退出码却是 0。
 * 2. `detached: true` 对应 Windows 的 `DETACHED_PROCESS`，子进程没有 console。
 *    **pwsh 需要 console，在这种进程里会立即退出且不产生任何输出**；
 *    嵌套 `cmd /c pwsh`、`start /min`、`start /b` 三种写法均无效。
 * 3. cmd.exe 在 detached 下能执行命令，但**不把子进程的 stdout/stderr 转发到继承的
 *    文件句柄**，日志永远是空的——而日志是这个扩展存在的意义。
 *
 * node 本身在 detached 下一切正常（能跑、能写继承的 fd、能存活到父进程退出之后），
 * 所以用它做一层薄启动器，真正的 shell 就变成了启动器的普通子进程，stdio 正常。
 * 启动器会在子进程退出后自然退出，所以它的存活情况就代表服务的存活情况；
 * 杀的时候走 killTree，启动器和真正的服务进程一起清掉。
 *
 * POSIX 没有这些问题，保持原生的 `sh -c` + 进程组语义，不多一层进程。
 */
export function shellInvocation(command: string, shell?: string): ShellInvocation {
	if (process.platform === "win32") {
		// pwsh 需要 console，直接 detached 起不来；做为启动器的普通子进程则完全正常。
		const resolved = shell ?? findExecutable("pwsh");
		return {
			file: process.execPath,
			// 空串让启动器回退到 Node 的 `shell: true`，即 ComSpec / cmd.exe。
			args: ["-e", WINDOWS_LAUNCHER, command, resolved ?? ""],
			shell: resolved ?? process.env.ComSpec ?? "cmd.exe",
		};
	}
	const resolved = shell ?? "/bin/sh";
	return { file: resolved, args: ["-c", command], shell: resolved };
}

/**
 * pwsh 没找到时命令的语法方言就变了，必须告知调用方，否则它会继续写 PowerShell
 * 语法，然后对着一堆看不懂的 cmd 报错发愁。
 */
export function shellDialectWarning(shell: string): string | undefined {
	if (process.platform !== "win32" || /pwsh(\.exe)?$/i.test(shell)) return undefined;
	return `本机未找到 pwsh，命令实际运行在 ${path.basename(shell)}，需改用该 shell 的语法`;
}

/** 在 PATH 上找可执行文件，只做存在性检查，不启动进程。 */
export function findExecutable(name: string): string | undefined {
	const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const extensions =
		process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
	for (const dir of entries) {
		for (const ext of extensions) {
			const candidate = path.join(dir, name + ext);
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				// 下一个候选
			}
		}
	}
	return undefined;
}

// ── 就绪探测 ──

export interface ReadyOptions {
	port?: number;
	readyLog?: string;
	timeoutMs: number;
}

export type ReadyOutcome = "ready" | "timeout" | "exited";

/**
 * 三种口径按优先级：端口 > 日志正则 > 固定等待。
 *
 * 进程中途退出立即返回 `exited`：那是启动失败，让调用方尽快把日志尾部交给模型，
 * 而不是干等到超时。
 */
export async function waitForReady(
	record: ServiceRecord,
	options: ReadyOptions,
	deps: { alive?: (pid: number) => boolean; now?: () => number } = {},
): Promise<ReadyOutcome> {
	const alive = deps.alive ?? isPidAlive;
	const now = deps.now ?? Date.now;
	const deadline = now() + options.timeoutMs;
	const hasProbe = options.port !== undefined || options.readyLog !== undefined;

	while (now() < deadline) {
		if (!alive(record.pid)) return "exited";
		if (options.port !== undefined && (await canConnect(options.port))) return "ready";
		if (options.readyLog !== undefined && matchesReadyLog(readText(record.logFile), options.readyLog)) return "ready";
		await delay(150);
	}
	if (!alive(record.pid)) return "exited";
	// 没有探测条件时，「等满时间且进程还活着」就是这里能给出的最强结论。
	return hasProbe ? "timeout" : "ready";
}

export function matchesReadyLog(text: string, pattern: string): boolean {
	try {
		return new RegExp(pattern, "i").test(text);
	} catch {
		// 非法正则退化为子串匹配，而不是让整个启动流程失败。
		return text.toLowerCase().includes(pattern.toLowerCase());
	}
}

function canConnect(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host: "127.0.0.1" });
		const done = (value: boolean) => {
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.setTimeout(500, () => done(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 停止 ──

/**
 * 杀掉整棵进程树：`pnpm dev` 这类命令下面往往还有 node / vite 子进程，
 * 只杀 shell 会留下真正占着端口的那个。
 */
export function killTree(pid: number): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
		return;
	}
	try {
		// detached 启动的进程自成进程组，负号即整组。
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// 已经不在了
		}
	}
}

// ── 日志 ──

export function readText(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** 取末尾 N 行。纯函数，便于单测。 */
export function tailText(text: string, lines: number): string {
	if (lines <= 0) return "";
	const all = text.split(/\r?\n/);
	// 末尾换行会产生一个空串元素，去掉它免得白占一行。
	if (all.length > 0 && all[all.length - 1] === "") all.pop();
	return all.slice(-lines).join("\n");
}

// ── 展示 ──

export function formatUptime(ms: number): string {
	if (ms < 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** widget 用：每个服务一行。 */
export function formatServiceLines(services: ServiceRecord[], now = Date.now()): string[] {
	return services.map((service) => {
		const parts = [service.name];
		if (service.port !== undefined) parts.push(`:${service.port}`);
		parts.push(`pid ${service.pid}`, formatUptime(now - service.startedAt));
		return parts.join("  ");
	});
}

/** 状态行用：一行讲完，窄面板也读得出。 */
export function formatStatus(services: ServiceRecord[]): string | undefined {
	if (services.length === 0) return undefined;
	return `\u25b6 ${services.length} service${services.length === 1 ? "" : "s"}`;
}

/**
 * 报告用：服务列表加日志文件位置。
 * `logNames` 中没在运行的那些单独列一行；服务死后唯一能做的事就是读日志，而读日志需要名字。
 */
export function formatServiceReport(
	services: ServiceRecord[],
	now = Date.now(),
	logNames: readonly string[] = [],
): string {
	const running = new Set(services.map((service) => service.name));
	const stale = logNames.filter((name) => !running.has(name));
	const staleLine = stale.length === 0 ? [] : [`已停止但日志可读：${stale.join("、")}`];
	if (services.length === 0) return ["没有正在运行的服务", ...staleLine].join("\n");
	return [
		`运行中 ${services.length} 个服务：`,
		...services.map((service, index) => `${formatServiceLines(services, now)[index]}  ${service.command}`),
		...services.map((service) => `  日志 ${service.logFile}`),
		...staleLine,
	].join("\n");
}

// ── 工具按需加载 ──

/**
 * 按需加载的工具。两个入口工具不在其中，它们常驻激活集：
 *
 * - `service_start`：唯一能凭空创造服务的入口，收回了就再也放不出来了。
 * - `service_list`：参数是空对象，schema 成本是五个里最低的，换来「有没有服务」永远可实况回答；
 *   它同时是下面三个带参数工具的 loader，而且它的输出正好提供了下一步要用的 name。
 *
 * 省下的仍然是大头：三个带参数的 schema 只在真有东西可管时才进上下文。
 */
export const LAZY_TOOL_NAMES = ["service_logs", "service_stop", "service_restart"] as const;

const LAZY_TOOL_SET = new Set<string>(LAZY_TOOL_NAMES);

/**
 * 实况 → 该放出哪些工具。分档而不是一概全放：
 *
 * - 有活着的服务：三个都有意义。
 * - 只剩日志（服务已经死了）：只有 service_logs 有意义。stop / restart 都以「存在运行中的服务」
 *   为前提，此时放出来只会换来一句「没有名为 x 的运行中服务」，白费一个往返。
 * - 什么都没有：一个不放。
 */
export function lazyToolsFor(state: { live: boolean; logs: boolean }): string[] {
	if (state.live) return [...LAZY_TOOL_NAMES];
	return state.logs ? ["service_logs"] : [];
}

/**
 * 工具执行中的加载：**只增不减**。返回 undefined 表示无需改动。
 *
 * 1. Pi 只把纯增量变化当成 deferred loading 的信号；实况变差（服务死了）也不在会话中途收回，
 *    它们自己会报「没有运行中的服务」，代价比作废缓存前缀小得多。
 * 2. 只追加已注册的名字；SDK 会静默忽略未知名字，那样「没注册」和「没生效」分不清。
 * 3. 没变化就返回 undefined；每次 setActiveTools 都会重建系统提示，空转一次的代价是真实的。
 */
export function planToolLoad(
	active: readonly string[],
	registered: readonly string[],
	wanted: readonly string[],
): string[] | undefined {
	const known = new Set(registered);
	const missing = wanted.filter((name) => known.has(name) && !active.includes(name));
	return missing.length === 0 ? undefined : [...active, ...missing];
}

/**
 * 会话开始时的重置：懒加载工具里只保留 `wanted`，其余收回。
 * 这里允许删除，因为本会话还没发出任何请求；不重置反而会把上个会话（/new、/resume、reload）
 * 的激活状态继承下来。
 */
export function planToolReset(
	active: readonly string[],
	registered: readonly string[],
	wanted: readonly string[],
): string[] | undefined {
	const keep = new Set(wanted);
	const kept = active.filter((name) => !LAZY_TOOL_SET.has(name) || keep.has(name));
	return planToolLoad(kept, registered, wanted) ?? (kept.length === active.length ? undefined : kept);
}

// ── 命令参数 ──

/** `/services` 的参数解析：`<action> [name]`，无参数视为 list。 */
export function parseCommandArgs(args: string): { action: string; name?: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { action: "list" };
	return { action: tokens[0].toLowerCase(), ...(tokens[1] ? { name: tokens[1] } : {}) };
}
