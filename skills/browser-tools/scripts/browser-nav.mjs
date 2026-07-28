#!/usr/bin/env node
// 在当前或新标签页中导航到指定 URL。

import { connectBrowser, getActivePage } from "./lib/cdp.mjs";

const args = process.argv.slice(2);
const newTab = args.includes("--new");
const reload = args.includes("--reload");
const url = args.find(a => !a.startsWith("--"));

if (!url) {
  console.log("用法: browser-nav.js <url> [--new] [--reload]");
  process.exit(1);
}

const browser = await connectBrowser();

if (newTab) {
  const page = await browser.contexts()[0].newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log("已在新标签页打开:", url);
} else {
  const page = getActivePage(browser);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (reload) await page.reload({ waitUntil: "domcontentloaded" });
  console.log("已导航到:", url);
}

await browser.close();
