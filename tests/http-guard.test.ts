import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertLocalRequest, readJson } from "@/server/http";

function request(method: string, headers: Record<string, string>, url = "http://localhost:3000/api/projects", body?: string): Request {
  return new Request(url, { method, headers, ...(body !== undefined ? { body } : {}) });
}

function status(run: () => void): number | "ok" {
  try {
    run();
    return "ok";
  } catch (error) {
    if (error instanceof Response) return error.status;
    throw error;
  }
}

describe("local request guard", () => {
  test("same-origin requests from the app pass, on localhost, 127.0.0.1 and ::1 with any port", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "localhost:4010", "[::1]:3000"]) {
      assert.equal(status(() => assertLocalRequest(request("POST", { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" }, `http://${host}/api/projects`))), "ok", host);
    }
    assert.equal(status(() => assertLocalRequest(request("POST", { host: "localhost:3000" }))), "ok", "a local non-browser client sends neither header");
  });

  test("a foreign Host (DNS rebinding, a LAN name) is refused", () => {
    assert.equal(status(() => assertLocalRequest(request("GET", { host: "attacker.example:3000" }, "http://attacker.example:3000/api/projects"))), 403);
    assert.equal(status(() => assertLocalRequest(request("GET", { host: "192.168.1.20:3000" }, "http://192.168.1.20:3000/"))), 403);
    assert.equal(status(() => assertLocalRequest(request("GET", { host: "attacker.example:3000" }))), 403, "the Host header alone fails it");
    assert.equal(status(() => assertLocalRequest(request("GET", { host: "not a host" }))), 403);
  });

  test("cross-origin writes are refused: another origin, a null origin, another localhost port, a multipart post from a page", () => {
    assert.equal(status(() => assertLocalRequest(request("POST", { host: "localhost:3000", origin: "https://evil.example", "sec-fetch-site": "cross-site" }))), 403);
    assert.equal(status(() => assertLocalRequest(request("POST", { host: "localhost:3000", origin: "null" }))), 403);
    assert.equal(status(() => assertLocalRequest(request("POST", { host: "localhost:3000", origin: "http://localhost:5173", "sec-fetch-site": "same-site" }))), 403);
    assert.equal(
      status(() => assertLocalRequest(request("POST", { host: "localhost:3000", origin: "https://evil.example", "content-type": "multipart/form-data; boundary=x" }, undefined, "x"))),
      403,
    );
    assert.equal(status(() => assertLocalRequest(request("GET", { host: "localhost:3000", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }))), 403, "an image load from another site");
  });

  test("a link to the app from another site opens (top-level navigation), but nothing else cross-site does", () => {
    const navigate = { host: "localhost:3000", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    assert.equal(status(() => assertLocalRequest(request("GET", navigate, "http://localhost:3000/projects"))), "ok");
    assert.equal(status(() => assertLocalRequest(request("POST", { ...navigate, origin: "https://evil.example" }))), 403, "a form post is a navigation too, and still refused");
    assert.equal(status(() => assertLocalRequest(request("GET", { ...navigate, "sec-fetch-dest": "iframe" }))), 403, "framing the app is refused");
  });

  test("readJson wants JSON, refuses an oversized declared body before reading it, and parses the rest", async () => {
    const headers = { host: "localhost:3000", "content-type": "application/json" };
    const parsed = await readJson(request("POST", headers, undefined, JSON.stringify({ name: "x" })));
    assert.deepEqual(parsed, { name: "x" });
    await assert.rejects(readJson(request("POST", { host: "localhost:3000", "content-type": "text/plain" }, undefined, "{}")), (error: unknown) => error instanceof Response && error.status === 415);
    await assert.rejects(readJson(request("POST", { ...headers, "content-length": "99999999" }, undefined, "{}")), (error: unknown) => error instanceof Response && error.status === 413);
    await assert.rejects(readJson(request("POST", headers, undefined, "x".repeat(20_000)), 16_384), (error: unknown) => error instanceof Response && error.status === 413);
    await assert.rejects(readJson(request("POST", headers, undefined, "{nope")), (error: unknown) => error instanceof Response && error.status === 400);
  });
});
