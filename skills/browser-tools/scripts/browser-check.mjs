#!/usr/bin/env node
// 诊断脚本：检查浏览器发现与 :9222 连接状态。

import { discoverBrowserPaths } from "./lib/discover.mjs";
import { BROWSER_URL, isBrowserRunning } from "./lib/cdp.mjs";

const found = discoverBrowserPaths();
console.log("Chrome:", found.chrome.length ? found.chrome.join("; ") : "(未找到)");
console.log("Edge:", found.edge.length ? found.edge.join("; ") : "(未找到)");
console.log(`CDP (${BROWSER_URL}):`, (await isBrowserRunning()) ? "已运行" : "未运行");
