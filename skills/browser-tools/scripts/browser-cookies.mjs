#!/usr/bin/env node
// 显示当前标签页的 Cookie（调试会话/认证问题）。

import { connectBrowser, getActivePage } from "./lib/cdp.mjs";

const browser = await connectBrowser();
const page = getActivePage(browser);

const cookies = await page.context().cookies(page.url());
for (const cookie of cookies) {
  console.log(`${cookie.name}: ${cookie.value}`);
  console.log(`  domain: ${cookie.domain}`);
  console.log(`  path: ${cookie.path}`);
  console.log(`  httpOnly: ${cookie.httpOnly}`);
  console.log(`  secure: ${cookie.secure}`);
  console.log("");
}

await browser.close();
