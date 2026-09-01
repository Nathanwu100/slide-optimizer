import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/analyze.js";
import {
  emphasisRanges,
  missingRequiredRewriteTargets,
  requiredRewriteTargets,
  validateProposalResponse,
  validateSnapshot,
} from "../lib/proposals.js";

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const snapshot = {
  sourceHash: "abc",
  slides: [{ slide: 1, elements: [{
    objectId: "2",
    name: "Body",
    type: "text",
    text: "Original exact text.",
    paragraphs: [{ text: "Original exact text.", editable: true }],
  }] }],
};

test("missing OpenAI credentials returns a clear configuration error", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const response = mockResponse();
    await handler({ method: "POST", headers: { "x-lucid-request": "analysis-v1" }, body: { presentation: snapshot }, socket: { remoteAddress: "test-missing-key" } }, response);
    assert.equal(response.statusCode, 503);
    assert.match(response.payload.error, /OPENAI_API_KEY/);
    assert.deepEqual(response.payload.proposals, []);
  } finally {
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
  }
});

test("OpenAI structured output is validated before edits are returned", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-4.1";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-4.1");
    assert.equal(body.reasoning, undefined);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ proposals: [
          { slide: 1, objectId: "2", originalText: "Original exact text.", lines: [{ text: "Clearer text", emphasize: ["Clearer"] }], rule: 3, explanation: "Improves clarity." },
          { slide: 1, objectId: "99", originalText: "Invented source", lines: [{ text: "Invalid", emphasize: [] }], rule: 3, explanation: "Invalid." },
        ] }) }] }] };
      },
    };
  };

  try {
    const response = mockResponse();
    await handler({ method: "POST", headers: { "x-lucid-request": "analysis-v1" }, body: { presentation: snapshot }, socket: { remoteAddress: "test-openai-success" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.mode, "auto-simplify");
    assert.equal(response.payload.model, "gpt-4.1");
    assert.equal(response.payload.proposals.length, 1);
    assert.equal(response.payload.proposals[0].proposedText, "Clearer text");
    assert.deepEqual(response.payload.proposals[0].lines[0].boldRanges, [{ start: 0, end: 7, text: "Clearer" }]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
    else delete process.env.OPENAI_API_KEY;
    if (previousModel) process.env.OPENAI_MODEL = previousModel;
    else delete process.env.OPENAI_MODEL;
  }
});

test("cross-origin requests are rejected", async () => {
  const previousOrigin = process.env.ALLOWED_ORIGIN;
  delete process.env.ALLOWED_ORIGIN;
  try {
    const response = mockResponse();
    await handler({
      method: "POST",
      headers: { "x-lucid-request": "analysis-v1", origin: "https://untrusted.example", host: "slide-optimizer.vercel.app", "x-forwarded-proto": "https" },
      body: { presentation: snapshot },
      socket: { remoteAddress: "cross-origin-test" },
    }, response);
    assert.equal(response.statusCode, 403);
  } finally {
    if (previousOrigin) process.env.ALLOWED_ORIGIN = previousOrigin;
  }
});

test("snapshot validation strips unknown fields", () => {
  const validated = validateSnapshot({ ...snapshot, secret: "discard", slides: [{ ...snapshot.slides[0], extra: "discard" }] });
  assert.deepEqual(Object.keys(validated).sort(), ["slides", "sourceHash"]);
  assert.deepEqual(Object.keys(validated.slides[0]).sort(), ["elements", "slide"]);
});

test("server rejects proposals for invented elements or text", () => {
  const proposals = validateProposalResponse(validateSnapshot(snapshot), { proposals: [
    { slide: 1, objectId: "2", originalText: "Original exact text.", lines: [{ text: "Clearer text", emphasize: [] }], rule: 3, explanation: "Meaning-based rewrite." },
    { slide: 1, objectId: "2", originalText: "Invented source", lines: [{ text: "Invalid", emphasize: [] }], rule: 3, explanation: "Invalid." },
    { slide: 1, objectId: "99", originalText: "Original exact text.", lines: [{ text: "Invalid", emphasize: [] }], rule: 3, explanation: "Invalid." },
  ] });
  assert.equal(proposals.length, 1);
});

test("exact semantic emphasis phrases become validated character ranges", () => {
  const text = "The retina processes visual information before sending signals to the brain.";
  assert.deepEqual(emphasisRanges(text, ["visual information", "the brain"]), [
    { start: 21, end: 39, text: "visual information" },
    { start: 66, end: 75, text: "the brain" },
  ]);
});

test("dense paragraphs omitted by the first model response are retried and recovered", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-4.1";
  const denseSnapshot = {
    sourceHash: "coverage",
    slides: [{ slide: 14, elements: [{
      objectId: "9",
      name: "Body",
      type: "text",
      text: "First dense paragraph contains more than ten words and needs a concise rewrite.\nSecond dense paragraph also contains enough words that it must not disappear.",
      paragraphs: [
        { text: "First dense paragraph contains more than ten words and needs a concise rewrite.", editable: true },
        { text: "Second dense paragraph also contains enough words that it must not disappear.", editable: true },
      ],
    }] }],
  };
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    const retry = body.input.includes("COVERAGE RETRY");
    if (retry) {
      assert.doesNotMatch(body.input, /First dense paragraph/);
      assert.match(body.input, /Second dense paragraph/);
    }
    const proposals = retry ? [{
      slide: 14,
      objectId: "9",
      originalText: "Second dense paragraph also contains enough words that it must not disappear.",
      lines: [{ text: "Second dense point must remain", emphasize: ["must remain"] }],
      rule: 3,
      explanation: "Completes dense-line coverage.",
    }] : [{
      slide: 14,
      objectId: "9",
      originalText: "First dense paragraph contains more than ten words and needs a concise rewrite.",
      lines: [{ text: "First dense point, rewritten concisely", emphasize: ["dense point"] }],
      rule: 3,
      explanation: "Shortens the first dense line.",
    }];
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ proposals }) }] }] };
      },
    };
  };

  try {
    const response = mockResponse();
    await handler({ method: "POST", headers: { "x-lucid-request": "analysis-v1" }, body: { presentation: denseSnapshot }, socket: { remoteAddress: "coverage-retry-test" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(calls, 2);
    assert.equal(response.payload.proposals.length, 2);
    assert.deepEqual(response.payload.coverage, { required: 2, satisfied: 2 });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
    else delete process.env.OPENAI_API_KEY;
    if (previousModel) process.env.OPENAI_MODEL = previousModel;
    else delete process.env.OPENAI_MODEL;
  }
});

test("coverage failure blocks a partial conversion after focused retries", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-4.1";
  const denseSnapshot = {
    sourceHash: "coverage-failure",
    slides: [{ slide: 9, elements: [{
      objectId: "4",
      name: "Body",
      type: "text",
      text: "This dense paragraph is intentionally omitted by every mocked analysis response.",
      paragraphs: [{ text: "This dense paragraph is intentionally omitted by every mocked analysis response.", editable: true }],
    }] }],
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ proposals: [] }) }] }] };
      },
    };
  };

  try {
    const response = mockResponse();
    await handler({ method: "POST", headers: { "x-lucid-request": "analysis-v1" }, body: { presentation: denseSnapshot }, socket: { remoteAddress: "coverage-failure-test" } }, response);
    assert.equal(response.statusCode, 502);
    assert.equal(calls, 3);
    assert.match(response.payload.error, /stopped a partial conversion/);
    assert.deepEqual(response.payload.proposals, []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
    else delete process.env.OPENAI_API_KEY;
    if (previousModel) process.env.OPENAI_MODEL = previousModel;
    else delete process.env.OPENAI_MODEL;
  }
});

test("dense-target helpers identify and clear omitted coverage", () => {
  const denseSnapshot = validateSnapshot({
    sourceHash: "helpers",
    slides: [{ slide: 1, elements: [{
      objectId: "2",
      name: "Body",
      type: "text",
      text: "A dense paragraph with more than ten words must receive a validated rewrite.",
      paragraphs: [{ text: "A dense paragraph with more than ten words must receive a validated rewrite.", editable: true }],
    }] }],
  });
  const targets = requiredRewriteTargets(denseSnapshot);
  assert.equal(targets.length, 1);
  assert.equal(missingRequiredRewriteTargets(denseSnapshot, []).length, 1);
  assert.equal(missingRequiredRewriteTargets(denseSnapshot, [{
    slide: 1,
    objectId: "2",
    originalText: targets[0].originalText,
  }]).length, 0);
});
