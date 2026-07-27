#!/usr/bin/env node

import { parseArgs, stringOption } from "./lib/cli.mjs";
import { launchLocalBrowser } from "./lib/browser.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const preference = stringOption(args, "browser", "auto");
  const browserPath = stringOption(args, "browser-path", undefined);
  const { browser, selection } = await launchLocalBrowser({ preference, browserPath });
  const version = browser.version();
  await browser.close();
  console.log(JSON.stringify({ ok: true, selection, version }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
