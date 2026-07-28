#!/usr/bin/env node
// 截取当前视口并输出临时文件路径。

import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectBrowser, getActivePage } from "./lib/cdp.mjs";

const browser = await connectBrowser();
const page = getActivePage(browser);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filepath = join(tmpdir(), `screenshot-${timestamp}.png`);
await page.screenshot({ path: filepath });
console.log(filepath);

await browser.close();
