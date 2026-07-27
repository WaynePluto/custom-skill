import assert from "node:assert/strict";
import test from "node:test";

import { buildBrowserAttempts, discoverWindowsBrowserPaths } from "../scripts/lib/browser.mjs";

test("default browser order prefers Chrome and falls back to Edge", () => {
  const attempts = buildBrowserAttempts({ preference: "auto", env: {} });
  const chromeIndex = attempts.findIndex(attempt => attempt.options.channel === "chrome");
  const edgeIndex = attempts.findIndex(attempt => attempt.options.channel === "msedge");

  assert.notEqual(chromeIndex, -1);
  assert.notEqual(edgeIndex, -1);
  assert.ok(chromeIndex < edgeIndex);
});

test("edge preference reverses branded browser channel order", () => {
  const attempts = buildBrowserAttempts({ preference: "edge", env: {} });
  const channels = attempts
    .filter(attempt => attempt.options.channel)
    .map(attempt => attempt.options.channel);

  assert.deepEqual(channels.slice(0, 2), ["msedge", "chrome"]);
});

test("explicit browser path has highest priority", () => {
  const explicit = "C:\\portable\\browser.exe";
  const attempts = buildBrowserAttempts({ browserPath: explicit, env: {} });

  assert.equal(attempts[0].options.executablePath.toLowerCase(), explicit.toLowerCase());
});

test("Windows discovery returns existing Chrome and Edge paths when available", { skip: process.platform !== "win32" }, () => {
  const discovered = discoverWindowsBrowserPaths();
  assert.ok(discovered.chrome.length + discovered.edge.length > 0);
});
