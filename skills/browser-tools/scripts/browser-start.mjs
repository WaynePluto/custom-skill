#!/usr/bin/env node
// 启动本机 Chrome/Edge，开启 :9222 远程调试，使用独立临时 Profile。

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrowserExecutable } from "./lib/discover.mjs";
import { BROWSER_URL, DEBUG_PORT, isBrowserRunning } from "./lib/cdp.mjs";

const args = process.argv.slice(2);
let browserPath;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--browser-path") {
    browserPath = args[++i];
  } else {
    console.log("用法: browser-start.js [--browser-path <浏览器可执行文件>]");
    console.log("\n启动 Chrome/Edge（自动发现，Chrome 优先），远程调试端口 :9222，独立临时 Profile。");
    process.exit(args[i] === "--help" || args[i] === "-h" ? 0 : 1);
  }
}

if (await isBrowserRunning()) {
  console.log(`浏览器已在 ${BROWSER_URL} 运行`);
  process.exit(0);
}

const executable = resolveBrowserExecutable({ browserPath });
if (!executable) {
  console.error("错误：未找到 Chrome 或 Edge。请安装浏览器，或使用 --browser-path 指定路径。");
  process.exit(1);
}

const profileDir = path.join(os.tmpdir(), "browser-tools-profile");
mkdirSync(profileDir, { recursive: true });
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  rmSync(path.join(profileDir, f), { force: true });
}

spawn(
  executable,
  [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
  { detached: true, stdio: "ignore" },
).unref();

let connected = false;
for (let i = 0; i < 30; i++) {
  if (await isBrowserRunning()) {
    connected = true;
    break;
  }
  await new Promise(r => setTimeout(r, 500));
}

if (!connected) {
  console.error("错误：浏览器启动后无法连接 :9222");
  process.exit(1);
}

console.log(`浏览器已启动：${executable}（端口 :${DEBUG_PORT}，临时 Profile：${profileDir}）`);
