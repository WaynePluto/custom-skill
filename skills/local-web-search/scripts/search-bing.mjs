#!/usr/bin/env node

import { parseArgs, requiredString, stringOption, integerOption, booleanOption } from "./lib/cli.mjs";
import { launchLocalBrowser } from "./lib/browser.mjs";
import { searchBing } from "./lib/web.mjs";

let browser;
try {
  const args = parseArgs(process.argv.slice(2));
  const query = requiredString(args, "query");
  const maxResults = integerOption(args, "max-results", 8, { min: 1, max: 20 });
  const preference = stringOption(args, "browser", "auto");
  const browserPath = stringOption(args, "browser-path", undefined);
  const international = !booleanOption(args, "cn");

  const launched = await launchLocalBrowser({ preference, browserPath });
  browser = launched.browser;
  const context = await browser.newContext({ locale: "zh-CN" });
  const result = await searchBing(context, query, { maxResults, international });
  await context.close();

  console.log(JSON.stringify({
    searchedAt: new Date().toISOString(),
    browser: launched.selection,
    ...result,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
