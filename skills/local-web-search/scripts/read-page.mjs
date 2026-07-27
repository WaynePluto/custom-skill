#!/usr/bin/env node

import { parseArgs, requiredString, stringOption, integerOption } from "./lib/cli.mjs";
import { launchLocalBrowser } from "./lib/browser.mjs";
import { readWebPage } from "./lib/web.mjs";

let browser;
try {
  const args = parseArgs(process.argv.slice(2));
  const url = requiredString(args, "url");
  const maxChars = integerOption(args, "max-chars", 20_000, { min: 1_000, max: 100_000 });
  const preference = stringOption(args, "browser", "auto");
  const browserPath = stringOption(args, "browser-path", undefined);

  const launched = await launchLocalBrowser({ preference, browserPath });
  browser = launched.browser;
  const context = await browser.newContext({ locale: "zh-CN" });
  const result = await readWebPage(context, url, { maxChars });
  await context.close();

  console.log(JSON.stringify({
    readAt: new Date().toISOString(),
    browser: launched.selection,
    ...result,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
