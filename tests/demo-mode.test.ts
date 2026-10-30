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

test("judging mode needs a 12 character password and is off when read-only is on", async () => {
  const { isJudging, judgePassword, hostedMode, authorized } = await import("@/server/demo");
  assert.equal(judgePassword({ STUDIO_JUDGE_PASSWORD: "short" }), undefined);
  assert.equal(isJudging({ STUDIO_JUDGE_PASSWORD: "correct-horse-battery" }), true);
  assert.equal(hostedMode({ STUDIO_JUDGE_PASSWORD: "correct-horse-battery", STUDIO_READ_ONLY: "1" }), "read-only");
  assert.equal(hostedMode({}), null);
  assert.equal(publicHost({ STUDIO_JUDGE_PASSWORD: "correct-horse-battery", STUDIO_PUBLIC_HOST: "Judge.Example.com" }), "judge.example.com");
  const header = "Basic " + Buffer.from("judge:correct-horse-battery").toString("base64");
  assert.equal(authorized(header, "correct-horse-battery"), true);
  assert.equal(authorized("Basic " + Buffer.from("judge:wrong-password-here").toString("base64"), "correct-horse-battery"), false);
  assert.equal(authorized(null, "correct-horse-battery"), false);
  assert.equal(authorized("Bearer x", "correct-horse-battery"), false);
});
