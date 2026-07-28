#!/usr/bin/env node
// 在当前活动标签页执行 JavaScript（异步上下文）。

import { connectBrowser, getActivePage, printResult } from "./lib/cdp.mjs";

const code = process.argv.slice(2).join(" ");
if (!code) {
  console.log("用法: browser-eval.js 'code'");
  console.log("示例: browser-eval.js \"document.title\"");
  process.exit(1);
}

const MAX_OUTPUT = 50 * 1024;

const browser = await connectBrowser();
const page = getActivePage(browser);

const result = await page.evaluate(c => {
  const AsyncFunction = (async () => {}).constructor;
  return new AsyncFunction(`return (${c})`)();
}, code);

// 限制输出体积
const origLog = console.log;
let written = 0;
console.log = (...a) => {
  const text = a.join(" ");
  if (written >= MAX_OUTPUT) return;
  written += text.length;
  origLog(written >= MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n...(输出已截断)" : text);
};
printResult(result);
console.log = origLog;

await browser.close();
