import assert from "node:assert/strict";
import test from "node:test";

import { assertWebUrl } from "../scripts/lib/web.mjs";

test("assertWebUrl accepts HTTP and HTTPS", () => {
  assert.equal(assertWebUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(assertWebUrl("http://example.com"), "http://example.com/");
});

test("assertWebUrl rejects non-web schemes and malformed input", () => {
  assert.throws(() => assertWebUrl("file:///etc/passwd"), /http\/https/);
  assert.throws(() => assertWebUrl("not a url"), /URL 无效/);
});
