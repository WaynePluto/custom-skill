import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const VALID_PREFERENCES = new Set(["auto", "chrome", "edge"]);

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter(candidate => {
    if (!candidate) return false;
    const key = path.normalize(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function queryWindowsAppPath(executable) {
  if (process.platform !== "win32") return [];

  const keys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`,
  ];
  const found = [];

  for (const key of keys) {
    try {
      const output = execFileSync("reg.exe", ["query", key, "/ve"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = output.match(/REG_SZ\s+(.+\.exe)\s*$/im);
      if (match?.[1]) found.push(match[1].trim());
    } catch {
      // Missing registry keys are expected.
    }
  }

  return found;
}

export function discoverWindowsBrowserPaths(env = process.env) {
  if (process.platform !== "win32") return { chrome: [], edge: [] };

  const chrome = [
    ...queryWindowsAppPath("chrome.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env["ProgramFiles(x86)"] &&
      path.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ];

  const edge = [
    ...queryWindowsAppPath("msedge.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    env["ProgramFiles(x86)"] &&
      path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];

  return {
    chrome: uniquePaths(chrome).filter(existsSync),
    edge: uniquePaths(edge).filter(existsSync),
  };
}

function discoverNonWindowsBrowserPaths() {
  if (process.platform === "darwin") {
    return {
      chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(existsSync),
      edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].filter(existsSync),
    };
  }

  if (process.platform === "linux") {
    return {
      chrome: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
      ].filter(existsSync),
      edge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"].filter(existsSync),
    };
  }

  return { chrome: [], edge: [] };
}

export function buildBrowserAttempts({ preference = "auto", browserPath, env = process.env } = {}) {
  if (!VALID_PREFERENCES.has(preference)) {
    throw new Error(`浏览器偏好无效：${preference}。可选值：auto、chrome、edge`);
  }

  const explicitPath = browserPath || undefined;
  const attempts = [];

  if (explicitPath) {
    attempts.push({
      label: `显式路径 (${explicitPath})`,
      options: { executablePath: path.resolve(explicitPath) },
    });
  }

  const order = preference === "edge" ? ["edge", "chrome"] : ["chrome", "edge"];
  const discovered =
    process.platform === "win32" ? discoverWindowsBrowserPaths(env) : discoverNonWindowsBrowserPaths();

  for (const browser of order) {
    attempts.push({
      label: browser === "chrome" ? "Playwright Chrome channel" : "Playwright Edge channel",
      options: { channel: browser === "chrome" ? "chrome" : "msedge" },
    });
    for (const executablePath of discovered[browser]) {
      if (explicitPath && path.resolve(explicitPath).toLowerCase() === executablePath.toLowerCase()) continue;
      attempts.push({
        label: `${browser === "chrome" ? "Chrome" : "Edge"} (${executablePath})`,
        options: { executablePath },
      });
    }
  }

  return attempts;
}

export async function launchLocalBrowser({
  preference = "auto",
  browserPath,
  headless = true,
} = {}) {
  const attempts = buildBrowserAttempts({ preference, browserPath });
  const failures = [];

  for (const attempt of attempts) {
    if (attempt.options.executablePath && !existsSync(attempt.options.executablePath)) {
      failures.push(`${attempt.label}: 文件不存在`);
      continue;
    }

    try {
      const browser = await chromium.launch({
        ...attempt.options,
        headless,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      return { browser, selection: attempt.label };
    } catch (error) {
      failures.push(`${attempt.label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }

  const platformHint =
    process.platform === "win32"
      ? "请安装 Chrome 或 Edge，或通过 --browser-path 指定浏览器可执行文件。"
      : `请安装 Chrome 或 Edge，或通过 --browser-path 指定浏览器可执行文件。当前平台：${os.platform()}`;
  throw new Error(`无法启动本地浏览器。${platformHint}\n尝试记录：\n- ${failures.join("\n- ")}`);
}
