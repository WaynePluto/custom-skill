/**
 * 核心工具激活扩展
 *
 * Pi 默认只激活 read / bash / edit / write（硬编码在 SDK 的 core/sdk.ts）。
 * 本扩展在每次 session 启动时把 SDK registry 里已有但未激活的 grep / find / ls 补进激活集，
 * 使 CLI 与 pi-agent-chat（GUI）拿到一致的工具集——两者都从 ~/.pi/agent/extensions/ 加载扩展。
 *
 * 二进制依赖：grep 用 rg、find 用 fd，由 SDK 的 utils/tools-manager.ts 托管在 ~/.pi/agent/bin/。
 * 本扩展不定位、不下载、不往 PATH 注入任何二进制；升级或锁版本请直接替换该目录下的文件。
 *
 * 约束：
 * 1. setActiveTools() 是替换整个激活集，不是追加。必须先 getActiveTools() 再合并，
 *    否则会静默关掉内置工具和其它扩展注册的工具（例如 GUI 的 subagent）。
 * 2. 先用 getAllTools() 过滤，SDK 升级删掉某个工具名时不会报错或静默失效。
 * 3. session_start 的 reason 覆盖 startup / reload / new / resume / fork，全部都要处理，
 *    否则 /new、/resume 之后工具就没了。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 需要额外激活的 SDK 内置工具 */
const EXTRA_TOOLS = ["grep", "find", "ls"] as const;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const missing = EXTRA_TOOLS.filter((name) => available.has(name) && !active.includes(name));
		if (missing.length === 0) return;
		pi.setActiveTools([...new Set([...active, ...missing])]);
	});
}
