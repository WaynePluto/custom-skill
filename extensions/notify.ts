/**
 * 任务完成通知扩展
 *
 * Pi agent 真正停下来等待用户输入时（agent_settled），
 * 发送 Windows 系统 toast 通知；非 Windows 平台降级为 OSC 777 终端通知。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const template = `[${type}.ToastTemplateType]::ToastText02`;
	return [
		`[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$texts = $xml.GetElementsByTagName('text')`,
		`$texts.Item(0).AppendChild($xml.CreateTextNode('${title}')) > $null`,
		`$texts.Item(1).AppendChild($xml.CreateTextNode('${body}')) > $null`,
		// scenario=reminder 使通知持久显示，直到用户手动关闭；该场景要求至少一个按钮
		`$xml.DocumentElement.SetAttribute('scenario', 'reminder')`,
		`$actions = $xml.CreateElement('actions')`,
		`$action = $xml.CreateElement('action')`,
		`$action.SetAttribute('content', '关闭')`,
		`$action.SetAttribute('arguments', 'dismiss')`,
		`$action.SetAttribute('activationType', 'system')`,
		`$actions.AppendChild($action) > $null`,
		`$xml.DocumentElement.AppendChild($actions) > $null`,
		`$toast = [${type}.ToastNotification]::new($xml)`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('Pi Coding Agent').Show($toast)`,
	].join("; ");
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("node:child_process");
	execFile(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", windowsToastScript(title, body)],
		// windowsHide 使用 CREATE_NO_WINDOW，子进程获得独立的隐藏控制台，
		// 避免它把当前终端标题改成 "Windows PowerShell"
		{ windowsHide: true },
		() => {
			/* 通知失败时静默忽略 */
		},
	);
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function sanitize(text: string): string {
	// 避免单引号破坏 PowerShell 命令，并限制长度
	return text.replace(/'/g, "''").slice(0, 100);
}

function notify(title: string, body: string): void {
	if (process.platform === "win32" || process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		const project = ctx.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ctx.cwd;
		const session = pi.getSessionName();
		const title = session ? `Pi · ${project} · ${session}` : `Pi · ${project}`;
		notify(sanitize(title), "任务已完成，等待输入");
	});
}
