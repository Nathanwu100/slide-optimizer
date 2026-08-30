import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/usage.js";

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function request(method, body = {}, headers = {}) {
  return {
    method,
    body,
    headers,
    socket: { remoteAddress: `usage-test-${Math.random()}` },
  };
}

test("successful conversions increment persistent aggregate counters", async () => {
  const previousFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (String(url).endsWith("/pipeline")) {
      return { ok: true, async json() { return calls.at(-1).body.map(() => ({ result: 1 })); } };
    }
    return { ok: true, async json() { return { result: "OK" }; } };
  };
  try {
    const response = mockResponse();
    await handler(request("POST", {
      eventId: "event_1234567890123456",
      anonymousId: "browser_1234567890123456",
      slidesProcessed: 22,
      slidesChanged: 3,
      changesApplied: 9,
    }, { "x-lucid-request": "usage-v1" }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.recorded, true);
    assert.deepEqual(calls[0].body.slice(0, 3), ["SET", "lucid:usage:event:event_1234567890123456", "1"]);
    assert.deepEqual(calls[1].body.slice(0, 5), [
      ["INCR", "lucid:usage:presentations"],
      ["INCRBY", "lucid:usage:slides_processed", 22],
      ["INCRBY", "lucid:usage:slides_changed", 3],
      ["INCRBY", "lucid:usage:changes_applied", 9],
      ["PFADD", "lucid:usage:unique_devices", "browser_1234567890123456"],
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test("duplicate conversion event IDs are not counted twice", async () => {
  const previousFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, async json() { return { result: null }; } };
  };
  try {
    const response = mockResponse();
    await handler(request("POST", {
      eventId: "event_abcdefghijklmnop",
      anonymousId: "browser_abcdefghijklmnop",
      slidesProcessed: 10,
      slidesChanged: 2,
      changesApplied: 2,
    }, { "x-lucid-request": "usage-v1" }), response);
    assert.equal(response.payload.duplicate, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test("the owner dashboard requires its token and returns aggregate statistics", async () => {
  const previousFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  process.env.USAGE_ADMIN_TOKEN = "dashboard-secret";
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return ["4", "88", "12", "31", "3", "2026-08-30T12:00:00.000Z", "1", "22", "3"]
        .map((result) => ({ result }));
    },
  });
  try {
    const rejected = mockResponse();
    await handler(request("GET"), rejected);
    assert.equal(rejected.statusCode, 401);

    const response = mockResponse();
    await handler(request("GET", {}, { "x-usage-admin-token": "dashboard-secret" }), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.totals, {
      presentationsConverted: 4,
      slidesProcessed: 88,
      slidesChanged: 12,
      changesApplied: 31,
      approximateUniqueDevices: 3,
    });
    assert.equal(response.payload.today.presentationsConverted, 1);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.USAGE_ADMIN_TOKEN;
  }
});

test("tracking is non-blocking before storage is configured", async () => {
  const response = mockResponse();
  await handler(request("POST", {
    eventId: "event_notconfigured_123",
    anonymousId: "browser_notconfigured_123",
    slidesProcessed: 5,
    slidesChanged: 1,
    changesApplied: 1,
  }, { "x-lucid-request": "usage-v1" }), response);
  assert.equal(response.statusCode, 202);
  assert.equal(response.payload.recorded, false);
  assert.equal(response.payload.reason, "not-configured");
});
