import assert from "node:assert/strict";
import test from "node:test";

import {
  booleanOption,
  integerOption,
  parseArgs,
  requiredString,
  stringOption,
} from "../scripts/lib/cli.mjs";

test("parseArgs parses values, flags and positional arguments", () => {
  const args = parseArgs([
    "extra",
    "--query",
    "node latest",
    "--max-results=5",
    "--international",
  ]);

  assert.equal(args.query, "node latest");
  assert.equal(args["max-results"], "5");
  assert.equal(args.international, true);
  assert.deepEqual(args._, ["extra"]);
});

test("option helpers validate values", () => {
  const args = parseArgs(["--query", "test", "--read", "3", "--browser", "edge"]);
  assert.equal(requiredString(args, "query"), "test");
  assert.equal(integerOption(args, "read", 1, { min: 0, max: 8 }), 3);
  assert.equal(stringOption(args, "browser", "auto"), "edge");
  assert.equal(booleanOption(args, "international"), false);

  assert.throws(
    () => integerOption({ read: "20" }, "read", 1, { min: 0, max: 8 }),
    /0-8/,
  );
  assert.throws(() => requiredString({}, "query"), /--query/);
});
