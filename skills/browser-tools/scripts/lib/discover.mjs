// 本机 Chrome/Edge 可执行文件自动发现（Chrome 优先，Edge 降级）
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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
      // 缺少注册表键属于正常情况
    }
  }
  return found;
}

export function discoverBrowserPaths(env = process.env) {
  if (process.platform === "win32") {
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

  if (process.platform === "darwin") {
    return {
      chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(existsSync),
      edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].filter(existsSync),
    };
  }

  return {
    chrome: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
    ].filter(existsSync),
    edge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"].filter(existsSync),
  };
}

/** 返回首选浏览器可执行文件路径；找不到时返回 null。 */
export function resolveBrowserExecutable({ browserPath, env = process.env } = {}) {
  if (browserPath) {
    const resolved = path.resolve(browserPath);
    if (!existsSync(resolved)) {
      throw new Error(`--browser-path 指定的文件不存在：${resolved}`);
    }
    return resolved;
  }
  const found = discoverBrowserPaths(env);
  return found.chrome[0] || found.edge[0] || null;
}
