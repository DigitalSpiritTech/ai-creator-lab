import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("package manifest declares the Node floor and the four quality scripts", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, ">=22.13.0");
  for (const script of ["typecheck", "lint", "test", "build"]) assert.ok(pkg.scripts[script], script);
});
