// 连接本机 :9222 CDP 端口的公共辅助函数（playwright-core）
import { chromium } from "playwright-core";

export const DEBUG_PORT = 9222;
export const BROWSER_URL = `http://localhost:${DEBUG_PORT}`;

/** 检测 :9222 是否已有可用浏览器。 */
export async function isBrowserRunning() {
  try {
    const res = await fetch(`${BROWSER_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 连接已启动的浏览器；失败时打印提示并退出。 */
export async function connectBrowser({ timeoutMs = 5000 } = {}) {
  try {
    return await chromium.connectOverCDP(BROWSER_URL, { timeout: timeoutMs });
  } catch (e) {
    console.error("错误：无法连接浏览器:", e instanceof Error ? e.message.split("\n")[0] : String(e));
    console.error("请先运行: node <技能目录>/scripts/browser-start.mjs");
    process.exit(1);
  }
}

/** 获取当前活动标签页（最后一个 page）；不存在时退出。 */
export function getActivePage(browser) {
  const context = browser.contexts()[0];
  const page = context?.pages().at(-1);
  if (!page) {
    console.error("错误：没有活动标签页");
    process.exit(1);
  }
  return page;
}

/** 通用结果打印：对象/数组按 key: value 展开，其余直接输出。 */
export function printResult(result) {
  if (Array.isArray(result)) {
    result.forEach((item, i) => {
      if (i > 0) console.log("");
      if (typeof item === "object" && item !== null) {
        for (const [key, value] of Object.entries(item)) console.log(`${key}: ${value}`);
      } else {
        console.log(item);
      }
    });
  } else if (typeof result === "object" && result !== null) {
    for (const [key, value] of Object.entries(result)) console.log(`${key}: ${value}`);
  } else {
    console.log(result);
  }
}
