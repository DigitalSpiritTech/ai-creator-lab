import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_ONLY_METHODS, isReadOnly, publicHost } from "@/server/demo";

test("read-only mode is exactly STUDIO_READ_ONLY=1", () => {
  assert.equal(isReadOnly({}), false);
  assert.equal(isReadOnly({ STUDIO_READ_ONLY: "true" }), false);
  assert.equal(isReadOnly({ STUDIO_READ_ONLY: "1" }), true);
});

test("the public host is lowercased and ignored outside read-only mode", () => {
  assert.equal(publicHost({ STUDIO_PUBLIC_HOST: "Demo.Example.com" }), undefined);
  assert.equal(publicHost({ STUDIO_READ_ONLY: "1", STUDIO_PUBLIC_HOST: " Demo.Example.com " }), "demo.example.com");
  assert.equal(publicHost({ STUDIO_READ_ONLY: "1" }), undefined);
});

test("only reads pass in read-only mode", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) assert.ok(READ_ONLY_METHODS.has(method));
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.ok(!READ_ONLY_METHODS.has(method));
});
