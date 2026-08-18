/**
 * pwsh 扩展的确定性核心：发现 PowerShell、读取版本并给出可操作的诊断。
 *
 * 这里只依赖 Node 内置模块，不 import Pi SDK / typebox / TUI，因而可以被
 * `node --experimental-strip-types --test` 直接加载。Pi 工具注册留在 pwsh.ts。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MIN_PWSH_MAJOR = 7;
export const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface PwshVersion {
	text: string;
	major: number;
}

export interface PwshProbeResult {
	version?: PwshVersion;
	error?: string;
}

export type PwshDiagnostic =
	| { available: true; executable: string; version: PwshVersion }
	| { available: false; reason: string; candidates: string[] };

interface FindOptions {
	platform?: NodeJS.Platform;
	env?: Record<string, string | undefined>;
	cwd?: string;
	isFile?: (candidate: string) => boolean;
}

interface DiagnosticDeps {
	findCandidates?: () => string[];
	probeVersion?: (executable: string) => PwshProbeResult;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : env[key];
}

function defaultIsFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function uniquePaths(values: string[], platform: NodeJS.Platform): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = platform === "win32" ? value.toLowerCase() : value;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * 返回所有存在的 pwsh 候选，而不是只拿第一个：PATH 上可能有坏掉的 WindowsApps alias，
 * 也可能同时有旧版与新版。版本诊断会按顺序逐一探测，直到找到 >= 7 的实现。
 */
export function findPwshCandidates(options: FindOptions = {}): string[] {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const isFile = options.isFile ?? defaultIsFile;
	const candidates: string[] = [];
	const pathApi = platform === "win32" ? path.win32 : path.posix;

	const pathValue = envValue(env, "PATH") ?? "";
	const pathEntries = pathValue
		.split(pathApi.delimiter)
		.map((entry) => entry.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);

	const executableNames =
		platform === "win32"
			? (envValue(env, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM")
					.split(";")
					.filter(Boolean)
					.map((extension) => `pwsh${extension.startsWith(".") ? extension : `.${extension}`}`)
			: ["pwsh"];

	for (const directory of pathEntries) {
		for (const executable of executableNames) candidates.push(pathApi.resolve(cwd, directory, executable));
	}

	if (platform === "win32") {
		// PATH 之后才用标准安装目录兜底；不读取自定义 shell 路径或偏好环境变量。
		for (const rootName of ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]) {
			const root = envValue(env, rootName);
			if (root) candidates.push(pathApi.join(root, "PowerShell", "7", "pwsh.exe"));
		}
	}

	return uniquePaths(candidates, platform).filter(isFile);
}

/** 从 PowerShell 输出中提取第一个完整版本号。 */
export function parsePwshVersion(output: string): PwshVersion | undefined {
	const match = output.match(/\b(\d+)\.(\d+)(?:\.\d+){0,2}\b/);
	if (!match) return undefined;
	return { text: match[0], major: Number.parseInt(match[1], 10) };
}

/**
 * 用无 profile、非交互模式读取版本；只把网页/用户输入当参数的风险在这里不存在，
 * executable 来自本机文件发现，脚本是扩展内的常量。
 */
export function probePwshVersion(executable: string): PwshProbeResult {
	const result = spawnSync(
		executable,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
		{
			encoding: "utf8",
			timeout: VERSION_PROBE_TIMEOUT_MS,
			windowsHide: true,
		},
	);

	if (result.error) return { error: result.error.message };
	if (result.status !== 0) {
		const detail = String(result.stderr ?? result.stdout ?? "").trim().replace(/\s+/g, " ");
		return { error: detail || `exit code ${result.status ?? "unknown"}` };
	}
	const version = parsePwshVersion(String(result.stdout ?? ""));
	return version ? { version } : { error: "无法从版本输出中解析版本号" };
}

/** 发现并验证 PowerShell 7；候选失败时继续尝试下一个。 */
export function diagnosePwsh(deps: DiagnosticDeps = {}): PwshDiagnostic {
	const candidates = (deps.findCandidates ?? findPwshCandidates)();
	if (candidates.length === 0) {
		return {
			available: false,
			reason: "未找到 pwsh；请安装 PowerShell 7 并确保 pwsh 在 PATH 或标准安装目录中",
			candidates: [],
		};
	}

	const probe = deps.probeVersion ?? probePwshVersion;
	const failures: string[] = [];
	for (const executable of candidates) {
		const result = probe(executable);
		if (result.version && result.version.major >= MIN_PWSH_MAJOR) {
			return { available: true, executable, version: result.version };
		}
		if (result.version) failures.push(`${executable}: 版本 ${result.version.text}（要求 >= ${MIN_PWSH_MAJOR}）`);
		else failures.push(`${executable}: ${result.error ?? "版本探测失败"}`);
	}

	return {
		available: false,
		reason: `找到 pwsh，但没有可用的 PowerShell 7：${failures.join("；")}`,
		candidates,
	};
}
