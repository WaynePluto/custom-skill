#!/usr/bin/env node

import { parseArgs, requiredString, stringOption, integerOption, booleanOption } from "./lib/cli.mjs";
import { launchLocalBrowser } from "./lib/browser.mjs";
import { readWebPage, searchBing } from "./lib/web.mjs";

let browser;
try {
  const args = parseArgs(process.argv.slice(2));
  const query = requiredString(args, "query");
  const maxResults = integerOption(args, "max-results", 8, { min: 1, max: 20 });
  const readCount = integerOption(args, "read", 3, { min: 0, max: 8 });
  const maxChars = integerOption(args, "max-chars", 8_000, { min: 1_000, max: 30_000 });
  const preference = stringOption(args, "browser", "auto");
  const browserPath = stringOption(args, "browser-path", undefined);
  const international = !booleanOption(args, "cn");

  const launched = await launchLocalBrowser({ preference, browserPath });
  browser = launched.browser;
  const context = await browser.newContext({ locale: "zh-CN" });
  const search = await searchBing(context, query, { maxResults, international });
  const pages = [];
  const visited = new Set();

  for (const result of search.results) {
    if (pages.length >= readCount) break;
    if (visited.has(result.url)) continue;
    visited.add(result.url);

    try {
      const page = await readWebPage(context, result.url, { maxChars });
      pages.push({ searchResult: result, page });
    } catch (error) {
      pages.push({
        searchResult: result,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await context.close();
  console.log(JSON.stringify({
    searchedAt: new Date().toISOString(),
    browser: launched.selection,
    query,
    searchUrl: search.searchUrl,
    results: search.results,
    pages,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
